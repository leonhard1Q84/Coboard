//! Local offline handwriting recognition engine (Path-Signature + 9-layer SparseConvNet
//! single-character classifier + radical-block beam search DP + 2-gram backoff LM).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use thiserror::Error;

mod connected;
pub mod incremental;
mod multipen;
pub mod recognition;
mod stroke_normalization;

use stroke_normalization::normalize_box_strokes;

#[cfg(test)]
mod incremental_tests;

const IMAGE_BASE: usize = 0x1000_0000;
const NUM_CLASSES: usize = 29_205;
const GRID_SIDE: usize = 96;
const SIG_DIM: usize = 15;
const DEFAULT_RANGE_FLAGS: u32 = 0x433; // digits (0x30) | ASCII letters (0x03) | Chinese (0x400)

const BLACKLIST_CODES: [u32; 25] = [
    0xfeff_9fa8,
    0xd862_dd0d,
    0xd85b_de88,
    0xd857_dd99,
    0xd857_ddb9,
    0xd858_dc21,
    0xd856_dcde,
    0xd85e_df65,
    0xd850_dd61,
    0xd84d_ddbb,
    0xd84c_ddea,
    0xd84c_de5e,
    0xd84d_de8e,
    0xd84d_de9e,
    0xd849_dcbc,
    0xd849_dcc1,
    0xd849_dcc9,
    0xd849_dccc,
    0xd847_dd53,
    0xd842_de8a,
    0xfeff_2ec6,
    0xfeff_2ecf,
    0xfeff_fa0c,
    0xfeff_2ebe,
    0xfeff_e834,
];

#[derive(Debug, Error)]
pub enum HwrError {
    #[error("手写识别模型未就绪: {0}")]
    ModelUnavailable(String),
    #[error("手写模型文件格式无效: {0}")]
    InvalidModel(String),
    #[error("输入笔迹为空")]
    EmptyInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecognitionCandidate {
    pub text: String,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecognitionOutput {
    pub candidates: Vec<RecognitionCandidate>,
    pub elapsed_ms: f64,
}

#[derive(Clone)]
struct FragmentScores {
    latin: Vec<incremental::GlyphCandidate>,
    mixed: Vec<incremental::GlyphCandidate>,
}

fn top_hundred_logits(indexed: &mut Vec<(usize, f32)>) {
    let order =
        |a: &(usize, f32), b: &(usize, f32)| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0));
    // Only the best 100 can contribute to rank_logits. Selecting them first
    // avoids sorting all 29k classes for every virtual character fragment.
    if indexed.len() > 100 {
        indexed.select_nth_unstable_by(100, order);
        indexed.truncate(100);
    }
    indexed.sort_by(order);
}

#[derive(Debug, Clone)]
struct ConvLayer {
    k: usize,
    pool: usize,
    cin: usize,
    cout: usize,
    drop: f32,
    relu: bool,
    conv_side: usize,
    pool_side: usize,
    weights: Vec<f32>,           // shape: [k * k][cin * cout]
    biases: Vec<f32>,            // shape: [cout]
    null_bias: Option<Vec<f32>>, // shape: [k * k][cout]
}

#[derive(Debug, Clone)]
struct UnigramEntry {
    prob: f32,
    bow: f32,
    bi_start: i32,
    bi_end: i32,
}

#[derive(Debug, Clone)]
pub struct LanguageModel {
    vocab: HashMap<String, u32>,
    unigrams: Vec<UnigramEntry>,
    bi_targets: Vec<u16>,
    bi_probs: Vec<u8>,
}

impl LanguageModel {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, HwrError> {
        if bytes.len() < 4 {
            return Err(HwrError::InvalidModel("LM header too short".into()));
        }
        let n_vocab = read_u32_le(bytes, 0)? as usize;
        let vocab_end = 4usize
            .checked_add(
                n_vocab
                    .checked_mul(36)
                    .ok_or_else(|| HwrError::InvalidModel("LM vocab overflow".into()))?,
            )
            .ok_or_else(|| HwrError::InvalidModel("LM vocab offset overflow".into()))?;
        if bytes.len() < vocab_end + 8 {
            return Err(HwrError::InvalidModel("LM truncated in vocab".into()));
        }
        let mut vocab = HashMap::with_capacity(n_vocab);
        for i in 0..n_vocab {
            let off = 4 + i * 36;
            let raw = &bytes[off..off + 32];
            let end = raw.iter().position(|&b| b == 0).unwrap_or(32);
            let word = String::from_utf8_lossy(&raw[..end]).into_owned();
            let wid = read_u32_le(bytes, off + 32)?;
            vocab.insert(word, wid);
        }

        let n_uni = read_u32_le(bytes, vocab_end)? as usize;
        let n_bi = read_u32_le(bytes, vocab_end + 4)? as usize;
        let mut pos = vocab_end + 8;

        let uni_bytes_len = n_uni
            .checked_mul(12)
            .ok_or_else(|| HwrError::InvalidModel("LM unigram overflow".into()))?;
        if bytes.len() < pos + uni_bytes_len {
            return Err(HwrError::InvalidModel("LM truncated in unigrams".into()));
        }
        let mut unigrams = Vec::with_capacity(n_uni);
        for i in 0..n_uni {
            let off = pos + i * 12;
            let u_prob = bytes[off];
            let u_bow = bytes[off + 1] as i8;
            let bi_end = read_i32_le(bytes, off + 4)?;
            let bi_start = read_i32_le(bytes, off + 8)?;
            let prob = ((-(u_prob as f64) + 5.0) / 27.63) as f32;
            let bow = ((u_bow as f64) / 27.63) as f32;
            unigrams.push(UnigramEntry {
                prob,
                bow,
                bi_start,
                bi_end,
            });
        }
        pos += align4(uni_bytes_len);

        let bi_targets_len = n_bi
            .checked_mul(2)
            .ok_or_else(|| HwrError::InvalidModel("LM bigram targets overflow".into()))?;
        if bytes.len() < pos + bi_targets_len {
            return Err(HwrError::InvalidModel(
                "LM truncated in bigram targets".into(),
            ));
        }
        let mut bi_targets = Vec::with_capacity(n_bi);
        for i in 0..n_bi {
            bi_targets.push(read_u16_le(bytes, pos + i * 2)?);
        }
        pos += align4(bi_targets_len);

