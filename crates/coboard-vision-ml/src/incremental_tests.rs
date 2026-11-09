use super::incremental::*;

fn vertical(x: f32) -> Stroke {
    vec![[x, 0.0], [x, 60.0]]
}

fn single(text: &str) -> Vec<GlyphCandidate> {
    vec![GlyphCandidate {
        text: text.into(),
        probability: 0.95,
    }]
}

#[test]
fn reuses_scores_and_invalidates_replaced_and_removed_strokes() {
    let mut decoder = IncrementalDecoder::default();
    let mut strokes = vec![vertical(0.0)];
    decoder.update(&strokes, |_| Ok(single("I"))).unwrap();
    strokes.push(vertical(100.0));
    let out = decoder.update(&strokes, |_| Ok(single("I"))).unwrap();
    assert_eq!(out.classifier_calls, 1);
    assert_eq!(out.cache_hits, 1);
    assert_eq!(out.candidates[0].text, "I I");
    let out = decoder
        .update(&strokes, |_| panic!("identical input must hit cache"))
        .unwrap();
    assert_eq!(out.classifier_calls, 0);
    strokes[0][0][1] = 2.0;
    assert_eq!(
        decoder
            .update(&strokes, |_| Ok(single("I")))
            .unwrap()
            .classifier_calls,
        2
    );
    strokes.pop();
    let out = decoder
        .update(&strokes, |_| {
            panic!("unchanged prefix must survive deletion")
        })
        .unwrap();
    assert_eq!(out.candidates[0].text, "I");
    assert_eq!(out.cache_entries, 1);
}

#[test]
fn delayed_crossbar_rejoins_earlier_ink_and_revokes_stability() {
    let mut decoder = IncrementalDecoder::default();
    let mut strokes = vec![vertical(0.0), vertical(30.0), vertical(130.0)];
    let classify = |s: &[Stroke]| Ok(single(if s.len() == 3 { "H" } else { "I" }));
    decoder.update(&strokes, classify).unwrap();
    let out = decoder.update(&strokes, classify).unwrap();
    assert!(!out.stable_stroke_indices.is_empty());
    strokes.push(vec![[0.0, 30.0], [30.0, 30.0]]);
    let out = decoder.update(&strokes, classify).unwrap();
    assert_eq!(out.candidates[0].text, "H I");
    assert_eq!(out.candidates[0].segments[0].stroke_indices, vec![0, 1, 3]);
    assert!(out.stable_stroke_indices.is_empty());
    assert!(out.classifier_calls > 0);
}

#[test]
fn slow_multi_stroke_character_stays_editable_until_next_character() {
    let mut decoder = IncrementalDecoder::default();
    let mut strokes = vec![vec![[0.0, 0.0], [40.0, 0.0]]];
    for y in [0.0, 20.0, 40.0, 60.0, 80.0, 100.0, 120.0, 140.0] {
        strokes.push(vec![[20.0, y], [20.0, y + 20.0]]);
        let out = decoder.update(&strokes, |_| Ok(single("言"))).unwrap();
        assert!(out.stable_stroke_indices.is_empty());
        assert_eq!(out.candidates[0].segments.len(), 1);
    }
}

#[test]
fn errors_do_not_poison_cached_input_and_bad_scores_cannot_escape() {
    let mut decoder = IncrementalDecoder::default();
    let first = vec![vertical(0.0)];
    decoder.update(&first, |_| Ok(single("I"))).unwrap();
    let mut next = first.clone();
    next.push(vertical(100.0));
    assert!(
        decoder
            .update(&next, |_| Err(DecodeError::Classifier("test".into())))
            .is_err()
    );
    let out = decoder
        .update(&first, |_| panic!("old accepted input is cached"))
        .unwrap();
    assert_eq!(out.candidates[0].text, "I");
    assert_eq!(
        decoder
            .update(&[vec![[f32::NAN, 0.0]]], |_| Ok(single("I")))
            .unwrap_err(),
        DecodeError::InvalidInput
    );
    assert_eq!(
        decoder
            .update(&[vertical(0.0)], |_| panic!("cache"))
            .unwrap()
            .candidates[0]
            .text,
        "I"
    );
    decoder.reset();
    assert_eq!(
        decoder
            .update(&first, |_| Ok(vec![GlyphCandidate {
                text: "x".into(),
                probability: f32::NAN
            }]))
            .unwrap_err(),
        DecodeError::NoPath
    );
}

#[test]
fn refuses_multiline_and_bounds_work() {
    let mut decoder = IncrementalDecoder::default();
    let two_lines = vec![vertical(0.0), vec![[100.0, 200.0], [100.0, 260.0]]];
    assert_eq!(
        decoder.update(&two_lines, |_| Ok(single("I"))).unwrap_err(),
        DecodeError::MultipleLines
    );
    assert_eq!(
        decoder
            .update(&vec![vertical(0.0); 129], |_| Ok(single("I")))
            .unwrap_err(),
        DecodeError::InvalidInput
    );
}

