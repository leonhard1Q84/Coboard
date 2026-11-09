use std::{error::Error, fs, path::Path, time::Instant};

use coboard_vision_ml::incremental::{DecodeError, GlyphCandidate, IncrementalDecoder, Stroke};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Labels {
    chars: Vec<String>,
}

#[derive(Deserialize)]
struct Fixture {
    name: String,
    expected: String,
    strokes: Vec<Stroke>,
    glyph_indices: Vec<Vec<usize>>,
    pen_up_ms: Vec<u64>,
}

fn classify(
    engine: &libochwpro::Inference,
    strokes: &[Stroke],
) -> Result<Vec<GlyphCandidate>, DecodeError> {
    // Positional encoding supports 512 points. Uniform per-stroke arc-length
    // sampling removes input device sampling density as an accidental variable.
    // Both raw and sampled stage-1 results are recorded; no expected text is used.
    let sampled: Vec<Vec<(f32, f32)>> = strokes
        .iter()
        .map(|stroke| {
            let length: f32 = stroke
                .windows(2)
                .map(|p| (p[1][0] - p[0][0]).hypot(p[1][1] - p[0][1]))
                .sum();
            let count =
                ((length / 8.0).ceil() as usize).clamp(2, (480 / strokes.len().max(1)).max(2));
            let mut cumulative = vec![0.0];
            for pair in stroke.windows(2) {
                cumulative.push(
                    cumulative.last().copied().unwrap_or(0.0)
                        + (pair[1][0] - pair[0][0]).hypot(pair[1][1] - pair[0][1]),
                );
            }
            (0..count)
                .map(|i| {
                    let target = length * i as f32 / (count - 1) as f32;
                    let right = cumulative
                        .partition_point(|&d| d < target)
                        .min(stroke.len() - 1);
                    let left = right.saturating_sub(1);
                    let ratio = (target - cumulative[left])
                        / (cumulative[right] - cumulative[left]).max(1e-6);
                    (
                        stroke[left][0] + ratio * (stroke[right][0] - stroke[left][0]),
                        stroke[left][1] + ratio * (stroke[right][1] - stroke[left][1]),
                    )
                })
                .collect()
        })
        .collect();
    engine
        .predict(&sampled, 10)
        .map(|cs| {
            cs.into_iter()
                .map(|c| GlyphCandidate {
                    text: c.label,
                    probability: c.score,
                })
                .collect()
        })
        .map_err(|e| DecodeError::Classifier(e.to_string()))
}