        if bytes.len() < pos + n_bi {
            return Err(HwrError::InvalidModel(
                "LM truncated in bigram probs".into(),
            ));
        }
        let bi_probs = bytes[pos..pos + n_bi].to_vec();

        Ok(Self {
            vocab,
            unigrams,
            bi_targets,
            bi_probs,
        })
    }

    pub fn score(&self, prev_word: Option<&str>, word: &str) -> f32 {
        let Some(&wid2) = self.vocab.get(word) else {
            return -10.0;
        };
        let Some(u2) = self.unigrams.get(wid2 as usize) else {
            return -10.0;
        };
        let Some(w1_str) = prev_word else {
            return u2.prob;
        };
        let Some(&wid1) = self.vocab.get(w1_str) else {
            return u2.prob;
        };
        let Some(u1) = self.unigrams.get(wid1 as usize) else {
            return u2.prob;
        };
        if u1.bi_start >= 0 && u1.bi_end >= u1.bi_start {
            let start = u1.bi_start as usize;
            let end = (u1.bi_end as usize).min(self.bi_targets.len().saturating_sub(1));
            if start <= end && end < self.bi_targets.len() {
                let slice = &self.bi_targets[start..=end];
                if let Ok(rel_idx) = slice.binary_search(&(wid2 as u16)) {
                    let bp = self.bi_probs[start + rel_idx];
                    return ((-(bp as f64) + 5.0) / 27.63) as f32;
                }
            }
        }
        u2.prob + u1.bow
    }
}

#[derive(Debug, Clone)]
pub struct SingleCharCandidate {
    pub class_idx: usize,
    pub label: String,
    pub logit: f32,
    pub prob: f32,
    pub category: u8,
}

#[derive(Debug, Clone)]
pub struct HandwritingEngine {
    sig_norm: [f32; SIG_DIM],
    class_codes: Vec<u32>,
    class_labels: Vec<String>,
    class_priors: Vec<f32>,
    cat_ranges: [(usize, usize); 6],
    layers: Vec<ConvLayer>,
    lm: LanguageModel,
}

impl HandwritingEngine {
    /// Local bigram prior for the incremental decoder. Classifier probabilities
    /// remain visual evidence; no fixture text or document content is used here.
    pub fn incremental_context_score(&self, previous: Option<&str>, next: &str) -> f32 {
        if connected::is_han(next) {
            let mut previous = previous
                .filter(|s| connected::is_han(s))
                .and_then(|s| s.chars().last())
                .map(|c| c.to_string());
            let mut score = 0.0;
            let mut count = 0;
            for c in next.chars() {
                let text = c.to_string();
                score += self.lm.score(previous.as_deref(), &text);
                previous = Some(text);
                count += 1;
            }
            0.28 * score / count as f32
        } else {
            0.0
        }
    }

    pub fn load_default() -> Result<Self, HwrError> {
        let mut candidates = Vec::new();
        if let Ok(dir) = std::env::var("COBOARD_HWR_MODEL_DIR") {
            candidates.push(PathBuf::from(dir));
        }
        candidates.push(PathBuf::from(
            "/Users/admin/Documents/Codex/2026-11-09/https-sogou-cn-top-blogs-1213610385/work/handinput",
        ));
        for dir in candidates {
            let dll_path = dir.join("singleEngine.dll");
            let lm_path = dir.join("lm_HW_PB_7000_kn.arpa.7e9.prune.1e-7.lm.fixed");
            if dll_path.is_file() && lm_path.is_file() {
                return Self::from_files(&dll_path, &lm_path);
            }
        }
        Err(HwrError::ModelUnavailable(
            "未找到本地离线手写模型文件，可通过 COBOARD_HWR_MODEL_DIR 指定目录".into(),
        ))
    }

    pub fn from_files(dll_path: &Path, lm_path: &Path) -> Result<Self, HwrError> {
        let dll_bytes = fs::read(dll_path)
            .map_err(|e| HwrError::ModelUnavailable(format!("读取分类模型失败: {e}")))?;
        let lm_bytes = fs::read(lm_path)
            .map_err(|e| HwrError::ModelUnavailable(format!("读取语言模型失败: {e}")))?;
        Self::from_bytes(&dll_bytes, &lm_bytes)
    }