#[test]
fn infers_mixed_script_spaces_and_incremental_matches_fresh_decode() {
    let mut decoder = IncrementalDecoder::default();
    let strokes = vec![vertical(0.0), vertical(100.0), vertical(200.0)];
    let classify = |s: &[Stroke]| {
        Ok(single(if s[0][0][0] < 50.0 {
            "中"
        } else if s[0][0][0] < 150.0 {
            "A"
        } else {
            "3"
        }))
    };
    for end in 1..=strokes.len() {
        let cached = decoder.update(&strokes[..end], classify).unwrap();
        let fresh = IncrementalDecoder::default()
            .update(&strokes[..end], classify)
            .unwrap();
        assert_eq!(cached.candidates[0].text, fresh.candidates[0].text);
        assert_eq!(cached.candidates[0].score, fresh.candidates[0].score);
    }
    let out = decoder.update(&strokes, classify).unwrap();
    assert_eq!(out.candidates[0].text, "中 A 3");
    assert_eq!(out.stable_text, "中 A");
    assert_eq!(out.stable_stroke_indices, vec![0, 1]);
}

#[test]
fn component_weighting_does_not_reward_merging_two_confident_glyphs() {
    let strokes = vec![
        vec![[0.0, 0.0], [20.0, 60.0]],
        vec![[30.0, 0.0], [50.0, 60.0]],
    ];
    let out = IncrementalDecoder::default()
        .update(&strokes, |s| {
            Ok(vec![GlyphCandidate {
                text: if s.len() == 1 { "文" } else { "田" }.into(),
                probability: if s.len() == 1 { 0.95 } else { 0.85 },
            }])
        })
        .unwrap();
    assert_eq!(out.candidates[0].text, "文文");
    assert_eq!(out.candidates[0].segments.len(), 2);
}

#[test]
fn word_gap_resets_context_even_when_next_digit_is_misclassified() {
    let strokes = vec![vertical(0.0), vertical(40.0)];
    for next in ["3", "了"] {
        let out = IncrementalDecoder::default()
            .update_with_context(
                &strokes,
                |s| Ok(single(if s[0][0][0] == 0.0 { "A" } else { next })),
                |previous, candidate| {
                    if candidate == next {
                        assert!(previous.is_none());
                    }
                    0.0
                },
            )
            .unwrap();
        assert_eq!(out.candidates[0].text, format!("A {next}"));
    }
}

#[test]
fn connected_word_keeps_one_ink_identity_and_reuses_and_revokes_cache() {
    for (first_text, replacement) in [("hello", "world"), ("山水", "天地")] {
        let word: Stroke = (0..=80)
            .map(|i| [i as f32, (i as f32 * 0.5).sin() * 10.0])
            .collect();
        let original = word.clone();
        let mut ink = vec![word, vertical(160.0)];
        let classify = |s: &[Stroke]| Ok(single(if s[0].len() > 24 { first_text } else { "I" }));
        let mut decoder = IncrementalDecoder::default();
        let first = decoder.update(&ink, classify).unwrap();
        assert_eq!(first.candidates[0].text, format!("{first_text} I"));
        assert_eq!(first.candidates[0].segments[0].stroke_indices, [0]);
        let unchanged = decoder
            .update(&ink, |_| panic!("word must be cached"))
            .unwrap();
        assert_eq!(unchanged.stable_text, first_text);
        assert_eq!(unchanged.stable_stroke_indices, [0]);
        assert_eq!(ink[0], original);
        ink[0][10][1] += 1.0;
        let changed = decoder
            .update(&ink, |s| {
                Ok(single(if s[0].len() > 24 { replacement } else { "I" }))
            })
            .unwrap();
        assert_eq!(changed.candidates[0].text, format!("{replacement} I"));
        assert!(changed.stable_text.is_empty());
        assert!(changed.classifier_calls > 0);
    }
}

#[test]
fn multi_character_hypotheses_need_connected_geometry() {
    for text in ["hello", "你好", "hello world", "HELLO"] {
        let out = IncrementalDecoder::default()
            .update(&[vertical(0.0)], |_| {
                Ok(vec![
                    GlyphCandidate {
                        text: text.into(),
                        probability: 0.99,
                    },
                    GlyphCandidate {
                        text: "I".into(),
                        probability: 0.8,
                    },
                ])
            })
            .unwrap();
        assert_eq!(out.candidates[0].text, "I");
    }
}