fn sample_corners(strokes: &[Stroke], subdivisions: f32) -> Vec<Vec<(f32, f32)>> {
    let points: Vec<[f32; 2]> = strokes.iter().flatten().copied().collect();
    let minx = points.iter().map(|p| p[0]).fold(f32::INFINITY, f32::min);
    let maxx = points
        .iter()
        .map(|p| p[0])
        .fold(f32::NEG_INFINITY, f32::max);
    let miny = points.iter().map(|p| p[1]).fold(f32::INFINITY, f32::min);
    let maxy = points
        .iter()
        .map(|p| p[1])
        .fold(f32::NEG_INFINITY, f32::max);
    let step = (maxx - minx).max(maxy - miny).max(1.0) / subdivisions;
    strokes
        .iter()
        .map(|s| {
            let mut out = vec![(s[0][0], s[0][1])];
            for pair in s.windows(2) {
                let count = ((pair[1][0] - pair[0][0]).hypot(pair[1][1] - pair[0][1]) / step)
                    .ceil()
                    .max(1.0) as usize;
                for k in 1..=count {
                    let t = k as f32 / count as f32;
                    out.push((
                        pair[0][0] + t * (pair[1][0] - pair[0][0]),
                        pair[0][1] + t * (pair[1][1] - pair[0][1]),
                    ));
                }
            }
            out
        })
        .collect()
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        return Err("usage: coboard-ochwpro-probe MODEL_DIR FIXTURES_JSON [REPETITIONS=30]".into());
    }
    let model_dir = Path::new(&args[1]);
    let fixtures: Vec<Fixture> = serde_json::from_slice(&fs::read(&args[2])?)?;
    let repetitions: usize = args.get(3).map(|n| n.parse()).transpose()?.unwrap_or(30);
    if !(1..=1000).contains(&repetitions) {
        return Err("repetitions must be 1..1000".into());
    }
    for f in &fixtures {
        if f.strokes.is_empty()
            || f.strokes.len() > 128
            || f.strokes.iter().any(|s| {
                s.is_empty() || s.iter().flatten().any(|v| !v.is_finite() || v.abs() > 1e7)
            })
            || f.glyph_indices.len() != f.expected.chars().filter(|c| !c.is_whitespace()).count()
            || f.pen_up_ms.len() != f.strokes.len()
            || f.glyph_indices
                .iter()
                .flatten()
                .any(|&i| i >= f.strokes.len())
        {
            return Err(format!("invalid fixture: {}", f.name).into());
        }
    }
    let started = Instant::now();
    let labels: Labels = serde_json::from_slice(&fs::read(model_dir.join("char_index.json"))?)?;
    if labels.chars.len() != 7356 {
        return Err("label count must be 7356".into());
    }
    let engine = libochwpro::Inference::load(
        &fs::read(model_dir.join("ochw_model_fp16.safetensors"))?,
        labels.chars,
    )?;
    println!(
        "{}",
        json!({"kind":"load","elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"backend":"Candle CPU, no Accelerate feature","repetitions":repetitions})
    );
    for fixture in &fixtures {
        for (indices, expected) in fixture
            .glyph_indices
            .iter()
            .zip(fixture.expected.chars().filter(|c| !c.is_whitespace()))
        {
            let strokes: Vec<Stroke> = indices
                .iter()
                .map(|&i| fixture.strokes[i].clone())
                .collect();
            let raw: Vec<Vec<(f32, f32)>> = strokes
                .iter()
                .map(|s| s.iter().map(|p| (p[0], p[1])).collect())
                .collect();
            if raw.iter().map(Vec::len).sum::<usize>() > 512 {
                return Err("raw glyph exceeds 512 points".into());
            }
            if std::env::var_os("COBOARD_OCHW_SWEEP").is_some() {
                for density in [2.0, 4.0, 6.0, 8.0, 12.0, 16.0, 24.0] {
                    let sampled = sample_corners(&strokes, density);
                    if sampled.iter().map(Vec::len).sum::<usize>() <= 512 {
                        let candidates = engine.predict(&sampled, 30)?;
                        println!(
                            "{}",
                            json!({"kind":"sweep","fixture":fixture.name,"expected":expected.to_string(),"density":density,"candidates":candidates})
                        );
                    }
                }
            }
            let start = Instant::now();
            let candidates = engine.predict(&raw, 10)?;
            println!(
                "{}",
                json!({"kind":"single_raw","fixture":fixture.name,"expected":expected.to_string(),"candidates":candidates,"elapsed_ms":start.elapsed().as_secs_f64()*1000.0})
            );
            let start = Instant::now();
            let candidates = classify(&engine, &strokes)?;
            println!(
                "{}",
                json!({"kind":"single_resampled","fixture":fixture.name,"expected":expected.to_string(),"candidates":candidates,"elapsed_ms":start.elapsed().as_secs_f64()*1000.0})
            );
        }
    }
    // Trial zero warms inference and decoder paths; exclude it from hot statistics.
    for trial in 0..=repetitions {
        for fixture in &fixtures {
            let mut decoder = IncrementalDecoder::default();
            for end in 1..=fixture.strokes.len() {
                let result = decoder.update(&fixture.strokes[..end], |s| classify(&engine, s));
                match result {
                    Ok(output) => println!(
                        "{}",
                        json!({"kind":"incremental","trial":trial,"fixture":fixture.name,"stroke_end":end,"pen_up_ms":fixture.pen_up_ms[end-1],"final":end==fixture.strokes.len(),"expected":fixture.expected,"output":output})
                    ),
                    Err(error) => println!(
                        "{}",
                        json!({"kind":"decode_error","trial":trial,"fixture":fixture.name,"stroke_end":end,"error":error.to_string()})
                    ),
                }
            }
        }
    }
    Ok(())
}