    pub fn from_bytes(dll_bytes: &[u8], lm_bytes: &[u8]) -> Result<Self, HwrError> {
        let sections = parse_pe_sections(dll_bytes)?;
        let va_to_off = |va: usize| -> Result<usize, HwrError> {
            let rva = va
                .checked_sub(IMAGE_BASE)
                .ok_or_else(|| HwrError::InvalidModel("VA below image base".into()))?;
            for &(s_rva, s_span, s_off) in &sections {
                if rva >= s_rva && rva < s_rva + s_span {
                    return Ok(s_off + (rva - s_rva));
                }
            }
            Err(HwrError::InvalidModel(format!(
                "VA 0x{va:x} not in PE sections"
            )))
        };

        let sig_vec = read_f32_slice(dll_bytes, va_to_off(0x1002_0ec8)?, SIG_DIM)?;
        let mut sig_norm = [1.0f32; SIG_DIM];
        sig_norm.copy_from_slice(&sig_vec);

        let code_off = va_to_off(0x1002_0f08)?;
        let mut class_codes = Vec::with_capacity(NUM_CLASSES);
        let mut class_labels = Vec::with_capacity(NUM_CLASSES);
        for i in 0..NUM_CLASSES {
            let code = read_u32_le(dll_bytes, code_off + i * 4)?;
            class_codes.push(code);
            class_labels.push(decode_class_code(code));
        }

        let cat_off = va_to_off(0x1002_0e74)?;
        let mut cat_ranges = [(0usize, 0usize); 6];
        for (i, item) in cat_ranges.iter_mut().enumerate() {
            let lo = read_i32_le(dll_bytes, cat_off + i * 8)?.max(0) as usize;
            let hi = read_i32_le(dll_bytes, cat_off + i * 8 + 4)?.max(0) as usize;
            *item = (lo, hi);
        }

        type LayerSpec = (
            usize,
            usize,
            usize,
            usize,
            f32,
            bool,
            usize,
            usize,
            Option<usize>,
        );
        let specs: [LayerSpec; 9] = [
            (3, 2, 15, 40, 0.0, true, 0x100d_4558, 0x1003_e660, None),
            (
                2,
                2,
                40,
                40,
                0.0,
                true,
                0x1006_6f58,
                0x1003_de40,
                Some(0x1003_dbc0),
            ),
            (
                2,
                2,
                40,
                80,
                0.0,
                true,
                0x100a_8958,
                0x1003_da80,
                Some(0x1003_dee0),
            ),
            (
                2,
                2,
                80,
                120,
                0.0,
                true,
                0x100e_32d8,
                0x1003_f0d8,
                Some(0x1003_e700),
            ),
            (2, 2, 120, 160, 0.0, true, 0x100a_ed58, 0x1003_e3e0, None),
            (2, 1, 160, 200, 0.0, true, 0x1006_a158, 0x1003_d760, None),
            (1, 1, 200, 100, 0.1, true, 0x100d_6f88, 0x1003_ef48, None),
            (1, 1, 100, 50, 0.0, false, 0x100e_0bc8, 0x1003_ee80, None),
            (
                1,
                1,
                50,
                NUM_CLASSES,
                0.0,
                false,
                0x100f_5ed8,
                0x1003_f2b8,
                None,
            ),
        ];

        let mut layers = Vec::with_capacity(9);
        let mut side = GRID_SIDE;
        for (k, pool, cin, cout, drop, relu, w_va, b_va, n_va) in specs {
            let w_count = k * k * cin * cout;
            let weights = read_i16_scaled_slice(dll_bytes, va_to_off(w_va)?, w_count, 1.0 / 128.0)?;
            let biases = read_f32_slice(dll_bytes, va_to_off(b_va)?, cout)?;
            let null_bias = match n_va {
                Some(va) => Some(read_f32_slice(dll_bytes, va_to_off(va)?, k * k * cout)?),
                None => None,
            };
            let conv_side = side - k + 1;
            let pool_side = conv_side / pool;
            layers.push(ConvLayer {
                k,
                pool,
                cin,
                cout,
                drop,
                relu,
                conv_side,
                pool_side,
                weights,
                biases,
                null_bias,
            });
            side = pool_side;
        }

        let lm = LanguageModel::from_bytes(lm_bytes)?;
        let class_priors = class_labels
            .iter()
            .map(|label| {
                if connected::is_han(label) {
                    // Weak, bounded unigram prior; rare characters remain available
                    // when their visual evidence outweighs the prior.
                    (0.09 * lm.score(None, label)).clamp(-0.9, 0.0)
                } else {
                    0.0
                }
            })
            .collect();

        Ok(Self {
            sig_norm,
            class_codes,
            class_labels,
            class_priors,
            cat_ranges,
            layers,
            lm,
        })
    }

    fn category_of(&self, idx: usize) -> u8 {
        for (cat_id, &(lo, hi)) in self.cat_ranges.iter().enumerate() {
            if idx >= lo && idx <= hi {
                return cat_id as u8;
            }
        }
        5
    }

    pub fn recognize_single_top10(
        &self,
        strokes: &[Vec<[f32; 2]>],
    ) -> Result<Vec<SingleCharCandidate>, HwrError> {
        self.recognize_single_at_phase(strokes, [0.0, 0.0])
    }

    /// Use the primary phase for confident glyphs, otherwise average four phases.
    /// Every view sees the same ink; this does not select a view using target text.
    pub fn recognize_incremental_glyph(
        &self,
        strokes: &[incremental::Stroke],
    ) -> Result<Vec<incremental::GlyphCandidate>, HwrError> {
        let primary = self.recognize_single_at_phase(strokes, [0.0, 0.0])?;
        if primary.first().is_some_and(|c| c.prob >= 0.85) {
            return Ok(primary
                .into_iter()
                .map(|c| incremental::GlyphCandidate {
                    text: c.label,
                    probability: c.prob,
                })
                .collect());
        }
        let mut scores: HashMap<String, f32> = primary
            .into_iter()
            .map(|c| (c.label, c.prob * 0.7))
            .collect();
        for (phase, weight) in [([0.5, 0.0], 0.1), ([0.0, 0.5], 0.1), ([0.5, 0.5], 0.1)] {
            for candidate in self.recognize_single_at_phase(strokes, phase)? {
                *scores.entry(candidate.label).or_default() += candidate.prob * weight;
            }
        }
        let mut candidates: Vec<_> = scores
            .into_iter()
            .map(|(text, probability)| incremental::GlyphCandidate { text, probability })
            .collect();
        candidates.sort_by(|a, b| {
            b.probability
                .total_cmp(&a.probability)
                .then_with(|| a.text.cmp(&b.text))
        });
        candidates.truncate(10);
        Ok(candidates)
    }

    /// One or several pen-downs may contain several Han characters or Latin letters.
    /// Temporal and spatial lattices share a bounded fragment inference cache.
    pub fn recognize_incremental_segment(
        &self,
        strokes: &[incremental::Stroke],
    ) -> Result<Vec<incremental::GlyphCandidate>, incremental::DecodeError> {
        let mut candidates = self
            .recognize_incremental_glyph(strokes)
            .map_err(|e| incremental::DecodeError::Classifier(e.to_string()))?;
        // Temporal scripts share 300 intervals; multi-pen spatial fallback adds
        // at most 300. Keys include every point and pen boundary, since a loop
        // may revisit endpoints. No fragment survives this segment recognition.
        let mut fragments: HashMap<Vec<[u32; 2]>, FragmentScores> = HashMap::new();
        let mut classify = |s: &[incremental::Stroke]| {
            let key: Vec<_> = s
                .iter()
                .flat_map(|stroke| {
                    std::iter::once([u32::MAX, stroke.len() as u32])
                        .chain(stroke.iter().map(|p| [p[0].to_bits(), p[1].to_bits()]))
                })
                .collect();
            if let Some(value) = fragments.get(&key) {
                return Ok(value.clone());
            }
            let logits = self
                .infer_logits(s, [0.0, 0.0])
                .map_err(|e| incremental::DecodeError::Classifier(e.to_string()))?;
            let convert = |v: Vec<SingleCharCandidate>| {
                v.into_iter()
                    .map(|c| incremental::GlyphCandidate {
                        text: c.label,
                        probability: c.prob,
                    })
                    .collect::<Vec<_>>()
            };
            let value = FragmentScores {
                latin: convert(self.rank_logits(&logits, 0x03)),
                mixed: convert(self.rank_logits(&logits, DEFAULT_RANGE_FLAGS)),
            };
            fragments.insert(key, value.clone());
            Ok(value)
        };
        candidates.extend(multipen::recognize(strokes, &mut classify, |s| {
            self.incremental_context_score(None, s)
        })?);
        candidates.extend(connected::recognize(strokes, |s| Ok(classify(s)?.latin))?);
        candidates.extend(connected::recognize_han(
            strokes,
            |s| Ok(classify(s)?.mixed),
            |s| self.incremental_context_score(None, s),
        )?);
        Ok(candidates)
    }

