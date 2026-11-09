//! Bounded word lattice over virtual cuts with explicit pen-down boundaries.
//! Cuts never become document edits or change the source stroke's identity.

use std::{collections::HashMap, sync::OnceLock};

use crate::incremental::{DecodeError, GlyphCandidate, Stroke};

const MAX_CUTS: usize = 25;
const MAX_EDGES: usize = MAX_CUTS * (MAX_CUTS - 1) / 2;
const WORD_BEAM: usize = 256;
const MAX_LETTERS: usize = 20;
// The lexicon cannot rescue a path with inadequate fragment evidence. This is
// a conservative development threshold, not calibrated word confidence.
const MIN_VISUAL_MEAN: f32 = 0.10;
// Word frequency is a weak tie-breaker. Common words must not erase stronger
// fragment evidence in a less frequent word; this is not calibrated confidence.
const FREQUENCY_WEIGHT: f32 = 0.10;

pub(crate) fn is_word(text: &str) -> bool {
    (2..=MAX_LETTERS).contains(&text.len()) && text.bytes().all(|c| c.is_ascii_lowercase())
}

pub(crate) fn is_han(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| matches!(c, '\u{3400}'..='\u{9fff}' | '\u{20000}'..='\u{3134f}'))
}

pub(crate) fn is_sequence(text: &str) -> bool {
    is_word(text) || (is_han(text) && (2..=6).contains(&text.chars().count()))
}

#[derive(Default)]
pub(super) struct TrieNode {
    pub(super) children: Vec<(u8, usize)>,
    pub(super) terminal: Option<f32>,
    pub(super) best_frequency: f32,
}

pub(super) struct Lexicon(pub(super) Vec<TrieNode>);

impl Lexicon {
    fn from_tsv(tsv: &str) -> Self {
        let mut nodes = vec![TrieNode::default()];
        for line in tsv.lines() {
            let Some((word, frequency)) = line.split_once('\t') else {
                continue;
            };
            let Ok(frequency) = frequency.parse::<f32>() else {
                continue;
            };
            if !frequency.is_finite()
                || !(2..=MAX_LETTERS).contains(&word.len())
                || !word.bytes().all(|c| c.is_ascii_lowercase())
            {
                continue;
            }
            let mut node = 0;
            for letter in word.bytes() {
                nodes[node].best_frequency = nodes[node].best_frequency.max(frequency);
                let next = nodes[node]
                    .children
                    .iter()
                    .find(|(c, _)| *c == letter)
                    .map(|(_, i)| *i);
                node = match next {
                    Some(index) => index,
                    None => {
                        let index = nodes.len();
                        nodes.push(TrieNode::default());
                        nodes[node].children.push((letter, index));
                        index
                    }
                };
            }
            nodes[node].best_frequency = nodes[node].best_frequency.max(frequency);
            nodes[node].terminal = Some(frequency);
        }
        Self(nodes)
    }

    pub(super) fn bundled() -> &'static Self {
        static LEXICON: OnceLock<Lexicon> = OnceLock::new();
        LEXICON.get_or_init(|| Self::from_tsv(include_str!("../data/english-lexicon.txt")))
    }
}

/// Bounded prefix potential; subtract the preceding potential when extending a
/// path so longer words cannot accumulate frequency bonuses at every letter.
pub(crate) fn english_potential(text: &str, complete: bool) -> f32 {
    if text.len() < 2 || text.len() > MAX_LETTERS || !text.bytes().all(|c| c.is_ascii_alphabetic())
    {
        return 0.0;
    }
    let lexicon = Lexicon::bundled();
    let mut node = 0;
    for letter in text.bytes().map(|c| c.to_ascii_lowercase()) {
        let Some(&(_, next)) = lexicon.0[node].children.iter().find(|(c, _)| *c == letter) else {
            return -0.8;
        };
        node = next;
    }
    let frequency = if complete {
        let Some(frequency) = lexicon.0[node].terminal else {
            return -0.3;
        };
        frequency
    } else {
        lexicon.0[node].best_frequency
    };
    (0.12 * frequency).min(0.9)
}

