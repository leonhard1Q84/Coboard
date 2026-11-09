//! Replay through the same per-window recognizer as desktop IPC. No network or
//! target-conditioned filtering. Times cover Rust work, not IPC or presentation.
use coboard_vision_ml::{
    HandwritingEngine,
    incremental::{DecodeError, IncrementalDecoder, Stroke},
    recognition::{HandwritingRecognizer, IncrementalRequest, InkStroke},
};
use serde::Deserialize;
use serde_json::json;
use std::{error::Error, fs, time::Instant};

#[derive(Deserialize)]
struct Sample {
    name: String,
    expected: Option<String>,
    strokes: Vec<Stroke>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: connected_probe SAMPLES_JSON [HOT_TRIALS=10]")?;
    let trials: usize = std::env::args().nth(2).map_or(Ok(10), |s| s.parse())?;
    if !(1..=100).contains(&trials) {
        return Err("HOT_TRIALS must be 1..=100".into());
    }
    let samples: Vec<Sample> = serde_json::from_slice(&fs::read(path)?)?;
    let engine = HandwritingEngine::load_default()?;
    let mut recognizer = HandwritingRecognizer::default();
    // Load the deployed recognizer independently of fixture labels. Lexicon
    // first-use remains in trial zero, which is retained in the raw output.
    let warm = IncrementalRequest {
        session_id: "warm".into(),
        sequence: 1,
        from: 0,
        strokes: vec![InkStroke {
            id: "warm-ink".into(),
            points: vec![[0.0, 0.0], [0.0, 60.0]],
        }],
    };
    let load = Instant::now();
    recognizer.recognize("probe", &warm)?;
    println!(
        "{}",
        json!({"kind":"prepare", "elapsed_ms":load.elapsed().as_secs_f64()*1000.0, "scope":"local model preparation plus fixed vertical; filesystem cache uncontrolled"})
    );
    for (index, sample) in samples.iter().enumerate() {
        let baseline = IncrementalDecoder::default().update_with_context(
            &sample.strokes,
            |s| {
                engine
                    .recognize_incremental_glyph(s)
                    .map_err(|e| DecodeError::Classifier(e.to_string()))
            },
            |p, n| engine.incremental_context_score(p, n),
        )?;
        println!(
            "{}",
            json!({"kind":"baseline", "sample":sample.name, "expected":sample.expected, "output":baseline})
        );
        for trial in 0..=trials {
            for (stroke_index, points) in sample.strokes.iter().enumerate() {
                let request = IncrementalRequest {
                    session_id: format!("replay-{index}-{trial}"),
                    sequence: stroke_index as u64 + 1,
                    from: stroke_index,
                    strokes: vec![InkStroke {
                        id: format!("ink-{stroke_index}"),
                        points: points.clone(),
                    }],
                };
                let started = Instant::now();
                let response = recognizer.recognize("probe", &request)?;
                let wall_ms = started.elapsed().as_secs_f64() * 1000.0;
                let retry_started = Instant::now();
                let retry = recognizer.recognize("probe", &request)?;
                let retry_ms = retry_started.elapsed().as_secs_f64() * 1000.0;
                if serde_json::to_value(&response)? != serde_json::to_value(retry)? {
                    return Err("non-idempotent response".into());
                }
                println!(
                    "{}",
                    json!({"kind":"recognize", "sample":sample.name, "expected":sample.expected, "trial":trial, "end":stroke_index+1,
                    "final":stroke_index+1==sample.strokes.len(), "wall_ms":wall_ms, "retry_ms":retry_ms, "response":response})
                );
            }
        }
    }
    Ok(())
}
