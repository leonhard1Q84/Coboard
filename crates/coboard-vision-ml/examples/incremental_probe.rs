use coboard_vision_ml::{
    HandwritingEngine,
    incremental::{IncrementalDecoder, Stroke},
};
use serde::Deserialize;
use serde_json::json;
use std::{error::Error, fs, time::Instant};

#[derive(Deserialize)]
struct Fixture {
    name: String,
    expected: String,
    strokes: Vec<Stroke>,
    glyph_indices: Vec<Vec<usize>>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: incremental_probe FIXTURES_JSON [HOT_TRIALS=30]")?;
    let trials: usize = std::env::args().nth(2).map_or(Ok(30), |s| s.parse())?;
    if !(1..=100).contains(&trials) {
        return Err("HOT_TRIALS must be 1..=100".into());
    }
    let fixtures: Vec<Fixture> = serde_json::from_slice(&fs::read(path)?)?;
    let started = Instant::now();
    let engine = HandwritingEngine::load_default()?;
    println!(
        "{}",
        json!({"kind":"load", "engine":"native_sparse_cnn_phase_ensemble", "elapsed_ms":started.elapsed().as_secs_f64()*1000.0})
    );
    for f in fixtures {
        if f.glyph_indices.len() != f.expected.chars().filter(|c| !c.is_whitespace()).count()
            || f.glyph_indices
                .iter()
                .any(|g| g.is_empty() || g.iter().any(|&i| i >= f.strokes.len()))
        {
            return Err(format!("invalid glyph indices: {}", f.name).into());
        }
        for (indices, expected) in f
            .glyph_indices
            .iter()
            .zip(f.expected.chars().filter(|c| !c.is_whitespace()))
        {
            let strokes: Vec<Stroke> = indices.iter().map(|&i| f.strokes[i].clone()).collect();
            let candidates = engine.recognize_single_top10(&strokes)?;
            println!(
                "{}",
                json!({"kind":"single_raw","fixture":f.name,"expected":expected.to_string(),"candidates":candidates.iter().map(|c|json!({"label":c.label,"probability":c.prob})).collect::<Vec<_>>()})
            );
        }
        // Trial zero warms the model and is excluded by the summarizer. Every
        // trial starts a fresh decoder, so timings include cache construction.
        for trial in 0..=trials {
            let mut decoder = IncrementalDecoder::default();
            for end in 1..=f.strokes.len() {
                let output = decoder.update_with_context(
                    &f.strokes[..end],
                    |s| engine.recognize_incremental_segment(s),
                    |p, n| engine.incremental_context_score(p, n),
                )?;
                println!(
                    "{}",
                    json!({"kind":"incremental","fixture":f.name,"trial":trial,"expected":f.expected,"end":end,"final":end==f.strokes.len(),"output":output})
                );
            }
        }
    }
    Ok(())
}
