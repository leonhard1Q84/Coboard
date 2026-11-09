//! Spatial lattice across pen-down boundaries. Clipped strokes are inference-only
//! copies: source points, acquisition order and document stroke IDs never change.

use std::collections::HashMap;

use crate::{
    FragmentScores,
    connected::{Lexicon, is_han},
    incremental::{DecodeError, GlyphCandidate, Stroke},
};

const MAX_CUTS: usize = 25;
const BEAM: usize = 32;

fn bounds(strokes: &[Stroke]) -> [f32; 4] {
    strokes.iter().flatten().fold(
        [
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        ],
        |b, p| {
            [
                b[0].min(p[0]),
                b[1].min(p[1]),
                b[2].max(p[0]),
                b[3].max(p[1]),
            ]
        },
    )
}

/// Clip each polyline separately, interpolating boundary crossings. Re-entering
/// a slab starts a new pen-down; no segment across excluded ink is fabricated.
fn clip(strokes: &[Stroke], left: f32, right: f32) -> Vec<Stroke> {
    let mut result = Vec::new();
    for stroke in strokes {
        if stroke.len() == 1 {
            if stroke[0][0] >= left && stroke[0][0] <= right {
                result.push(stroke.clone());
            }
            continue;
        }
        let mut part = Vec::new();
        for pair in stroke.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let dx = b[0] - a[0];
            let interval = if dx == 0.0 {
                (a[0] >= left && a[0] <= right).then_some((0.0, 1.0))
            } else {
                let t0 = (left - a[0]) / dx;
                let t1 = (right - a[0]) / dx;
                let low = t0.min(t1).max(0.0);
                let high = t0.max(t1).min(1.0);
                (low < high).then_some((low, high))
            };
            if let Some((low, high)) = interval {
                let point = |t: f32| [a[0] + t * dx, a[1] + t * (b[1] - a[1])];
                let entry = point(low);
                if part.last().is_some_and(|p| *p != entry) {
                    result.push(std::mem::take(&mut part));
                }
                if part.last() != Some(&entry) {
                    part.push(entry);
                }
                let exit = point(high);
                if part.last() != Some(&exit) {
                    part.push(exit);
                }
                if high < 1.0 {
                    result.push(std::mem::take(&mut part));
                }
            } else if !part.is_empty() {
                result.push(std::mem::take(&mut part));
            }
        }
        if !part.is_empty() {
            result.push(part);
        }
    }
    result
}

#[derive(Clone)]
struct Path {
    text: String,
    visual: f32,
    count: usize,
    node: Option<usize>, // None is a Han path; Some is a dictionary prefix.
}