    fn recognize_single_at_phase(
        &self,
        strokes: &[Vec<[f32; 2]>],
        phase: [f32; 2],
    ) -> Result<Vec<SingleCharCandidate>, HwrError> {
        let logits = self.infer_logits(strokes, phase)?;
        Ok(self.rank_logits(&logits, DEFAULT_RANGE_FLAGS))
    }

    fn infer_logits(
        &self,
        strokes: &[Vec<[f32; 2]>],
        phase: [f32; 2],
    ) -> Result<Vec<f32>, HwrError> {
        let norm_strokes = normalize_box_strokes(strokes);
        let (mut grid, mut feats, mut n_sites) = self.extract_features(&norm_strokes, phase)?;
        let mut null_id: i32 = 0;
        // Reuse capacity through the nine layers. Every live slot is initialized
        // before use; feature/grid banks swap after pooling rather than allocate.
        let mut active_windows = Vec::new();
        let mut conv_grid = Vec::new();
        let mut rules = Vec::new();
        let mut mask = Vec::new();
        let mut conv_out = Vec::new();
        let mut p_active = Vec::new();
        let mut pool_grid = Vec::new();
        let mut prules = Vec::new();
        let mut pooled = Vec::new();

        for (li, layer) in self.layers.iter().enumerate() {
            let k = layer.k;
            let kk = k * k;
            let pool = layer.pool;
            let cin = layer.cin;
            let cout = layer.cout;
            let in_side = if li == 0 {
                GRID_SIDE
            } else {
                self.layers[li - 1].pool_side
            };
            let conv_side = layer.conv_side;
            let pool_side = layer.pool_side;

            if layer.drop > 0.0 {
                let scale = 1.0 - layer.drop;
                for v in &mut feats {
                    *v *= scale;
                }
            }

            let mut has_null_conv = false;
            active_windows.clear();
            active_windows.resize(conv_side * conv_side, false);
            for r in 0..conv_side {
                for c in 0..conv_side {
                    let mut any_act = false;
                    for kh in 0..k {
                        for kw in 0..k {
                            if grid[(r + kh) * in_side + (c + kw)] != null_id {
                                any_act = true;
                                break;
                            }
                        }
                        if any_act {
                            break;
                        }
                    }
                    active_windows[r * conv_side + c] = any_act;
                    if !any_act {
                        has_null_conv = true;
                    }
                }
            }

            let n_active = active_windows.iter().filter(|&&b| b).count();
            let (conv_null_id, n_conv_sites) = if has_null_conv {
                (0i32, n_active + 1)
            } else {
                (-1i32, n_active)
            };

            conv_grid.clear();
            conv_grid.resize(conv_side * conv_side, conv_null_id);
            rules.clear();
            rules.resize(n_conv_sites * kk, null_id as usize);
            mask.clear();
            mask.resize(n_conv_sites * kk, false);

            let mut next_id = if has_null_conv { 1usize } else { 0usize };
            for r in 0..conv_side {
                for c in 0..conv_side {
                    if active_windows[r * conv_side + c] {
                        let sid = next_id;
                        next_id += 1;
                        conv_grid[r * conv_side + c] = sid as i32;
                        for kh in 0..k {
                            for kw in 0..k {
                                let ki = kh * k + kw;
                                let in_site = grid[(r + kh) * in_side + (c + kw)];
                                rules[sid * kk + ki] = in_site.max(0) as usize;
                                mask[sid * kk + ki] = in_site != null_id;
                            }
                        }
                    }
                }
            }

            conv_out.clear();
            conv_out.reserve(n_conv_sites * cout);
            for _ in 0..n_conv_sites {
                conv_out.extend_from_slice(&layer.biases);
            }

            for sid in 0..n_conv_sites {
                let out_row = &mut conv_out[sid * cout..(sid + 1) * cout];
                for ki in 0..kk {
                    let is_active = mask[sid * kk + ki];
                    if li == 0 && !is_active {
                        continue;
                    }
                    if (1..=3).contains(&li) && !is_active {
                        if let Some(ref nb) = layer.null_bias {
                            let nb_slice = &nb[ki * cout..(ki + 1) * cout];
                            for (o, &b_val) in out_row.iter_mut().zip(nb_slice.iter()) {
                                *o += b_val;
                            }
                        }
                        continue;
                    }
                    let in_sid = rules[sid * kk + ki];
                    let in_row = &feats[in_sid * cin..(in_sid + 1) * cin];
                    let w_ki = &layer.weights[ki * cin * cout..(ki + 1) * cin * cout];
                    for (ic, &x_val) in in_row.iter().enumerate() {
                        if x_val == 0.0 {
                            continue;
                        }
                        let w_row = &w_ki[ic * cout..(ic + 1) * cout];
                        for (o, &w_val) in out_row.iter_mut().zip(w_row.iter()) {
                            *o += x_val * w_val;
                        }
                    }
                }
            }

            if pool > 1 {
                let pp = pool * pool;
                let mut has_null_pool = false;
                p_active.clear();
                p_active.resize(pool_side * pool_side, false);
                for pr in 0..pool_side {
                    for pc in 0..pool_side {
                        let mut any_p = false;
                        for ph in 0..pool {
                            for pw in 0..pool {
                                if conv_grid[(pr * pool + ph) * conv_side + (pc * pool + pw)]
                                    != conv_null_id
                                {
                                    any_p = true;
                                    break;
                                }
                            }
                            if any_p {
                                break;
                            }
                        }
                        p_active[pr * pool_side + pc] = any_p;
                        if !any_p {
                            has_null_pool = true;
                        }
                    }
                }

                let n_pactive = p_active.iter().filter(|&&b| b).count();
                let (pool_null_id, n_pool_sites) = if has_null_pool {
                    (0i32, n_pactive + 1)
                } else {
                    (-1i32, n_pactive)
                };
                pool_grid.clear();
                pool_grid.resize(pool_side * pool_side, pool_null_id);
                prules.clear();
                prules.resize(n_pool_sites * pp, conv_null_id.max(0) as usize);
                let mut next_pid = if has_null_pool { 1usize } else { 0usize };
                for pr in 0..pool_side {
                    for pc in 0..pool_side {
                        if p_active[pr * pool_side + pc] {
                            let pid = next_pid;
                            next_pid += 1;
                            pool_grid[pr * pool_side + pc] = pid as i32;
                            for ph in 0..pool {
                                for pw in 0..pool {
                                    let pi = ph * pool + pw;
                                    let c_sid =
                                        conv_grid[(pr * pool + ph) * conv_side + (pc * pool + pw)];
                                    prules[pid * pp + pi] = c_sid.max(0) as usize;
                                }
                            }
                        }
                    }
                }

                pooled.clear();
                pooled.resize(n_pool_sites * cout, f32::NEG_INFINITY);
                for pid in 0..n_pool_sites {
                    let dst = &mut pooled[pid * cout..(pid + 1) * cout];
                    for pi in 0..pp {
                        let c_sid = prules[pid * pp + pi];
                        let src = &conv_out[c_sid * cout..(c_sid + 1) * cout];
                        for (d, &s) in dst.iter_mut().zip(src.iter()) {
                            if s > *d {
                                *d = s;
                            }
                        }
                    }
                }
                std::mem::swap(&mut feats, &mut pooled);
                std::mem::swap(&mut grid, &mut pool_grid);
                null_id = pool_null_id;
                n_sites = n_pool_sites;
            } else {
                std::mem::swap(&mut feats, &mut conv_out);
                std::mem::swap(&mut grid, &mut conv_grid);
                null_id = conv_null_id;
                n_sites = n_conv_sites;
            }

            if layer.relu {
                for v in &mut feats {
                    if *v < 0.0 {
                        *v = 0.0;
                    }
                }
            }
        }

        if n_sites == 0 || feats.len() < NUM_CLASSES {
            return Err(HwrError::EmptyInput);
        }
        Ok(feats[..NUM_CLASSES].to_vec())
    }

