//! Offline isolated-glyph evaluation. Expected labels are used only after inference.
use coboard_vision_ml::{HandwritingEngine, incremental::Stroke};
use serde::Deserialize;
use serde_json::json;
use std::{error::Error, fs, time::Instant};

#[derive(Deserialize)]
struct Sample {
    name: String,
    writer: String,
    expected: String,
    strokes: Vec<Stroke>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let input = std::env::args()
        .nth(1)
        .ok_or("usage: human_probe HUMAN_SAMPLES_JSON")?;
    let samples: Vec<Sample> = serde_json::from_slice(&fs::read(input)?)?;
    let started = Instant::now();
    let engine = HandwritingEngine::load_default()?;
    println!(
        "{}",
        json!({"kind":"load", "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,
               "scope":"isolated raw human XY ink; unrestricted deployed character range; no LM or label-conditioned filtering"})
    );
    // Warm-up uses a fixed input, independent of the dataset and labels.
    engine.recognize_incremental_glyph(&[vec![[0.0, 0.0], [0.0, 40.0]]])?;
    for sample in samples {
        let started = Instant::now();
        let result = engine.recognize_incremental_glyph(&sample.strokes);
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        match result {
            Ok(candidates) => println!(
                "{}",
                json!({"kind":"glyph", "name":sample.name, "writer":sample.writer,
                    "expected":sample.expected,"candidates":candidates,"elapsed_ms":elapsed_ms})
            ),
            Err(error) => println!(
                "{}",
                json!({"kind":"error", "name":sample.name,"writer":sample.writer,
                    "expected":sample.expected,"error":error.to_string(),"elapsed_ms":elapsed_ms})
            ),
        }
    }
    Ok(())
}