pub(super) fn recognize<F, C>(
    strokes: &[Stroke],
    mut classify: F,
    context: C,
) -> Result<Vec<GlyphCandidate>, DecodeError>
where
    F: FnMut(&[Stroke]) -> Result<FragmentScores, DecodeError>,
    C: Fn(&str) -> f32,
{
    if strokes.len() < 2
        || crate::connected::continuous(strokes)
        || !crate::connected::eligible(strokes)
    {
        return Ok(Vec::new());
    }
    let all = bounds(strokes);
    let height = all[3] - all[1];
    // Include pen-down extents (useful for delayed dots and overlapping tails),
    // plus uniform cuts so a stroke crossing several glyphs is still splittable.
    let mut cuts = vec![all[0], all[2]];
    let steps = (((all[2] - all[0]) / height * 4.0).ceil() as usize).clamp(4, 16);
    cuts.extend((1..steps).map(|i| all[0] + (all[2] - all[0]) * i as f32 / steps as f32));
    let mut extents: Vec<_> = strokes
        .iter()
        .flat_map(|s| {
            let b = bounds(std::slice::from_ref(s));
            [b[0], b[2]]
        })
        .filter(|&x| x > all[0] && x < all[2])
        .collect();
    extents.sort_by(f32::total_cmp);
    for x in extents {
        if cuts.len() >= MAX_CUTS {
            break;
        }
        if cuts.iter().all(|c| (x - c).abs() > height * 0.12) {
            cuts.push(x);
        }
    }
    cuts.sort_by(f32::total_cmp);
    let lexicon = Lexicon::bundled();
    let mut dp = vec![Vec::<Path>::new(); cuts.len()];
    for node in [Some(0), None] {
        dp[0].push(Path {
            text: String::new(),
            visual: 0.0,
            count: 0,
            node,
        });
    }
    for end in 1..cuts.len() {
        let mut paths: HashMap<(String, Option<usize>), Path> = HashMap::new();
        for start in 0..end {
            let width = cuts[end] - cuts[start];
            if dp[start].is_empty() || !(0.15..=1.55).contains(&(width / height)) {
                continue;
            }
            let ink = clip(strokes, cuts[start], cuts[end]);
            if ink.is_empty() {
                continue;
            }
            let b = bounds(&ink);
            let h = b[3] - b[1];
            if h < height * 0.25 || b[2] - b[0] < height * 0.04 {
                continue;
            }
            // At most 300 slabs total; both scripts share each model inference.
            let scores = classify(&ink)?;
            for previous in &dp[start] {
                let candidates = if previous.node.is_some() {
                    &scores.latin
                } else {
                    &scores.mixed
                };
                for candidate in candidates {
                    if candidate.text.chars().count() != 1
                        || !candidate.probability.is_finite()
                        || !(0.05..=1.0).contains(&candidate.probability)
                    {
                        continue;
                    }
                    let node = if let Some(node) = previous.node {
                        let bytes = candidate.text.as_bytes();
                        if bytes.len() != 1
                            || !bytes[0].is_ascii_lowercase()
                            || previous.count >= 20
                        {
                            continue;
                        }
                        let Some(&(_, child)) = lexicon.0[node]
                            .children
                            .iter()
                            .find(|(c, _)| *c == bytes[0])
                        else {
                            continue;
                        };
                        Some(child)
                    } else {
                        if !is_han(&candidate.text)
                            || previous.count >= 6
                            || h < height * 0.45
                            || !(0.35..=1.65).contains(&((b[2] - b[0]) / h))
                        {
                            continue;
                        }
                        None
                    };
                    let text = format!("{}{}", previous.text, candidate.text);
                    let visual = previous.visual + candidate.probability.ln();
                    let key = (text.clone(), node);
                    if paths.get(&key).is_none_or(|p| visual > p.visual) {
                        paths.insert(
                            key,
                            Path {
                                text,
                                visual,
                                count: previous.count + 1,
                                node,
                            },
                        );
                    }
                }
            }
        }
        let mut paths: Vec<_> = paths.into_values().collect();
        let score = |p: &Path| {
            p.visual / p.count as f32
                + p.node
                    .map_or_else(|| context(&p.text), |n| 0.10 * lexicon.0[n].best_frequency)
        };
        paths.sort_by(|a, b| {
            score(b)
                .total_cmp(&score(a))
                .then_with(|| a.text.cmp(&b.text))
        });
        paths.truncate(BEAM);
        dp[end] = paths;
    }
    let mut result: Vec<_> = dp
        .pop()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| {
            if p.count < 2 {
                return None;
            }
            let visual = p.visual / p.count as f32;
            let prior = if let Some(node) = p.node {
                0.10 * lexicon.0[node].terminal?
            } else {
                0.0
            };
            if visual < 0.2f32.ln() {
                return None;
            }
            Some(GlyphCandidate {
                text: p.text,
                probability: (visual + prior).exp().min(1.0),
            })
        })
        .collect();
    result.sort_by(|a, b| {
        b.probability
            .total_cmp(&a.probability)
            .then_with(|| a.text.cmp(&b.text))
    });
    result.dedup_by(|a, b| a.text == b.text);
    result.truncate(5);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipping_preserves_pen_lifts_and_reentries_without_mutating_source() {
        let ink = vec![
            vec![[0.0, 0.0], [10.0, 10.0], [0.0, 20.0]],
            vec![[5.0, -5.0]],
        ];
        let original = ink.clone();
        assert_eq!(
            clip(&ink, 2.0, 8.0),
            vec![
                vec![[2.0, 2.0], [8.0, 8.0]],
                vec![[8.0, 12.0], [2.0, 18.0]],
                vec![[5.0, -5.0]]
            ]
        );
        assert_eq!(ink, original);
    }

    #[test]
    fn multiple_pen_downs_support_english_and_han_with_bounded_shared_inference() {
        // Three loops, each with its own pen-down; no fabricated connecting line.
        let ink: Vec<Stroke> = (0..3)
            .map(|i| {
                let x = i as f32 * 21.0;
                vec![
                    [x, 0.0],
                    [x + 20.0, 0.0],
                    [x + 20.0, 20.0],
                    [x, 20.0],
                    [x, 0.0],
                ]
            })
            .collect();
        let mut calls = 0;
        let result = recognize(
            &ink,
            |_| {
                calls += 1;
                let glyph = |text: &str| GlyphCandidate {
                    text: text.into(),
                    probability: 0.9,
                };
                Ok(FragmentScores {
                    latin: vec![glyph("a")],
                    mixed: vec![glyph("人")],
                })
            },
            |_| 0.0,
        )
        .unwrap();
        assert!(calls > 0 && calls <= MAX_CUTS * (MAX_CUTS - 1) / 2);
        assert!(result.iter().any(|c| c.text == "人人人"));
        assert!(result.iter().any(|c| c.text == "aaa"));
    }
}