    fn rank_logits(&self, logits: &[f32], range_flags: u32) -> Vec<SingleCharCandidate> {
        let mut indexed: Vec<(usize, f32)> = Vec::with_capacity(NUM_CLASSES);
        for (idx, &logit) in logits.iter().enumerate() {
            let allowed = (idx < 10 && (range_flags & 0x30) != 0)
                || ((10..62).contains(&idx) && (range_flags & 0x03) != 0)
                || ((62..196).contains(&idx) && (range_flags & 0xc0) != 0)
                || ((205..0x6b11).contains(&idx)
                    && !(0x52b5..=0x5305).contains(&idx)
                    && (range_flags & 0x400) != 0);
            if allowed {
                indexed.push((idx, logit + self.class_priors[idx] / 0.3));
            }
        }
        top_hundred_logits(&mut indexed);

        if indexed.len() >= 3 && self.class_codes[indexed[0].0] == 0xfeff_56d7 {
            for swap_i in 1..=2 {
                if self.class_codes[indexed[swap_i].0] == 0xfeff_53e3 {
                    indexed.swap(0, swap_i);
                    break;
                }
            }
        }

        let blacklist: HashSet<u32> = BLACKLIST_CODES.into_iter().collect();
        let mut top10 = Vec::with_capacity(10);
        for (idx, logit) in indexed {
            let code = self.class_codes[idx];
            if blacklist.contains(&code) {
                continue;
            }
            top10.push((
                idx,
                self.class_labels[idx].clone(),
                logit,
                self.category_of(idx),
            ));
            if top10.len() == 10 {
                break;
            }
        }

        let maximum = top10.first().map_or(0.0, |r| r.2);
        let exps: Vec<f32> = top10
            .iter()
            .map(|r| (0.3 * (r.2 - maximum)).exp())
            .collect();
        let sum_exp: f32 = exps.iter().sum::<f32>().max(1e-12);

        top10
            .into_iter()
            .zip(exps)
            .map(
                |((class_idx, label, logit, category), e)| SingleCharCandidate {
                    class_idx,
                    label,
                    logit,
                    prob: e / sum_exp,
                    category,
                },
            )
            .collect()
    }

    /// Conditional Latin scoring for fragments inside a connected word. This
    /// does not restrict the mixed-script single-character recognition path.
    pub fn recognize_latin_fragment(
        &self,
        strokes: &[incremental::Stroke],
    ) -> Result<Vec<incremental::GlyphCandidate>, HwrError> {
        let logits = self.infer_logits(strokes, [0.0, 0.0])?;
        Ok(self
            .rank_logits(&logits, 0x03)
            .into_iter()
            .map(|c| incremental::GlyphCandidate {
                text: c.label,
                probability: c.prob,
            })
            .collect())
    }

    pub fn recognize_connected_word(
        &self,
        strokes: &[incremental::Stroke],
    ) -> Result<Vec<incremental::GlyphCandidate>, incremental::DecodeError> {
        connected::recognize(strokes, |s| {
            self.recognize_latin_fragment(s)
                .map_err(|e| incremental::DecodeError::Classifier(e.to_string()))
        })
    }

