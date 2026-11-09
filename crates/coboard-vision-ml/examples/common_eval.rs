//! Offline evaluation through the deployed desktop recognizer, without labels
//! conditioning inference. Each sample has a fresh session; failures are retained.
use coboard_vision_ml::incremental::Stroke;
use coboard_vision_ml::recognition::{HandwritingRecognizer, IncrementalRequest, InkStroke};
use serde::Deserialize;
use serde_json::json;
use std::{error::Error, fs, time::Instant};

#[derive(Deserialize)]
struct Sample {
    name: String,
    strokes: Vec<Stroke>,
    #[serde(default)]
    incremental: bool,
}

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: common_eval SAMPLES_JSON")?;
    let samples: Vec<Sample> = serde_json::from_slice(&fs::read(path)?)?;
    let mut recognizer = HandwritingRecognizer::default();
    let warm = IncrementalRequest {
        session_id: "warm".into(),
        sequence: 1,
        from: 0,
        strokes: vec![InkStroke {
            id: "warm-ink".into(),
            points: vec![[0.0, 0.0], [0.0, 60.0]],
        }],
    };
    let prepare = Instant::now();
    recognizer.recognize("eval", &warm)?;
    println!(
        "{}",
        json!({"kind":"prepare", "elapsed_ms":prepare.elapsed().as_secs_f64()*1000.0,
        "scope":"desktop Rust recognizer; fixed warm-up; CPU compute, no IPC/UI; filesystem cache uncontrolled"})
    );
    for (i, sample) in samples.into_iter().enumerate() {
        let strokes: Vec<_> = sample
            .strokes
            .into_iter()
            .enumerate()
            .map(|(j, points)| InkStroke {
                id: format!("ink-{j}"),
                points,
            })
            .collect();
        if strokes.is_empty() {
            return Err(format!("empty sample {}", sample.name).into());
        }
        let steps = if sample.incremental { strokes.len() } else { 1 };
        let mut total_ms = 0.0;
        for step in 0..steps {
            let end = if sample.incremental {
                step + 1
            } else {
                strokes.len()
            };
            let request = IncrementalRequest {
                session_id: format!("sample-{i}"),
                sequence: step as u64 + 1,
                from: if sample.incremental { step } else { 0 },
                strokes: if sample.incremental {
                    vec![strokes[step].clone()]
                } else {
                    strokes.clone()
                },
            };
            let start = Instant::now();
            let result = recognizer.recognize("eval", &request);
            let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
            total_ms += elapsed_ms;
            match result {
                Ok(response) => {
                    let retry = recognizer.recognize("eval", &request)?;
                    let retry_equal =
                        serde_json::to_value(&response)? == serde_json::to_value(retry)?;
                    let ids_equal = response.stroke_ids
                        == strokes[..end]
                            .iter()
                            .map(|s| s.id.clone())
                            .collect::<Vec<_>>();
                    println!(
                        "{}",
                        json!({"kind":"result", "name":sample.name, "end":end,
                        "final":step+1==steps, "elapsed_ms":elapsed_ms, "total_ms":total_ms,
                        "retry_equal":retry_equal, "ids_equal":ids_equal, "candidates":response.candidates,
                        "stable_text":response.stable_text, "classifier_calls":response.classifier_calls})
                    );
                }
                Err(error) => {
                    println!(
                        "{}",
                        json!({"kind":"error", "name":sample.name, "end":end,
                        "final":true, "elapsed_ms":elapsed_ms, "total_ms":total_ms, "error":error.to_string()})
                    );
                    break;
                }
            }
        }
    }
    Ok(())
}