/// Explicit opt-in: weights are local research assets, never downloaded by tests.
#[test]
#[ignore = "requires local COBOARD_HWR_MODEL_DIR; run with --ignored"]
fn native_model_replays_development_lines() {
    #[derive(serde::Deserialize)]
    struct Fixture {
        name: String,
        expected: String,
        strokes: Vec<Stroke>,
    }
    let fixtures: Vec<Fixture> = serde_json::from_str(include_str!(
        "../../../research/handwriting/incremental-fixtures.json"
    ))
    .unwrap();
    let engine = crate::HandwritingEngine::load_default().unwrap();
    for f in fixtures {
        let classify = |s: &[Stroke]| engine.recognize_incremental_segment(s);
        let context = |p: Option<&str>, n: &str| engine.incremental_context_score(p, n);
        let mut decoder = IncrementalDecoder::default();
        for end in 1..f.strokes.len() {
            decoder
                .update_with_context(&f.strokes[..end], classify, context)
                .unwrap();
        }
        let incremental = decoder
            .update_with_context(&f.strokes, classify, context)
            .unwrap();
        let fresh = IncrementalDecoder::default()
            .update_with_context(&f.strokes, classify, context)
            .unwrap();
        assert_eq!(incremental.candidates[0].text, f.expected, "{}", f.name);
        assert_eq!(
            fresh.candidates[0].text, incremental.candidates[0].text,
            "{}",
            f.name
        );
    }
}

#[test]
fn shifted_and_delayed_dots_join_the_nearest_stem_and_keep_original_indices() {
    for x in [-12.0, 12.0] {
        for gap in [25.0, 60.0] {
            let strokes = vec![vertical(0.0), vertical(120.0), vec![[x, -gap]]];
            let out = IncrementalDecoder::default()
                .update(&strokes, |ink| {
                    Ok(single(if ink.len() == 2 { "i" } else { "I" }))
                })
                .unwrap();
            assert_eq!(out.candidates[0].segments[0].text, "i");
            assert_eq!(out.candidates[0].segments[0].stroke_indices, [0, 2]);
        }
    }
}

#[test]
fn touching_tails_do_not_hard_merge_adjacent_characters() {
    let strokes = vec![
        vec![[0.0, 0.0], [55.0, 60.0]],
        vec![[50.0, 60.0], [100.0, 0.0]],
    ];
    let out = IncrementalDecoder::default()
        .update(&strokes, |ink| {
            Ok(vec![GlyphCandidate {
                text: if ink.len() == 1 { "文" } else { "醴" }.into(),
                probability: if ink.len() == 1 { 0.95 } else { 0.5 },
            }])
        })
        .unwrap();
    assert_eq!(out.candidates[0].text, "文文");
    assert_eq!(out.candidates[0].segments.len(), 2);
}

#[test]
fn round_lowercase_glyph_is_not_penalized_against_uppercase_or_han() {
    let strokes = vec![vec![[0.0, 0.0], [72.0, 60.0]]];
    let out = IncrementalDecoder::default()
        .update(&strokes, |_| {
            Ok([("o", 0.55), ("O", 0.30), ("口", 0.15)]
                .into_iter()
                .map(|(text, probability)| GlyphCandidate {
                    text: text.into(),
                    probability,
                })
                .collect())
        })
        .unwrap();
    assert_eq!(out.candidates[0].text, "o");
}

#[test]
fn multipen_sequence_preserves_all_ink_ids_and_a_single_glyph_fallback() {
    // Overlapping trajectories create one wide component with several pen-downs.
    let strokes = vec![
        (0..=80)
            .map(|i| [i as f32, (i as f32 * 0.5).sin() * 10.0])
            .collect(),
        vec![[20.0, -5.0], [60.0, 5.0]],
    ];
    let original = strokes.clone();
    let mut decoder = IncrementalDecoder::default();
    let out = decoder
        .update(&strokes, |_| {
            Ok([
                ("hello", 0.9),
                ("world", 0.8),
                ("today", 0.7),
                ("water", 0.6),
                ("happy", 0.5),
                ("m", 0.1),
            ]
            .into_iter()
            .map(|(text, probability)| GlyphCandidate {
                text: text.into(),
                probability,
            })
            .collect())
        })
        .unwrap();
    assert!(out.candidates.iter().any(|c| c.text == "m"));
    assert_eq!(out.candidates[0].segments[0].stroke_indices, [0, 1]);
    assert_eq!(strokes, original);
    decoder
        .update(&strokes, |_| {
            panic!("unchanged multi-pen ink must hit cache")
        })
        .unwrap();
}

#[test]
fn detached_crossbars_attach_without_turning_one_letter_into_multiple_lines() {
    let strokes = vec![
        vec![[0.0, 0.0], [8.0, 60.0]],
        vec![[10.0, -3.0], [45.0, 5.0]],
        vec![[11.0, 28.0], [35.0, 31.0]],
    ];
    let out = IncrementalDecoder::default()
        .update(&strokes, |_| Ok(single("F")))
        .unwrap();
    assert_eq!(out.candidates[0].text, "F");
    assert_eq!(out.candidates[0].segments[0].stroke_indices, [0, 1, 2]);
}
