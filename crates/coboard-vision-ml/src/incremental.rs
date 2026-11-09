//! Experimental line decoder. Scores are cached by half-open stroke intervals in
//! spatial order, preserving acquisition order inside overlapping components.
//! Stability is revocable advice, never permission to delete or convert ink.

use std::{collections::HashMap, time::Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub type Stroke = Vec<[f32; 2]>;
const MAX_STROKES: usize = 128;
const MAX_POINTS: usize = 32_768;
const MAX_GLYPH_STROKES: usize = 32;
const BEAM: usize = 8;

#[derive(Debug, Error, PartialEq)]
pub enum DecodeError {
    #[error("笔迹为空、坐标无效或超出实验上限")]
    InvalidInput,
    #[error("当前实验仅支持单行笔迹")]
    MultipleLines,
    #[error("单字识别失败: {0}")]
    Classifier(String),
    #[error("没有可用的切分候选，已保留笔迹")]
    NoPath,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GlyphCandidate {
    pub text: String,
    pub probability: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Bounds {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

impl Bounds {
    fn of(strokes: &[Stroke]) -> Self {
        let mut b = Self {
            left: f32::INFINITY,
            top: f32::INFINITY,
            right: f32::NEG_INFINITY,
            bottom: f32::NEG_INFINITY,
        };
        for &[x, y] in strokes.iter().flatten() {
            b.left = b.left.min(x);
            b.top = b.top.min(y);
            b.right = b.right.max(x);
            b.bottom = b.bottom.max(y);
        }
        b
    }

    fn join(self, b: Self) -> Self {
        Self {
            left: self.left.min(b.left),
            top: self.top.min(b.top),
            right: self.right.max(b.right),
            bottom: self.bottom.max(b.bottom),
        }
    }

    fn scale(self) -> f32 {
        (self.right - self.left)
            .max(self.bottom - self.top)
            .max(1.0)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Segment {
    /// Half-open range in spatial stroke order, not acquisition order.
    pub start: usize,
    pub end: usize,
    /// Original input indices; these are the only indices a caller should map to ink IDs.
    pub stroke_indices: Vec<usize>,
    pub text: String,
    pub bounds: Bounds,
}

#[derive(Clone, Debug, Serialize)]
pub struct LineCandidate {
    pub text: String,
    /// Ranking score, not a calibrated confidence.
    pub score: f32,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Serialize)]
pub struct IncrementalOutput {
    pub candidates: Vec<LineCandidate>,
    /// Agrees across the beam and the preceding update, excluding the last glyph.
    /// May shrink after delayed strokes. Callers must not auto-delete this range.
    pub stable_stroke_indices: Vec<usize>,
    pub stable_text: String,
    pub classifier_calls: usize,
    pub cache_hits: usize,
    pub cache_entries: usize,
    pub elapsed_ms: f64,
}

#[derive(Default)]
pub struct IncrementalDecoder {
    previous: Vec<Stroke>,
    previous_order: Vec<usize>,
    cache: HashMap<(usize, usize), Vec<GlyphCandidate>>,
    previous_best: Option<LineCandidate>,
}

struct Component {
    indices: Vec<usize>,
    bounds: Bounds,
}

impl Component {
    fn scale(&self, strokes: &[Stroke]) -> f32 {
        if (self.indices.len() == 1
            && crate::connected::eligible(std::slice::from_ref(&strokes[self.indices[0]])))
            || self.bounds.right - self.bounds.left > (self.bounds.bottom - self.bounds.top) * 1.65
        {
            // Word width is not a character-height estimate for whitespace or
            // line separation.
            (self.bounds.bottom - self.bounds.top).max(1.0)
        } else {
            self.bounds.scale()
        }
    }
}

fn spatial_components(strokes: &[Stroke]) -> Result<Vec<Component>, DecodeError> {
    let mut components: Vec<Component> = Vec::new();
    let boxes: Vec<_> = strokes
        .iter()
        .map(|s| Bounds::of(std::slice::from_ref(s)))
        .collect();
    let attachments: Vec<_> = boxes
        .iter()
        .enumerate()
        .map(|(i, dot)| {
            boxes
                .iter()
                .enumerate()
                .filter_map(|(j, stem)| {
                    let height = stem.bottom - stem.top;
                    let x_gap = (dot.left - stem.right).max(stem.left - dot.right).max(0.0);
                    let y_gap = (stem.top - dot.bottom).max(0.0);
                    (i != j
                        && dot.scale() < height * 0.45
                        && dot.bottom <= stem.top + height * 0.1
                        && y_gap <= height * 3.3
                        && x_gap <= height * 0.3)
                        .then_some((j, (x_gap * 2.0 + y_gap) / height))
                })
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(j, _)| j)
        })
        .collect();
    for (index, stroke) in strokes.iter().enumerate() {
        let mut part = Component {
            indices: vec![index],
            bounds: Bounds::of(std::slice::from_ref(stroke)),
        };
        // A later crossbar may join two earlier verticals. Restart after merging.
        let mut i = 0;
        while i < components.len() {
            let b = components[i].bounds;
            let x_overlap = part.bounds.right.min(b.right) - part.bounds.left.max(b.left);
            let y_gap = (part.bounds.top - b.bottom).max(b.top - part.bounds.bottom);
            let min_width = (part.bounds.right - part.bounds.left).min(b.right - b.left);
            let attached = part.indices.iter().any(|&a| {
                components[i]
                    .indices
                    .iter()
                    .any(|&b| attachments[a] == Some(b) || attachments[b] == Some(a))
            });
            let strong_overlap = if min_width > 0.0 {
                x_overlap > 0.25 * min_width
            } else {
                x_overlap >= 0.0
            };
            let crossbar = part.indices.iter().any(|&a| {
                components[i].indices.iter().any(|&b| {
                    let touches = |bar: Bounds, stem: Bounds| {
                        let height = stem.bottom - stem.top;
                        let x_gap = (bar.left - stem.right).max(stem.left - bar.right).max(0.0);
                        height > 0.0
                            && stem.right - stem.left < height * 0.3
                            && bar.bottom - bar.top < height * 0.25
                            && bar.right - bar.left > height * 0.25
                            && x_gap < height * 0.08
                            && bar.top <= stem.bottom
                            && bar.bottom >= stem.top - height * 0.12
                    };
                    touches(boxes[a], boxes[b]) || touches(boxes[b], boxes[a])
                })
            });
            if attached
                || crossbar
                || (strong_overlap && y_gap <= part.bounds.scale().max(b.scale()) * 0.4)
            {
                let other = components.remove(i);
                part.bounds = part.bounds.join(other.bounds);
                part.indices.extend(other.indices);
                i = 0;
            } else {
                i += 1;
            }
        }
        part.indices.sort_unstable();
        components.push(part);
    }
    components.sort_by(|a, b| a.bounds.left.total_cmp(&b.bounds.left));
    let mut scales: Vec<f32> = components.iter().map(|c| c.scale(strokes)).collect();
    scales.sort_by(f32::total_cmp);
    let scale = scales[scales.len() / 2];
    for pair in components.windows(2) {
        let a = pair[0].bounds;
        let b = pair[1].bounds;
        let local_height = (a.bottom - a.top).max(b.bottom - b.top).max(scale);
        if (a.top - b.bottom).max(b.top - a.bottom) > local_height * 0.6 {
            return Err(DecodeError::MultipleLines);
        }
    }
    Ok(components)
}

#[derive(Clone, Copy, PartialEq)]
enum Script {
    Latin,
    Digit,
    Han,
    Other,
}

fn script(text: &str) -> Script {
    match text.chars().next() {
        Some(c) if c.is_ascii_alphabetic() => Script::Latin,
        Some(c) if c.is_ascii_digit() => Script::Digit,
        Some('\u{3400}'..='\u{9fff}' | '\u{20000}'..='\u{3134f}') => Script::Han,
        _ => Script::Other,
    }
}

fn transition(previous: &str, next: &str, space: bool) -> f32 {
    if space {
        return 0.0;
    }
    let a = script(previous);
    let b = script(next);
    match (a, b) {
        (Script::Latin, Script::Latin) => {
            let upper = |s: &str| s.chars().all(|c| c.is_ascii_uppercase());
            match (upper(previous), upper(next)) {
                (true, true) => 0.35,
                (false, false) => 0.35,
                (true, false) => 0.10,
                (false, true) => -0.25,
            }
        }
        (Script::Digit, Script::Digit) => 0.45,
        (Script::Han, Script::Han) => 0.08,
        (Script::Other, _) | (_, Script::Other) => -0.15,
        _ if space => 0.0,
        _ => -0.55,
    }
}

impl IncrementalDecoder {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Update from a bounded snapshot. Append transport can maintain this snapshot
    /// at the IPC boundary. Changed, removed or spatially reordered strokes invalidate
    /// only affected cache intervals. Failure never advances the accepted snapshot.
    pub fn update<F>(
        &mut self,
        strokes: &[Stroke],
        classify: F,
    ) -> Result<IncrementalOutput, DecodeError>
    where
        F: FnMut(&[Stroke]) -> Result<Vec<GlyphCandidate>, DecodeError>,
    {
        self.update_with_context(strokes, classify, |_, _| 0.0)
    }

    pub fn update_with_context<F, C>(
        &mut self,
        strokes: &[Stroke],
        mut classify: F,
        context_score: C,
    ) -> Result<IncrementalOutput, DecodeError>
    where
        F: FnMut(&[Stroke]) -> Result<Vec<GlyphCandidate>, DecodeError>,
        C: Fn(Option<&str>, &str) -> f32,
    {
        let started = Instant::now();
        if strokes.is_empty()
            || strokes.len() > MAX_STROKES
            || strokes.iter().map(Vec::len).sum::<usize>() > MAX_POINTS
            || strokes.iter().any(|s| {
                s.is_empty() || s.iter().flatten().any(|v| !v.is_finite() || v.abs() > 1e7)
            })
        {
            return Err(DecodeError::InvalidInput);
        }
        let components = spatial_components(strokes)?;
        let order: Vec<usize> = components
            .iter()
            .flat_map(|c| c.indices.iter().copied())
            .collect();
        let common = order
            .iter()
            .zip(&self.previous_order)
            .take_while(|(a, b)| a == b && strokes[**a] == self.previous[**b])
            .count();
        self.cache.retain(|&(_, end), _| end <= common);
        let sorted: Vec<Stroke> = order.iter().map(|&i| strokes[i].clone()).collect();
        let mut ends = vec![0];
        for c in &components {
            ends.push(ends.last().copied().unwrap_or(0) + c.indices.len());
        }
        let mut scales: Vec<f32> = components.iter().map(|c| c.scale(strokes)).collect();
        scales.sort_by(f32::total_cmp);
        let scale = scales[scales.len() / 2];
        let mut dp: Vec<Vec<LineCandidate>> = vec![Vec::new(); components.len() + 1];
        dp[0].push(LineCandidate {
            text: String::new(),
            score: 0.0,
            segments: Vec::new(),
        });
        let mut classifier_calls = 0;
        let mut cache_hits = 0;
        for i in 1..=components.len() {
            let mut paths = Vec::new();
            for j in (0..i).rev() {
                let (start, end) = (ends[j], ends[i]);
                if end - start > MAX_GLYPH_STROKES {
                    break;
                }
                if dp[j].is_empty() {
                    continue;
                }
                let bounds = Bounds::of(&sorted[start..end]);
                let internal_gap: f32 = components[j..i]
                    .windows(2)
                    .map(|p| (p[1].bounds.left - p[0].bounds.right).max(0.0))
                    .sum();
                if i - j > 1 {
                    let gap = components[j..i]
                        .windows(2)
                        .map(|p| p[1].bounds.left - p[0].bounds.right)
                        .fold(0.0f32, f32::max);
                    let word_interval = i - j <= 8
                        && gap <= scale * 0.15
                        && crate::connected::eligible(&sorted[start..end]);
                    if (!word_interval && bounds.right - bounds.left > scale * 1.6)
                        || gap > scale * 0.45
                    {
                        continue;
                    }
                }
                let key = (start, end);
                if !self.cache.contains_key(&key) {
                    let mut candidates = match classify(&sorted[start..end]) {
                        Ok(c) => c,
                        Err(e) => {
                            // Newly inserted entries refer to the pending ordering.
                            self.cache.retain(|&(_, e), _| e <= common);
                            return Err(e);
                        }
                    };
                    let can_be_word = crate::connected::eligible(&sorted[start..end]);
                    candidates.retain(|c| {
                        (c.text.chars().count() == 1
                            || (can_be_word && crate::connected::is_sequence(&c.text)))
                            && !c.text.trim().is_empty()
                            && c.probability.is_finite()
                            && c.probability > 0.0
                            && c.probability <= 1.0
                    });
                    candidates.sort_by(|a, b| b.probability.total_cmp(&a.probability));
                    let mut seen = std::collections::HashSet::new();
                    let (mut glyphs, mut words) = (0, 0);
                    candidates.retain(|c| {
                        if !seen.insert(c.text.clone()) {
                            return false;
                        }
                        let count = if crate::connected::is_sequence(&c.text) {
                            &mut words
                        } else {
                            &mut glyphs
                        };
                        *count += 1;
                        *count <= 5
                    });
                    self.cache.insert(key, candidates);
                    classifier_calls += 1;
                } else {
                    cache_hits += 1;
                }
                let gap = if j > 0 {
                    bounds.left - components[j - 1].bounds.right
                } else {
                    0.0
                };
                for candidate in &self.cache[&key] {
                    for previous in &dp[j] {
                        let last = previous.segments.last().map(|s| s.text.as_str());
                        // Geometry determines whitespace independently of a model's
                        // tentative script label (e.g. 3 versus 了, 0 versus O).
                        let word_gap = if last.is_some_and(|s| script(s) == Script::Han)
                            && script(&candidate.text) == Script::Han
                        {
                            0.65
                        } else {
                            0.45
                        };
                        let space = last.is_some() && gap > scale * word_gap;
                        let context = last
                            .map(|s| transition(s, &candidate.text, space))
                            .unwrap_or(0.0)
                            + context_score(if space { None } else { last }, &candidate.text);
                        let mut path = previous.clone();
                        let aspect = (bounds.right - bounds.left)
                            / (bounds.bottom - bounds.top).max(scale * 0.4);
                        let max_aspect = match script(&candidate.text) {
                            Script::Latin
                                if matches!(candidate.text.as_str(), "M" | "W" | "m" | "w") =>
                            {
                                1.4
                            }
                            Script::Latin
                                if matches!(
                                    candidate.text.as_str(),
                                    "o" | "a" | "c" | "e" | "s"
                                ) =>
                            {
                                1.3
                            }
                            Script::Latin
                                if candidate.text.chars().all(|c| c.is_ascii_lowercase()) =>
                            {
                                0.85
                            }
                            Script::Latin | Script::Digit => 1.1,
                            _ => 1.5,
                        };
                        let shape_penalty =
                            if i - j == 1 || crate::connected::is_sequence(&candidate.text) {
                                0.0
                            } else {
                                8.0 * (aspect - max_aspect).max(0.0)
                            };
                        if space {
                            path.text.push(' ');
                        }
                        path.text.push_str(&candidate.text);
                        // Separate components may be radicals, but increasing blank
                        // space is evidence against treating them as one character.
                        path.score += candidate.probability.max(1e-9).ln() * (i - j) as f32
                            + context
                            - 1.2 * internal_gap / scale
                            - shape_penalty;
                        let old_word = previous.text.rsplit(' ').next().unwrap_or("");
                        let word = path.text.rsplit(' ').next().unwrap_or("");
                        if script(&candidate.text) == Script::Latin {
                            path.score +=
                                crate::connected::english_potential(word, i == components.len())
                                    - if space {
                                        0.0
                                    } else {
                                        crate::connected::english_potential(old_word, false)
                                    };
                        }
                        // Relative line height is informative only when there is
                        // real variation. Equal-height composed fixtures provide none.
                        if components.len() > 1 && script(&candidate.text) == Script::Latin {
                            let h = bounds.bottom - bounds.top;
                            let line_height = previous
                                .segments
                                .iter()
                                .filter(|s| script(&s.text) == Script::Latin)
                                .map(|s| s.bounds.bottom - s.bounds.top)
                                .fold(h, f32::max)
                                .max(1.0);
                            let line_bottom = previous
                                .segments
                                .iter()
                                .filter(|s| script(&s.text) == Script::Latin)
                                .map(|s| s.bounds.bottom)
                                .fold(bounds.bottom, f32::max);
                            if h < line_height * 0.72
                                && bounds.bottom > line_bottom - line_height * 0.2
                                && candidate.text.chars().all(|c| c.is_ascii_uppercase())
                            {
                                path.score -= 0.4;
                            }
                        }
                        path.segments.push(Segment {
                            start,
                            end,
                            stroke_indices: order[start..end].to_vec(),
                            text: candidate.text.clone(),
                            bounds,
                        });
                        paths.push(path);
                    }
                }
            }
            paths.sort_by(|a, b| b.score.total_cmp(&a.score));
            let mut seen = std::collections::HashSet::new();
            paths.retain(|p| seen.insert(p.text.clone()));
            if components.len() == 1 {
                let fallback = paths.iter().find(|p| p.text.chars().count() == 1).cloned();
                paths.truncate(5);
                if let Some(fallback) = fallback.filter(|p| !paths.iter().any(|c| c.text == p.text))
                {
                    if paths.len() == 5 {
                        paths.pop();
                    }
                    paths.push(fallback);
                }
            } else {
                paths.truncate(BEAM);
            }
            dp[i] = paths;
        }
        let mut candidates = dp.pop().unwrap_or_default();
        candidates.truncate(5);
        let Some(best) = candidates.first() else {
            self.cache.retain(|&(_, end), _| end <= common);
            return Err(DecodeError::NoPath);
        };
        let mut stable_stroke_indices = Vec::new();
        let mut stable_count = 0;
        if let Some(previous) = &self.previous_best {
            for (i, segment) in best
                .segments
                .iter()
                .enumerate()
                .take(best.segments.len().saturating_sub(1))
            {
                if previous.segments.get(i) != Some(segment)
                    || !candidates
                        .iter()
                        .all(|c| c.segments.get(i) == Some(segment))
                {
                    break;
                }
                stable_stroke_indices.extend(&segment.stroke_indices);
                stable_count += 1;
            }
        }
        // A stable segment may contain a whole word. Keep the exact prefix,
        // including only spaces that occur between its stable segments.
        let stable_len = best.segments[..stable_count]
            .iter()
            .map(|s| s.text.chars().count())
            .sum::<usize>();
        let mut remaining = stable_len;
        let stable_text: String = best
            .text
            .chars()
            .take_while(|&ch| {
                if remaining == 0 {
                    return false;
                }
                if ch != ' ' {
                    remaining -= 1;
                }
                true
            })
            .collect();
        self.previous = strokes.to_vec();
        self.previous_order = order;
        self.previous_best = Some(best.clone());
        Ok(IncrementalOutput {
            candidates,
            stable_stroke_indices,
            stable_text,
            classifier_calls,
            cache_hits,
            cache_entries: self.cache.len(),
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    }
}