    fn extract_features(
        &self,
        strokes: &[Vec<[f32; 2]>],
        phase: [f32; 2],
    ) -> Result<(Vec<i32>, Vec<f32>, usize), HwrError> {
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        let mut point_count = 0usize;

        for s in strokes {
            for &[x, y] in s {
                if !x.is_finite() || !y.is_finite() {
                    continue;
                }
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
                point_count += 1;
            }
        }
        if point_count == 0 {
            return Err(HwrError::EmptyInput);
        }

        let span = (max_x - min_x).max(max_y - min_y).max(1e-4);
        let scale = 40.0f32 / span;
        let cx = 0.5 * (min_x + max_x);
        let cy = 0.5 * (min_y + max_y);

        let mut grid = vec![0i32; GRID_SIDE * GRID_SIDE];
        let mut feats = vec![0.0f32; SIG_DIM]; // index 0 is null site
        let mut n_sites = 1usize;

        for s in strokes {
            if s.is_empty() {
                continue;
            }
            let norm_pts: Vec<[f32; 2]> = s
                .iter()
                .map(|&[x, y]| [(x - cx) * scale, (y - cy) * scale])
                .collect();
            let coarse = resample_stroke(&norm_pts, 1, 2.0);
            let fine = resample_stroke(&norm_pts, 4, 2.0);
            let nc = coarse.len();
            let mut sigs = vec![[0.0f32; SIG_DIM]; nc];
            for (i, sig_slot) in sigs.iter_mut().enumerate() {
                let i0 = i.saturating_sub(4);
                let i1 = (i + 4).min(nc.saturating_sub(1));
                let mut acc = [0.0f32; SIG_DIM];
                acc[0] = 1.0;
                for k in i0..i1 {
                    let dx = coarse[k + 1][0] - coarse[k][0];
                    let dy = coarse[k + 1][1] - coarse[k][1];
                    acc = chen_combine(&acc, &seg_signature(dx, dy));
                }
                for (a, &n) in acc.iter_mut().zip(self.sig_norm.iter()) {
                    *a /= n;
                }
                *sig_slot = acc;
            }

            for (idx_f, pt) in fine.iter().enumerate() {
                let idx_c = (idx_f / 4).min(nc.saturating_sub(1));
                let gx = grid_coordinate(pt[0] + phase[0]);
                let gy = grid_coordinate(pt[1] + phase[1]);
                let cell = gx * GRID_SIDE + gy;
                if grid[cell] == 0 {
                    grid[cell] = n_sites as i32;
                    n_sites += 1;
                    feats.extend_from_slice(&sigs[idx_c]);
                }
            }
        }

        Ok((grid, feats, n_sites))
    }