#[derive(Clone)]
struct Path {
    node: usize,
    text: String,
    visual: f32,
    connector_arc: f32,
}

struct HanPath {
    text: String,
    visual: f32,
    right: f32,
    count: usize,
    rank: f32,
}

fn bounds(stroke: &[[f32; 2]]) -> [f32; 4] {
    stroke.iter().fold(
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

pub(crate) fn eligible(strokes: &[Stroke]) -> bool {
    if strokes.is_empty() || strokes.iter().any(Vec::is_empty) {
        return false;
    }
    let points: Stroke = strokes.iter().flatten().copied().collect();
    let s = &points;
    let b = bounds(s);
    let width = b[2] - b[0];
    let height = b[3] - b[1];
    let arc: f32 = strokes
        .iter()
        .flat_map(|s| s.windows(2))
        .map(|p| (p[1][0] - p[0][0]).hypot(p[1][1] - p[0][1]))
        .sum();
    height > 0.0
        // Nearly square isolated glyphs must never enter the word lattice.
        // A short word needs a substantial peak and sufficient pen-down arc.
        && (width > height * 1.65
            || (width > height * 1.3
                && strokes.iter().any(|stroke| !tall_peaks(stroke, height).is_empty()) && arc > height * 5.2))
        && width < height * 12.0
        && arc > width * 1.8
        && (strokes.len() > 1
            || s.last().is_some_and(|p| p[0] - s[0][0] > width * 0.6))
}

fn cuts(stroke: &Stroke) -> Vec<usize> {
    let mut arc = vec![0.0f32; stroke.len()];
    for i in 1..stroke.len() {
        arc[i] =
            arc[i - 1] + (stroke[i][0] - stroke[i - 1][0]).hypot(stroke[i][1] - stroke[i - 1][1]);
    }
    let total = arc[arc.len() - 1];
    let mut cuts = vec![0];
    // Uniform arc cuts cover unconventional joins. Baseline turns provide
    // additional boundaries without cutting only at arbitrary sample indices.
    for part in 1..16 {
        let target = total * part as f32 / 16.0;
        let index = arc
            .partition_point(|&distance| distance < target)
            .min(stroke.len() - 1);
        if cuts.last() != Some(&index) {
            cuts.push(index);
        }
    }
    cuts.push(stroke.len() - 1);
    let height = bounds(stroke)[3] - bounds(stroke)[1];
    let mut turns = Vec::new();
    let mut samples: Vec<usize> = if stroke.len() <= 512 {
        (0..stroke.len()).collect()
    } else {
        (0..=511)
            .map(|part| {
                arc.partition_point(|&d| d < total * part as f32 / 511.0)
                    .min(stroke.len() - 1)
            })
            .collect()
    };
    samples.dedup();
    for k in 1..samples.len() - 1 {
        let i = samples[k];
        if stroke[i][1] <= stroke[samples[k - 1]][1] || stroke[i][1] < stroke[samples[k + 1]][1] {
            continue;
        }
        let a = samples.partition_point(|&j| arc[j] < arc[i] - height * 0.3);
        let b = samples.partition_point(|&j| arc[j] <= arc[i] + height * 0.3);
        let left = samples[a..=k]
            .iter()
            .map(|&j| stroke[j][1])
            .fold(f32::INFINITY, f32::min);
        let right = samples[k..b]
            .iter()
            .map(|&j| stroke[j][1])
            .fold(f32::INFINITY, f32::min);
        let prominence = stroke[i][1] - left.max(right);
        if prominence > height * 0.025 {
            turns.push((i, prominence));
        }
    }
    turns.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    for (i, _) in turns {
        if cuts.len() >= MAX_CUTS {
            break;
        }
        if cuts
            .iter()
            .all(|&j| (arc[i] - arc[j]).abs() > height * 0.04)
        {
            cuts.push(i);
        }
    }
    cuts.sort_unstable();
    cuts.dedup();
    cuts
}

/// Ascenders are geometric evidence against swallowing several tall letter loops
/// into one h/d/l. Count only turns with substantial rise and fall on both sides.
fn tall_peaks(stroke: &[[f32; 2]], height: f32) -> Vec<usize> {
    let mut indices = Vec::new();
    for (i, point) in stroke.iter().enumerate() {
        if indices.last().is_none_or(|&j: &usize| stroke[j] != *point) {
            indices.push(i);
        }
    }
    let distinct: Stroke = indices.iter().map(|&i| stroke[i]).collect();
    let stroke = &distinct;
    let mut before = Vec::with_capacity(stroke.len());
    let mut maximum = f32::NEG_INFINITY;
    for p in stroke {
        before.push(maximum);
        maximum = maximum.max(p[1]);
    }
    let mut after = vec![f32::NEG_INFINITY; stroke.len()];
    maximum = f32::NEG_INFINITY;
    for (i, p) in stroke.iter().enumerate().rev() {
        after[i] = maximum;
        maximum = maximum.max(p[1]);
    }
    let mut peaks = Vec::new();
    let mut valley = f32::NEG_INFINITY;
    for i in 0..stroke.len() {
        valley = valley.max(stroke[i][1]);
        if i < 3 || i + 3 >= stroke.len() {
            continue;
        }
        if stroke[i - 3..=i + 3].iter().any(|p| p[1] < stroke[i][1]) {
            continue;
        }
        if before[i].min(after[i]) - stroke[i][1] > height * 0.55
            && (peaks.is_empty() || valley - stroke[i][1] > height * 0.3)
        {
            peaks.push(indices[i]);
            valley = stroke[i][1];
        }
    }
    peaks
}

// Geometry and virtual cuts must not depend on device sampling density or
// page coordinates. This bounded work copy never replaces source ink.
fn canonical(stroke: &Stroke) -> Stroke {
    // The public recognizer has validated finite coordinates and eligible()
    // guarantees positive arc and height before this call.
    let b = bounds(stroke);
    let scale = f64::from(b[3] - b[1]);
    let points: Vec<[f64; 2]> = stroke
        .iter()
        .map(|p| {
            [
                (f64::from(p[0]) - f64::from(b[0])) / scale,
                (f64::from(p[1]) - f64::from(b[1])) / scale,
            ]
        })
        .collect();
    let mut arc = vec![0.0; points.len()];
    for i in 1..points.len() {
        arc[i] =
            arc[i - 1] + (points[i][0] - points[i - 1][0]).hypot(points[i][1] - points[i - 1][1]);
    }
    let total = arc[arc.len() - 1];
    let mut index = 0;
    (0..512)
        .map(|k| {
            let target = total * k as f64 / 511.0;
            while index + 1 < points.len() - 1 && arc[index + 1] < target {
                index += 1;
            }
            let span = arc[index + 1] - arc[index];
            let t = if span > 0.0 {
                (target - arc[index]) / span
            } else {
                0.0
            };
            let mut point = [0.0; 2];
            for axis in 0..2 {
                point[axis] = (((points[index][axis]
                    + t * (points[index + 1][axis] - points[index][axis]))
                    * 100_000.0)
                    .round()
                    / 100_000.0) as f32;
            }
            point
        })
        .collect()
}

/// Resample pen-downs in a shared coordinate frame. Breaks are carried through
/// to every classified fragment: pen-up motion is never rasterized as ink.
pub(super) fn continuous(strokes: &[Stroke]) -> bool {
    strokes
        .windows(2)
        .all(|pair| pair[0].last() == pair[1].first())
}

fn work_ink(strokes: &[Stroke]) -> (Stroke, Vec<usize>) {
    if continuous(strokes) && strokes.len() > 1 {
        // An actual pen lift at an identical endpoint adds no geometric edge.
        // Canonicalizing the resumed path avoids resampling each piece differently.
        let joined = strokes.iter().flatten().copied().collect();
        return (canonical(&joined), vec![0]);
    }
    if strokes.len() == 1 {
        return (canonical(&strokes[0]), vec![0]);
    }
    let points: Stroke = strokes.iter().flatten().copied().collect();
    let b = bounds(&points);
    let height = (b[3] - b[1]).max(1e-6);
    let lengths: Vec<f32> = strokes
        .iter()
        .map(|s| {
            s.windows(2)
                .map(|p| (p[1][0] - p[0][0]).hypot(p[1][1] - p[0][1]))
                .sum()
        })
        .collect();
    let total = lengths.iter().sum::<f32>().max(1e-6);
    let mut points = Vec::new();
    let mut breaks = Vec::new();
    for (stroke, length) in strokes.iter().zip(lengths) {
        breaks.push(points.len());
        let mut arc = vec![0.0; stroke.len()];
        for i in 1..stroke.len() {
            arc[i] = arc[i - 1]
                + (stroke[i][0] - stroke[i - 1][0]).hypot(stroke[i][1] - stroke[i - 1][1]);
        }
        let count = if length > 0.0 {
            (512.0 * length / total).ceil().max(2.0) as usize
        } else {
            1
        };
        let mut index = 0;
        for k in 0..count {
            let target = length * k as f32 / (count - 1).max(1) as f32;
            while index + 1 < stroke.len() - 1 && arc[index + 1] < target {
                index += 1;
            }
            let next = (index + 1).min(stroke.len() - 1);
            let span = arc[next] - arc[index];
            let t = if span > 0.0 {
                (target - arc[index]) / span
            } else {
                0.0
            };
            points.push([
                (stroke[index][0] + t * (stroke[next][0] - stroke[index][0]) - b[0]) / height,
                (stroke[index][1] + t * (stroke[next][1] - stroke[index][1]) - b[1]) / height,
            ]);
        }
    }
    (points, breaks)
}

fn fragment(stroke: &Stroke, breaks: &[usize], a: usize, b: usize) -> Vec<Stroke> {
    breaks
        .iter()
        .enumerate()
        .filter_map(|(i, &start)| {
            let end = breaks.get(i + 1).copied().unwrap_or(stroke.len());
            let left = start.max(a);
            let right = end.min(b + 1);
            (left < right).then(|| stroke[left..right].to_vec())
        })
        .collect()
}

fn connector(stroke: &Stroke, a: usize, b: usize, height: f32, length: f32) -> bool {
    let dx = stroke[b][0] - stroke[a][0];
    let dy = stroke[b][1] - stroke[a][1];
    length > height * 0.02
        && length < height * 0.5
        && dx > height * 0.03
        && dy.abs() < height * 0.35
        && dx.hypot(dy) > length * 0.75
}

/// Han characters can also share one pen-down. Keep this branch independent of
/// the English lexicon; each complete character needs mixed-script evidence.
pub(crate) fn recognize_han<F, C>(
    strokes: &[Stroke],
    mut classify: F,
    context: C,
) -> Result<Vec<GlyphCandidate>, DecodeError>
where
    F: FnMut(&[Stroke]) -> Result<Vec<GlyphCandidate>, DecodeError>,
    C: Fn(&str) -> f32,
{
    if !eligible(strokes) {
        return Ok(Vec::new());
    }
    let (stroke, breaks) = work_ink(strokes);
    let height = bounds(&stroke)[3] - bounds(&stroke)[1];
    let cuts = cuts(&stroke);
    let mut dp: Vec<Vec<HanPath>> = (0..cuts.len()).map(|_| Vec::new()).collect();
    dp[0].push(HanPath {
        text: String::new(),
        visual: 0.0,
        right: f32::NEG_INFINITY,
        count: 0,
        rank: 0.0,
    });
    for end in 1..cuts.len() {
        let mut paths = Vec::new();
        for start in 0..end {
            if dp[start].is_empty() {
                continue;
            }
            let geometry = bounds(&stroke[cuts[start]..=cuts[end]]);
            let (w, h) = (geometry[2] - geometry[0], geometry[3] - geometry[1]);
            if h < height * 0.4 || !(0.35..=1.65).contains(&(w / h)) {
                continue;
            }
            let extends = |previous: &HanPath| {
                previous.count < 6
                    && (previous.count == 0
                        || (geometry[0] >= previous.right - height * 0.45
                            && geometry[2] >= previous.right + height * 0.3))
            };
            // Do not infer a fragment when no predecessor can use it. This is
            // the same placement rule applied below, before the expensive model.
            if !dp[start].iter().any(extends) {
                continue;
            }
            let candidates = classify(&fragment(&stroke, &breaks, cuts[start], cuts[end]))?;
            for candidate in candidates {
                if candidate.text.chars().count() != 1
                    || !is_han(&candidate.text)
                    || !candidate.probability.is_finite()
                    || !(0.05..=1.0).contains(&candidate.probability)
                {
                    continue;
                }
                for previous in dp[start].iter().filter(|previous| extends(previous)) {
                    let text = format!("{}{}", previous.text, candidate.text);
                    let visual = previous.visual + candidate.probability.ln();
                    let count = previous.count + 1;
                    let rank = visual / count as f32 + context(&text);
                    paths.push(HanPath {
                        text,
                        visual,
                        count,
                        right: geometry[2],
                        rank,
                    });
                }
            }
        }
        paths.sort_by(|a, b| b.rank.total_cmp(&a.rank).then_with(|| a.text.cmp(&b.text)));
        let mut seen = std::collections::HashSet::new();
        paths.retain(|p| seen.insert(p.text.clone()));
        paths.truncate(8);
        dp[end] = paths;
    }
    Ok(dp
        .pop()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.count >= 2 && p.visual / p.count as f32 >= 0.2f32.ln())
        .take(5)
        .map(|p| GlyphCandidate {
            text: p.text,
            probability: (p.visual / p.count as f32).exp(),
        })
        .collect())
}

pub(crate) fn recognize<F>(
    strokes: &[Stroke],
    mut classify: F,
) -> Result<Vec<GlyphCandidate>, DecodeError>
where
    F: FnMut(&[Stroke]) -> Result<Vec<GlyphCandidate>, DecodeError>,
{
    recognize_with_lexicon(strokes, &mut classify, Lexicon::bundled)
}

fn recognize_with_lexicon<'a, F, L>(
    strokes: &[Stroke],
    classify: &mut F,
    lexicon: L,
) -> Result<Vec<GlyphCandidate>, DecodeError>
where
    F: FnMut(&[Stroke]) -> Result<Vec<GlyphCandidate>, DecodeError>,
    L: FnOnce() -> &'a Lexicon,
{
    if strokes.is_empty()
        || strokes.len() > 128
        || strokes.iter().map(Vec::len).sum::<usize>() > 32_768
        || strokes
            .iter()
            .any(|s| s.is_empty() || s.iter().flatten().any(|p| !p.is_finite() || p.abs() > 1e7))
    {
        return Err(DecodeError::InvalidInput);
    }
    if !eligible(strokes) {
        return Ok(Vec::new());
    }
    let (work, breaks) = work_ink(strokes);
    let stroke = &work;
    let all = bounds(stroke);
    let height = all[3] - all[1];
    let mut arc = vec![0.0; stroke.len()];
    for i in 1..stroke.len() {
        arc[i] = arc[i - 1]
            + if breaks.contains(&i) {
                0.0
            } else {
                (stroke[i][0] - stroke[i - 1][0]).hypot(stroke[i][1] - stroke[i - 1][1])
            };
    }
    let cuts = cuts(stroke);
    let peaks: Vec<usize> = breaks
        .iter()
        .enumerate()
        .flat_map(|(i, &start)| {
            let end = breaks.get(i + 1).copied().unwrap_or(stroke.len());
            tall_peaks(&stroke[start..end], height)
                .into_iter()
                .map(move |p| p + start)
        })
        .collect();
    let lexicon = lexicon();
    let mut dp: Vec<Vec<Path>> = vec![Vec::new(); cuts.len()];
    dp[0].push(Path {
        node: 0,
        text: String::new(),
        visual: 0.0,
        connector_arc: 0.0,
    });
    let mut calls = 0;
    for end in 1..cuts.len() {
        let mut paths: HashMap<usize, Path> = HashMap::new();
        // This cut lattice has at most MAX_EDGES intervals. Evaluate every
        // viable interval rather than starving long letters under a quota.
        let mut starts = Vec::new();
        for (start, frontier) in dp.iter().enumerate().take(end) {
            if !frontier
                .iter()
                .any(|p| !lexicon.0[p.node].children.is_empty())
            {
                continue;
            }
            let a = cuts[start];
            let b = cuts[end];
            let geometry = bounds(&stroke[a..=b]);
            let w = geometry[2] - geometry[0];
            let h = geometry[3] - geometry[1];
            // Short, mostly straight joins can connect two complete glyphs.
            // They remain original ink; this is a blank edge in recognition,
            // never a document deletion or permission to ignore whole letters.
            let length = arc[b] - arc[a];
            if end + 1 < cuts.len()
                && !breaks.iter().any(|&i| i > a && i <= b)
                && connector(stroke, a, b, height, length)
            {
                for previous in &dp[start] {
                    let connector_arc = previous.connector_arc + length;
                    if previous.text.is_empty() || connector_arc > arc[stroke.len() - 1] * 0.2 {
                        continue;
                    }
                    let visual = previous.visual - 0.08 - 0.2 * length / height;
                    let node = previous.node;
                    if paths.get(&node).is_none_or(|path| visual > path.visual) {
                        paths.insert(
                            node,
                            Path {
                                node,
                                text: previous.text.clone(),
                                visual,
                                connector_arc,
                            },
                        );
                    }
                }
            }
            // A final descender may loop back to the left of its entry (g/j/y).
            // Its rightward body still needs geometric evidence; the letter
            // filter below keeps this exception out of other fragments.
            if h < height * 0.025
                || w > height * 1.45
                || (stroke[b][0] - stroke[a][0] < -height * 0.15
                    && !(end + 1 == cuts.len() && geometry[2] - stroke[a][0] > height * 0.15))
            {
                continue;
            }
            starts.push((start, a, b, w, h));
        }
        for (start, a, b, w, h) in starts {
            debug_assert!(calls < MAX_EDGES);
            let candidates = classify(&fragment(stroke, &breaks, a, b))?;
            calls += 1;
            let peak_count = peaks.iter().filter(|&&p| p > a && p < b).count();
            for candidate in candidates {
                let bytes = candidate.text.as_bytes();
                if bytes.len() != 1
                    || !bytes[0].is_ascii_lowercase()
                    || !candidate.probability.is_finite()
                    || candidate.probability <= 0.0
                    || candidate.probability > 1.0
                {
                    continue;
                }
                let letter = bytes[0];
                if stroke[b][0] - stroke[a][0] < -height * 0.15 && !b"gjy".contains(&letter) {
                    continue;
                }
                let max_aspect = if matches!(letter, b'm' | b'w') {
                    1.5
                } else if b"aceos".contains(&letter) {
                    // Oval cursive bodies include entry/exit connectors; their
                    // width can exceed the isolated print-letter proportion.
                    1.3
                } else if b"gq".contains(&letter) {
                    // A descender increases height, not the number of oval
                    // bodies a fragment may swallow from neighboring letters.
                    1.0
                } else if end + 1 == cuts.len() && b"gjy".contains(&letter) {
                    1.1
                } else {
                    0.85
                };
                let mut penalty =
                    5.0 * (w / h - max_aspect).max(0.0) + 2.5 * peak_count.saturating_sub(1) as f32;
                if !b"bdfghjklpqty".contains(&letter) {
                    penalty += 4.0 * (h / height - 0.6).max(0.0);
                }
                for previous in &dp[start] {
                    if previous.text.len() >= MAX_LETTERS {
                        continue;
                    }
                    let Some(&(_, node)) = lexicon.0[previous.node]
                        .children
                        .iter()
                        .find(|(c, _)| *c == letter)
                    else {
                        continue;
                    };
                    let visual = previous.visual + candidate.probability.min(1.0).ln() - penalty;
                    if paths.get(&node).is_none_or(|path| visual > path.visual) {
                        let mut text = previous.text.clone();
                        text.push(letter as char);
                        paths.insert(
                            node,
                            Path {
                                node,
                                text,
                                visual,
                                connector_arc: previous.connector_arc,
                            },
                        );
                    }
                }
            }
        }
        let mut paths: Vec<Path> = paths.into_values().collect();
        let score = |p: &Path| {
            p.visual / p.text.len() as f32 + FREQUENCY_WEIGHT * lexicon.0[p.node].best_frequency
        };
        paths.sort_by(|a, b| {
            score(b)
                .total_cmp(&score(a))
                .then_with(|| a.text.cmp(&b.text))
        });
        paths.truncate(WORD_BEAM);
        dp[end] = paths;
    }
    let mut words: Vec<_> = dp
        .last()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let frequency = lexicon.0[p.node].terminal?;
            let visual_mean = p.visual / p.text.len() as f32;
            if !is_word(&p.text) || visual_mean < MIN_VISUAL_MEAN.ln() {
                return None;
            }
            let score = visual_mean + FREQUENCY_WEIGHT * frequency;
            // A monotone bounded ranking score avoids clipping different words to
            // the same value. It must not be displayed as a confidence percentage.
            Some(GlyphCandidate {
                text: p.text.clone(),
                probability: score.exp().min(1.0),
            })
        })
        .collect();
    words.sort_by(|a, b| {
        b.probability
            .total_cmp(&a.probability)
            .then_with(|| a.text.cmp(&b.text))
    });
    words.truncate(5);
    Ok(words)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trajectory() -> Vec<Stroke> {
        vec![
            (0..=80)
                .map(|i| [i as f32 * 0.6, (i as f32 * 0.25).sin() * 10.0])
                .collect(),
        ]
    }

    #[test]
    fn isolated_wide_letter_never_invokes_word_inference() {
        let ink = vec![
            (0..=80)
                .map(|i| {
                    let t = i as f32 / 80.0;
                    [
                        24.0 * t,
                        10.0 * (1.0 - (t * std::f32::consts::PI * 4.0).cos()),
                    ]
                })
                .collect(),
        ];
        assert!(!eligible(&ink));
        assert!(
            recognize(&ink, |_| panic!(
                "isolated glyph must stay on the fast path"
            ))
            .unwrap()
            .is_empty()
        );
    }

    #[test]
    fn temporal_fragments_preserve_pen_lifts_and_exact_endpoint_resumption() {
        let ink = vec![vec![[0.0, 0.0], [1.0, 1.0]], vec![[2.0, 1.0], [3.0, 0.0]]];
        let (points, breaks) = work_ink(&ink);
        assert_eq!(breaks.len(), 2);
        let pieces = fragment(&points, &breaks, 0, points.len() - 1);
        assert_eq!(pieces.len(), 2);
        assert_eq!(pieces[0].last().unwrap()[0], 1.0);
        assert_eq!(pieces[1][0][0], 2.0);
        let resumed = vec![vec![[0.0, 0.0], [1.0, 1.0]], vec![[1.0, 1.0], [3.0, 0.0]]];
        assert_eq!(
            work_ink(&resumed).0,
            canonical(&resumed.iter().flatten().copied().collect())
        );
    }

    #[test]
    fn dictionary_requires_visual_evidence_and_cannot_invent_letters() {
        let lexicon = Lexicon::from_tsv("hhh\t4.0\naaa\t9.0\n");
        let strokes = trajectory();
        let original = strokes.clone();
        let mut calls = 0;
        let words = recognize_with_lexicon(
            &strokes,
            &mut |_| {
                calls += 1;
                Ok(vec![GlyphCandidate {
                    text: "h".into(),
                    probability: 0.9,
                }])
            },
            || &lexicon,
        )
        .unwrap();
        assert_eq!(words[0].text, "hhh");
        assert!(!words.iter().any(|c| c.text == "aaa"));
        assert!(calls > 0 && calls <= MAX_EDGES);
        assert_eq!(strokes, original);
        for probability in [0.01, 0.0, f32::NAN, 1.1] {
            let words = recognize_with_lexicon(
                &strokes,
                &mut |_| {
                    Ok(vec![GlyphCandidate {
                        text: "h".into(),
                        probability,
                    }])
                },
                || &lexicon,
            )
            .unwrap();
            assert!(words.is_empty(), "weak/invalid evidence: {probability}");
        }
        assert!(
            recognize_with_lexicon(&strokes, &mut |_| Ok(Vec::new()), || &lexicon)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn refuses_invalid_ink_and_skips_straight_lines_and_narrow_pen_downs() {
        assert!(matches!(
            recognize(&[vec![[f32::NAN, 0.0]]], |_| panic!("invalid input")),
            Err(DecodeError::InvalidInput)
        ));
        assert!(matches!(
            recognize(&[vec![[0.0, 0.0]; 32_769]], |_| panic!("point limit")),
            Err(DecodeError::InvalidInput)
        ));
        let line = vec![(0..80).map(|i| [i as f32, i as f32 * 0.2]).collect()];
        assert!(
            recognize(&line, |_| panic!("straight line is not a word"))
                .unwrap()
                .is_empty()
        );
        let two = vec![vec![[0.0, 0.0], [0.0, 60.0]]; 2];
        assert!(
            recognize(&two, |_| panic!("multiple pen-downs"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn holding_the_pen_on_an_ascender_does_not_create_extra_letters() {
        let stroke = trajectory().remove(0);
        let mut held = Vec::new();
        for point in &stroke {
            held.extend(std::iter::repeat_n(*point, 12));
        }
        assert_eq!(
            tall_peaks(&stroke, 20.0).len(),
            tall_peaks(&held, 20.0).len()
        );
        assert!(cuts(&held).len() <= MAX_CUTS);
    }

    #[test]
    fn virtual_cuts_ignore_page_position_scale_and_collinear_samples() {
        let original = vec![
            [-20.0, 0.0],
            [0.0, -20.0],
            [20.0, 0.0],
            [0.0, 20.0],
            [40.0, 0.0],
            [60.0, -20.0],
            [80.0, 0.0],
            [100.0, 20.0],
        ];
        let before = original.clone();
        let expected = canonical(&original);
        for scale in [0.5, 1.0, 2.0] {
            let mut sampled = Vec::new();
            for pair in original.windows(2) {
                for k in 0..4 {
                    let t = k as f32 / 4.0;
                    let point = [
                        scale * (pair[0][0] + t * (pair[1][0] - pair[0][0])) + 123.5,
                        scale * (pair[0][1] + t * (pair[1][1] - pair[0][1])) - 455.0,
                    ];
                    sampled.extend([point; 3]); // pauses add no new geometry
                }
            }
            sampled.push([scale * 100.0 + 123.5, scale * 20.0 - 455.0]);
            let actual = canonical(&sampled);
            assert_eq!(actual, expected);
            assert_eq!(cuts(&actual), cuts(&expected));
        }
        assert_eq!(original, before);
    }

    #[test]
    fn connectors_cannot_swallow_loops_stems_or_leftward_returns() {
        let join = vec![[0.0, 0.0], [10.0, 2.0], [20.0, 4.0]];
        assert!(connector(&join, 0, 2, 60.0, 20.4));
        let horizontal = vec![[0.0, 0.0], [20.0, 0.0]];
        assert!(connector(&horizontal, 0, 1, 60.0, 20.0));
        let loop_ink = vec![
            [0.0, 0.0],
            [20.0, 0.0],
            [20.0, 20.0],
            [0.0, 20.0],
            [0.0, 0.0],
        ];
        assert!(!connector(&loop_ink, 0, 4, 200.0, 80.0));
        assert!(!connector(
            &vec![[0.0, 0.0], [2.0, 100.0]],
            0,
            1,
            120.0,
            100.02
        ));
        assert!(!connector(&vec![[20.0, 0.0], [0.0, 0.0]], 0, 1, 60.0, 20.0));
    }
}
