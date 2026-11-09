//! Bounded per-window recognition sessions. The desktop serializes access on a
//! background worker; document state and persistence never enter this module.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    HandwritingEngine, RecognitionCandidate,
    incremental::{DecodeError, GlyphCandidate, IncrementalDecoder, Stroke},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct InkStroke {
    pub id: String,
    pub points: Stroke,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IncrementalRequest {
    pub session_id: String,
    pub sequence: u64,
    /// Replace the suffix starting here; the normal append case sends one new stroke.
    pub from: usize,
    pub strokes: Vec<InkStroke>,
}

#[derive(Clone, Debug, Serialize)]
pub struct IncrementalResponse {
    pub session_id: String,
    pub sequence: u64,
    pub stroke_ids: Vec<String>,
    pub candidates: Vec<RecognitionCandidate>,
    pub stable_stroke_ids: Vec<String>,
    pub stable_text: String,
    pub elapsed_ms: f64,
    pub classifier_calls: usize,
    pub cache_hits: usize,
}

#[derive(Debug, Error)]
pub enum RecognitionError {
    #[error("笔迹无效或超出单行识别上限，已保留笔迹")]
    InvalidInput,
    #[error("识别会话已变化，请重新识别")]
    SequenceConflict,
    #[error("本地手写模型尚未准备好，已保留笔迹")]
    ModelUnavailable,
    #[error(transparent)]
    Decode(#[from] DecodeError),
}

struct InkSession {
    id: String,
    sequence: u64,
    strokes: Vec<InkStroke>,
    decoder: IncrementalDecoder,
    last_request: Option<IncrementalRequest>,
    last_response: Option<IncrementalResponse>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

impl InkSession {
    fn new(id: &str) -> Self {
        Self {
            id: id.into(),
            sequence: 0,
            strokes: Vec::new(),
            decoder: IncrementalDecoder::default(),
            last_request: None,
            last_response: None,
        }
    }

    fn apply<F, C>(
        &mut self,
        request: &IncrementalRequest,
        classify: F,
        context: C,
    ) -> Result<IncrementalResponse, RecognitionError>
    where
        F: FnMut(&[Stroke]) -> Result<Vec<GlyphCandidate>, DecodeError>,
        C: Fn(Option<&str>, &str) -> f32,
    {
        if self.last_request.as_ref() == Some(request) {
            return self
                .last_response
                .clone()
                .ok_or(RecognitionError::SequenceConflict);
        }
        if request.session_id != self.id
            || request.sequence
                != self
                    .sequence
                    .checked_add(1)
                    .ok_or(RecognitionError::SequenceConflict)?
            || request.from > self.strokes.len()
        {
            return Err(RecognitionError::SequenceConflict);
        }
        if !valid_id(&request.session_id)
            || request.from > 128
            || request.strokes.len() > 128 - request.from
        {
            return Err(RecognitionError::InvalidInput);
        }
        let mut staged = self.strokes[..request.from].to_vec();
        staged.extend(request.strokes.iter().cloned());
        let mut ids = HashSet::new();
        if staged.is_empty()
            || staged.iter().map(|s| s.points.len()).sum::<usize>() > 32_768
            || staged.iter().any(|s| {
                !valid_id(&s.id)
                    || !ids.insert(s.id.as_str())
                    || s.points.is_empty()
                    || s.points
                        .iter()
                        .flatten()
                        .any(|v| !v.is_finite() || v.abs() > 1e7)
            })
        {
            return Err(RecognitionError::InvalidInput);
        }
        let points: Vec<Stroke> = staged.iter().map(|s| s.points.clone()).collect();
        let output = self
            .decoder
            .update_with_context(&points, classify, context)?;
        let response = IncrementalResponse {
            session_id: self.id.clone(),
            sequence: request.sequence,
            stroke_ids: staged.iter().map(|s| s.id.clone()).collect(),
            candidates: output
                .candidates
                .into_iter()
                .map(|c| RecognitionCandidate {
                    text: c.text,
                    score: c.score,
                })
                .collect(),
            stable_stroke_ids: output
                .stable_stroke_indices
                .iter()
                .map(|&i| staged[i].id.clone())
                .collect(),
            stable_text: output.stable_text,
            elapsed_ms: output.elapsed_ms,
            classifier_calls: output.classifier_calls,
            cache_hits: output.cache_hits,
        };
        self.sequence = request.sequence;
        self.strokes = staged;
        self.last_request = Some(request.clone());
        self.last_response = Some(response.clone());
        Ok(response)
    }
}

#[derive(Default)]
pub struct HandwritingRecognizer {
    engine: Option<HandwritingEngine>,
    /// A new session replaces the previous one for this window, rather than adding
    /// an unbounded entry for every cancel or conversion.
    sessions: HashMap<String, InkSession>,
}

impl HandwritingRecognizer {
    pub fn recognize(
        &mut self,
        window: &str,
        request: &IncrementalRequest,
    ) -> Result<IncrementalResponse, RecognitionError> {
        if !valid_id(&request.session_id)
            || request.sequence == 0
            || request.from > 128
            || request.strokes.len() > 128 - request.from
        {
            return Err(RecognitionError::InvalidInput);
        }
        if self.engine.is_none() {
            self.engine = Some(
                HandwritingEngine::load_default()
                    .map_err(|_| RecognitionError::ModelUnavailable)?,
            );
        }
        let engine = self
            .engine
            .as_ref()
            .ok_or(RecognitionError::ModelUnavailable)?;
        let classify = |strokes: &[Stroke]| engine.recognize_incremental_segment(strokes);
        let context = |p: Option<&str>, n: &str| engine.incremental_context_score(p, n);
        if let Some(session) = self
            .sessions
            .get_mut(window)
            .filter(|s| s.id == request.session_id)
        {
            session.apply(request, classify, context)
        } else {
            if request.sequence != 1
                || request.from != 0
                || (!self.sessions.contains_key(window) && self.sessions.len() >= 8)
            {
                return Err(RecognitionError::SequenceConflict);
            }
            let mut session = InkSession::new(&request.session_id);
            let response = session.apply(request, classify, context)?;
            self.sessions.insert(window.into(), session);
            Ok(response)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stroke(id: &str, x: f32) -> InkStroke {
        InkStroke {
            id: id.into(),
            points: vec![[x, 0.0], [x, 60.0]],
        }
    }
    fn classify(_: &[Stroke]) -> Result<Vec<GlyphCandidate>, DecodeError> {
        Ok(vec![GlyphCandidate {
            text: "I".into(),
            probability: 0.99,
        }])
    }
    #[test]
    fn append_reuses_cache_and_lost_ack_retry_is_idempotent() {
        let mut session = InkSession::new("session");
        let mut request = IncrementalRequest {
            session_id: "session".into(),
            sequence: 1,
            from: 0,
            strokes: vec![stroke("a", 0.0)],
        };
        session.apply(&request, classify, |_, _| 0.0).unwrap();
        request.sequence = 2;
        request.from = 1;
        request.strokes = vec![stroke("b", 100.0)];
        let out = session.apply(&request, classify, |_, _| 0.0).unwrap();
        assert_eq!(out.classifier_calls, 1);
        assert_eq!(out.cache_hits, 1);
        let retry = session
            .apply(
                &request,
                |_| panic!("retry must not run inference"),
                |_, _| 0.0,
            )
            .unwrap();
        assert_eq!(retry.stroke_ids, vec!["a", "b"]);
        request.strokes[0].id = "other".into();
        assert!(matches!(
            session.apply(&request, classify, |_, _| 0.0),
            Err(RecognitionError::SequenceConflict)
        ));
    }
    #[test]
    fn failure_does_not_consume_sequence_and_suffix_replacement_maps_ink_ids() {
        let mut session = InkSession::new("s");
        let mut request = IncrementalRequest {
            session_id: "s".into(),
            sequence: 1,
            from: 0,
            strokes: vec![stroke("a", 0.0)],
        };
        session.apply(&request, classify, |_, _| 0.0).unwrap();
        request.sequence = 2;
        request.strokes = vec![stroke("replacement", 100.0)];
        assert!(
            session
                .apply(
                    &request,
                    |_| Err(DecodeError::Classifier("test".into())),
                    |_, _| 0.0
                )
                .is_err()
        );
        let out = session.apply(&request, classify, |_, _| 0.0).unwrap();
        assert_eq!(out.stroke_ids, vec!["replacement"]);
        request.sequence = 3;
        request.from = 1;
        request.strokes = vec![stroke("replacement", 200.0)];
        assert!(matches!(
            session.apply(&request, classify, |_, _| 0.0),
            Err(RecognitionError::InvalidInput)
        ));
        assert_eq!(session.sequence, 2);
    }

    #[test]
    #[ignore = "requires local research model; pen lifts are development transforms, not independent ink"]
    fn native_model_replays_resumed_multipen_words_with_original_ids() {
        #[derive(Deserialize)]
        struct Sample {
            expected: String,
            strokes: Vec<Stroke>,
        }
        let samples: Vec<Sample> = serde_json::from_str(include_str!(
            "../../../research/handwriting/connected-fixtures.json"
        ))
        .unwrap();
        let mut recognizer = HandwritingRecognizer::default();
        for (index, sample) in samples.iter().enumerate() {
            for pens in [2, 3] {
                let source = &sample.strokes[0];
                let strokes: Vec<_> = (0..pens)
                    .map(|part| {
                        let start =
                            (source.len() as f64 * part as f64 / pens as f64).round() as usize;
                        let end = ((source.len() as f64 * (part + 1) as f64 / pens as f64).round()
                            as usize)
                            .min(source.len() - 1);
                        InkStroke {
                            id: format!("pen-{part}"),
                            points: source[start..=end].to_vec(),
                        }
                    })
                    .collect();
                let request = IncrementalRequest {
                    session_id: format!("multi-{index}-{pens}"),
                    sequence: 1,
                    from: 0,
                    strokes,
                };
                let response = recognizer.recognize("test", &request).unwrap();
                assert_eq!(response.candidates[0].text, sample.expected);
                assert_eq!(
                    response.stroke_ids,
                    request
                        .strokes
                        .iter()
                        .map(|s| s.id.clone())
                        .collect::<Vec<_>>()
                );
                assert_eq!(recognizer.sessions["test"].strokes, request.strokes);
                let retry = recognizer.recognize("test", &request).unwrap();
                assert_eq!(
                    serde_json::to_value(response).unwrap(),
                    serde_json::to_value(retry).unwrap()
                );
            }
        }
    }

    #[test]
    #[ignore = "requires local research model; explicit development regression"]
    fn native_model_replays_connected_word_through_desktop_session() {
        #[derive(Deserialize)]
        struct Sample {
            expected: String,
            strokes: Vec<Stroke>,
        }
        let samples: Vec<Sample> = serde_json::from_str(include_str!(
            "../../../research/handwriting/connected-fixtures.json"
        ))
        .unwrap();
        let mut recognizer = HandwritingRecognizer::default();
        for (i, sample) in samples.iter().enumerate() {
            let request = IncrementalRequest {
                session_id: format!("word-{i}"),
                sequence: 1,
                from: 0,
                strokes: sample
                    .strokes
                    .iter()
                    .enumerate()
                    .map(|(j, points)| InkStroke {
                        id: format!("ink-{j}"),
                        points: points.clone(),
                    })
                    .collect(),
            };
            let response = recognizer.recognize("test", &request).unwrap();
            assert_eq!(response.candidates[0].text, sample.expected);
            assert_eq!(response.stroke_ids, ["ink-0"]);
            assert_eq!(recognizer.sessions["test"].strokes, request.strokes);
            let retry = recognizer.recognize("test", &request).unwrap();
            assert_eq!(
                serde_json::to_value(response).unwrap(),
                serde_json::to_value(retry).unwrap()
            );
        }
    }
}