    pub fn recognize_line(&self, strokes: &[Vec<[f32; 2]>]) -> Result<RecognitionOutput, HwrError> {
        let start = Instant::now();
        let blocks = group_strokes_into_blocks(strokes);
        if blocks.is_empty() {
            return Err(HwrError::EmptyInput);
        }
        let n_blocks = blocks.len();
        let mut sizes: Vec<f32> = blocks
            .iter()
            .map(|b| (b.max_y - b.min_y).max(b.max_x - b.min_x).max(10.0))
            .collect();
        sizes.sort_by(|a, b| a.total_cmp(b));
        let char_scale = sizes[sizes.len() / 2];

        #[derive(Clone)]
        struct BeamPath {
            norm_score: f32,
            char_score: f32,
            lm_score: f32,
            n_chars: usize,
            text: String,
            last_char: Option<String>,
            last_idx: Option<usize>,
            last_cat: Option<u8>,
        }

        let mut dp: Vec<Vec<BeamPath>> = vec![Vec::new(); n_blocks + 1];
        dp[0].push(BeamPath {
            norm_score: 0.0,
            char_score: 0.0,
            lm_score: 0.0,
            n_chars: 0,
            text: String::new(),
            last_char: None,
            last_idx: None,
            last_cat: None,
        });

        let mut seg_cache: HashMap<(usize, usize), Vec<SingleCharCandidate>> = HashMap::new();

        for end_b in 1..=n_blocks {
            let mut next_paths = Vec::new();
            for span in 1..=3usize {
                if end_b < span {
                    continue;
                }
                let start_b = end_b - span;
                let sub_blocks = &blocks[start_b..end_b];
                if span > 1 {
                    let mut max_gap = f32::NEG_INFINITY;
                    for m in 0..(span - 1) {
                        max_gap = max_gap.max(sub_blocks[m + 1].min_x - sub_blocks[m].max_x);
                    }
                    let total_w = sub_blocks[span - 1].max_x - sub_blocks[0].min_x;
                    if max_gap > char_scale * 0.45 || total_w > char_scale * 1.6 {
                        continue;
                    }
                }

                let cands = if let Some(cached) = seg_cache.get(&(start_b, end_b)) {
                    cached.clone()
                } else {
                    let mut merged = Vec::new();
                    for b in sub_blocks {
                        merged.extend_from_slice(&b.strokes);
                    }
                    let computed = self.recognize_single_top10(&merged)?;
                    seg_cache.insert((start_b, end_b), computed.clone());
                    computed
                };
                if cands.is_empty() {
                    continue;
                }

                let gap_before = if start_b > 0 {
                    sub_blocks[0].min_x - blocks[start_b - 1].max_x
                } else {
                    0.0
                };
                let insert_space = start_b > 0 && gap_before > char_scale * 0.45;
                let top_prob = cands[0].prob;

                for (rank, cand) in cands.iter().take(6).enumerate() {
                    if rank > 0 && cand.prob < top_prob - 0.8 {
                        continue;
                    }
                    for prev in &dp[start_b] {
                        let mut cs = prev.char_score + cand.prob.max(1e-6).ln() * (span as f32);
                        if cand.category <= 2 {
                            cs += 0.35;
                        }
                        if cand.class_idx == 0xe89 {
                            cs += 0.25;
                        }
                        let new_nc = prev.n_chars + 1;
                        if new_nc > 1 && cand.category == 3 {
                            cs -= 0.30;
                        }
                        if let (Some(p_idx), Some(p_cat)) = (prev.last_idx, prev.last_cat) {
                            if (p_idx == 0xe89 && cand.class_idx == 0xe8f)
                                || (p_idx == 0xe8f && cand.class_idx == 0xe89)
                                || (p_idx == 0xe89 && cand.class_idx == 0xe89)
                            {
                                cs -= 0.40;
                            }
                            if p_idx == 0xe89 && cand.category <= 3 {
                                cs -= 0.40;
                            }
                            if p_idx == 0xe89 && cand.category == 5 {
                                cs += 0.40;
                            }
                            if p_cat == 3 && cand.category == 3 {
                                cs -= 0.40;
                            }
                            if p_cat <= 2 && cand.category == p_cat {
                                cs += 0.60;
                            } else if p_cat <= 2 && cand.category <= 2 {
                                cs += 0.25;
                            }
                        }

                        let lm_s = if cand.category == 5 {
                            let prev_cn = if prev.last_cat == Some(5) {
                                prev.last_char.as_deref()
                            } else {
                                None
                            };
                            prev.lm_score + self.lm.score(prev_cn, &cand.label)
                        } else {
                            let bonus = if prev.last_cat.is_some_and(|c| c <= 2) {
                                -2.0
                            } else {
                                -3.0
                            };
                            prev.lm_score + bonus
                        };

                        if end_b == n_blocks && new_nc == 1 {
                            cs += 0.40;
                            if cand.category == 5 {
                                cs += 0.20;
                            }
                        }

                        let total_norm = (cs + 0.18 * lm_s) / (end_b as f32);
                        let sep = if insert_space
                            && !prev.text.is_empty()
                            && (prev.last_cat.is_some_and(|c| c <= 2) || cand.category <= 2)
                        {
                            " "
                        } else {
                            ""
                        };

                        let out_ch = if cand.category == 2
                            && prev.last_cat == Some(1)
                            && !insert_space
                            && matches!(
                                cand.label.as_str(),
                                "p" | "c" | "o" | "s" | "u" | "v" | "w" | "x" | "z"
                            ) {
                            cand.label.to_uppercase()
                        } else {
                            cand.label.clone()
                        };
                        let eff_cat = if out_ch.chars().all(|ch| ch.is_ascii_uppercase()) {
                            1
                        } else {
                            cand.category
                        };

                        next_paths.push(BeamPath {
                            norm_score: total_norm,
                            char_score: cs,
                            lm_score: lm_s,
                            n_chars: new_nc,
                            text: format!("{}{}{}", prev.text, sep, out_ch),
                            last_char: Some(out_ch),
                            last_idx: Some(cand.class_idx),
                            last_cat: Some(eff_cat),
                        });
                    }
                }
            }

            next_paths.sort_by(|a, b| b.norm_score.total_cmp(&a.norm_score));
            let mut seen = HashSet::new();
            let mut dedup = Vec::with_capacity(12);
            for p in next_paths {
                if seen.insert(p.text.clone()) {
                    dedup.push(p);
                    if dedup.len() == 12 {
                        break;
                    }
                }
            }
            dp[end_b] = dedup;
        }

        let candidates = dp[n_blocks]
            .iter()
            .take(5)
            .map(|p| RecognitionCandidate {
                text: p.text.clone(),
                score: p.norm_score,
            })
            .collect();

        Ok(RecognitionOutput {
            candidates,
            elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }
}

#[derive(Clone)]
struct StrokeBlock {
    strokes: Vec<Vec<[f32; 2]>>,
    min_x: f32,
    max_x: f32,
    min_y: f32,
    max_y: f32,
}

fn group_strokes_into_blocks(strokes: &[Vec<[f32; 2]>]) -> Vec<StrokeBlock> {
    let mut blocks: Vec<StrokeBlock> = Vec::new();
    for s in strokes {
        if s.is_empty() {
            continue;
        }
        let mut min_x = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        for &[x, y] in s {
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }
        if let Some(prev) = blocks.last_mut() {
            let inter_x = prev.max_x.min(max_x) - prev.min_x.max(min_x);
            let min_w = (prev.max_x - prev.min_x)
                .max(1.0)
                .min((max_x - min_x).max(1.0));
            if inter_x / min_w > 0.05 || inter_x > 0.0 {
                prev.strokes.push(s.clone());
                prev.min_x = prev.min_x.min(min_x);
                prev.max_x = prev.max_x.max(max_x);
                prev.min_y = prev.min_y.min(min_y);
                prev.max_y = prev.max_y.max(max_y);
                continue;
            }
        }
        blocks.push(StrokeBlock {
            strokes: vec![s.clone()],
            min_x,
            max_x,
            min_y,
            max_y,
        });
    }
    blocks
}

fn grid_coordinate(value: f32) -> usize {
    // Normalization of translated/scaled input can straddle an exact cell edge
    // by a few float ULPs. Snap only this numerical noise, preserving floor elsewhere.
    let cell = value as f64 + 48.0;
    let nearest = cell.round();
    let stable = if (cell - nearest).abs() < 1e-4 {
        nearest
    } else {
        cell
    };
    (stable as i32).clamp(0, 95) as usize
}

fn seg_signature(dx: f32, dy: f32) -> [f32; SIG_DIM] {
    let mut s = [0.0f32; SIG_DIM];
    s[0] = 1.0;
    s[1] = dx;
    s[2] = dy;
    s[3] = 0.5 * dx * dx;
    s[4] = 0.5 * dx * dy;
    s[5] = 0.5 * dy * dx;
    s[6] = 0.5 * dy * dy;
    let c = 1.0f32 / 3.0f32;
    for i in 0..4 {
        s[7 + i] = c * dx * s[3 + i];
        s[11 + i] = c * dy * s[3 + i];
    }
    s
}

fn chen_combine(a: &[f32; SIG_DIM], b: &[f32; SIG_DIM]) -> [f32; SIG_DIM] {
    let mut out = *a;
    for i in 0..4 {
        out[7 + i] += a[1] * b[3 + i];
        out[11 + i] += a[2] * b[3 + i];
        out[7 + 2 * i] += a[3 + i] * b[1];
        out[7 + 2 * i + 1] += a[3 + i] * b[2];
    }
    for i in 7..15 {
        out[i] += a[0] * b[i];
    }
    out[3] += a[1] * b[1];
    out[4] += a[1] * b[2];
    out[5] += a[2] * b[1];
    out[6] += a[2] * b[2];
    for i in 3..7 {
        out[i] += a[0] * b[i];
    }
    out[1] += a[0] * b[1];
    out[2] += a[0] * b[2];
    out
}

fn resample_stroke(pts: &[[f32; 2]], factor: usize, step: f32) -> Vec<[f32; 2]> {
    let n = pts.len();
    if n == 0 {
        return Vec::new();
    }
    let mut cum = vec![0.0f32; n];
    for i in 1..n {
        let dx = (pts[i][0] - pts[i - 1][0]) as f64;
        let dy = (pts[i][1] - pts[i - 1][1]) as f64;
        cum[i] = (cum[i - 1] as f64 + (dx * dx + dy * dy).sqrt()) as f32;
    }
    let total = cum[n - 1];
    let m = (((total / step) as f64 + 0.5) as usize) * factor;
    let mut out = Vec::with_capacity(m + 1);
    out.push(pts[0]);
    let mut ecx = 0usize;
    for edx in 1..=m {
        while ecx + 1 < n && (m as f32) * cum[ecx + 1] < (edx as f32) * total {
            ecx += 1;
        }
        if ecx + 1 >= n {
            out.push(pts[n - 1]);
        } else {
            let t = ((edx as f32) * total) / (m as f32);
            let denom = cum[ecx + 1] - cum[ecx];
            if denom == 0.0 {
                out.push(pts[ecx]);
            } else {
                let w0 = (cum[ecx + 1] - t) / denom;
                let w1 = 1.0 - w0;
                out.push([
                    w0 * pts[ecx][0] + w1 * pts[ecx + 1][0],
                    w0 * pts[ecx][1] + w1 * pts[ecx + 1][1],
                ]);
            }
        }
    }
    out
}

fn parse_pe_sections(bytes: &[u8]) -> Result<Vec<(usize, usize, usize)>, HwrError> {
    if bytes.len() < 0x40 || &bytes[0..2] != b"MZ" {
        return Err(HwrError::InvalidModel("Not a valid PE binary".into()));
    }
    let pe_off = read_u32_le(bytes, 0x3c)? as usize;
    if bytes.len() < pe_off + 24 || &bytes[pe_off..pe_off + 4] != b"PE\0\0" {
        return Err(HwrError::InvalidModel("Missing PE signature".into()));
    }
    let num_sections = read_u16_le(bytes, pe_off + 6)? as usize;
    let opt_hdr_sz = read_u16_le(bytes, pe_off + 20)? as usize;
    let sec_table = pe_off + 24 + opt_hdr_sz;
    let mut out = Vec::with_capacity(num_sections);
    for i in 0..num_sections {
        let off = sec_table + i * 40;
        if bytes.len() < off + 40 {
            return Err(HwrError::InvalidModel("Truncated section header".into()));
        }
        let vsize = read_u32_le(bytes, off + 8)? as usize;
        let rva = read_u32_le(bytes, off + 12)? as usize;
        let rawsize = read_u32_le(bytes, off + 16)? as usize;
        let rawptr = read_u32_le(bytes, off + 20)? as usize;
        out.push((rva, vsize.max(rawsize), rawptr));
    }
    Ok(out)
}

fn decode_class_code(code: u32) -> String {
    let hi = ((code >> 16) & 0xffff) as u16;
    let lo = (code & 0xffff) as u16;
    if hi == 0xfeff {
        String::from_utf16_lossy(&[lo])
    } else {
        String::from_utf16_lossy(&[hi, lo])
    }
}

fn align4(n: usize) -> usize {
    (n + 3) & !3
}

fn read_u16_le(bytes: &[u8], off: usize) -> Result<u16, HwrError> {
    let slice = bytes
        .get(off..off + 2)
        .ok_or_else(|| HwrError::InvalidModel("Unexpected EOF reading u16".into()))?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32_le(bytes: &[u8], off: usize) -> Result<u32, HwrError> {
    let slice = bytes
        .get(off..off + 4)
        .ok_or_else(|| HwrError::InvalidModel("Unexpected EOF reading u32".into()))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_i32_le(bytes: &[u8], off: usize) -> Result<i32, HwrError> {
    let slice = bytes
        .get(off..off + 4)
        .ok_or_else(|| HwrError::InvalidModel("Unexpected EOF reading i32".into()))?;
    Ok(i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_f32_slice(bytes: &[u8], off: usize, count: usize) -> Result<Vec<f32>, HwrError> {
    let byte_len = count
        .checked_mul(4)
        .ok_or_else(|| HwrError::InvalidModel("f32 slice overflow".into()))?;
    let slice = bytes
        .get(off..off + byte_len)
        .ok_or_else(|| HwrError::InvalidModel("Unexpected EOF reading f32 slice".into()))?;
    let mut out = Vec::with_capacity(count);
    for &chunk in slice.as_chunks::<4>().0 {
        out.push(f32::from_le_bytes(chunk));
    }
    Ok(out)
}

fn read_i16_scaled_slice(
    bytes: &[u8],
    off: usize,
    count: usize,
    scale: f32,
) -> Result<Vec<f32>, HwrError> {
    let byte_len = count
        .checked_mul(2)
        .ok_or_else(|| HwrError::InvalidModel("i16 slice overflow".into()))?;
    let slice = bytes
        .get(off..off + byte_len)
        .ok_or_else(|| HwrError::InvalidModel("Unexpected EOF reading i16 slice".into()))?;
    let mut out = Vec::with_capacity(count);
    for &chunk in slice.as_chunks::<2>().0 {
        let v = i16::from_le_bytes(chunk);
        out.push((v as f32) * scale);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_logit_selection_matches_full_sort_with_ties() {
        for length in [0, 52, 100, 101, NUM_CLASSES] {
            let mut actual: Vec<_> = (0..length)
                .map(|i| (i, ((i * 7919) % 997) as f32 / 100.0))
                .collect();
            let mut expected = actual.clone();
            // The previous stable sort preserved class order on ties.
            expected.sort_by(|a, b| b.1.total_cmp(&a.1));
            expected.truncate(100);
            top_hundred_logits(&mut actual);
            assert_eq!(actual, expected);
        }
    }

    #[derive(Deserialize)]
    struct PointJson {
        x: f32,
        y: f32,
    }

    #[derive(Deserialize)]
    struct StrokeAttrsJson {
        position: PointJson,
        points: Vec<PointJson>,
    }

    #[derive(Deserialize)]
    struct FixtureJson {
        name: String,
        expected: String,
        strokes: Vec<(String, StrokeAttrsJson)>,
    }

    #[test]
    fn evaluates_coboard_handwriting_fixtures_when_model_present() {
        let Ok(engine) = HandwritingEngine::load_default() else {
            return;
        };
        let fixtures_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/coboard-desktop/scripts/handwriting-fixtures.json");
        let Ok(raw) = fs::read_to_string(&fixtures_path) else {
            return;
        };
        let Ok(fixtures) = serde_json::from_str::<Vec<FixtureJson>>(&raw) else {
            return;
        };

        for fix in &fixtures {
            let strokes: Vec<Vec<[f32; 2]>> = fix
                .strokes
                .iter()
                .map(|(_, s)| {
                    s.points
                        .iter()
                        .map(|p| [s.position.x + p.x, s.position.y + p.y])
                        .collect()
                })
                .collect();

            let res = engine.recognize_line(&strokes);
            assert!(res.is_ok(), "recognition failed for {}", fix.name);
            if let Ok(out) = res {
                println!(
                    "[coboard-vision-ml] fixture={} expected={:?} top1={:?} elapsed_ms={:.2}",
                    fix.name,
                    fix.expected,
                    out.candidates.first().map(|c| &c.text),
                    out.elapsed_ms
                );
                assert_eq!(
                    out.candidates.first().map(|c| c.text.as_str()),
                    Some(fix.expected.as_str()),
                    "top-1 mismatch on fixture {}",
                    fix.name
                );
            }
        }
    }
}
