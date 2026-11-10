use super::*;
use coboard_domain::{Action, Content, Node, NodeAttrs, Operation, Point, SourceRef};

fn create() -> (tempfile::TempDir, Package) {
    let temp = tempfile::tempdir().unwrap();
    let p = Package::create(temp.path().join("中文 空格 e\u{301}.coboard"), "测试讲解").unwrap();
    (temp, p)
}
fn request(id: &str, revision: u64, operations: Vec<Operation>) -> EditRequest {
    EditRequest {
        request_id: id.into(),
        expected_revision: revision,
        action: Action::Edit { operations },
    }
}
fn add(id: &str) -> Operation {
    Operation::Insert {
        node: Node::paragraph(id, "conservation energy", Point::default()),
    }
}

#[test]
fn package_roundtrip_and_fts_undo_redo() {
    let (_t, mut p) = create();
    p.commit(&request("a", 0, vec![add("a")])).unwrap();
    assert_eq!(p.search("energy").unwrap(), vec!["a"]);
    p.commit(&EditRequest {
        request_id: "undo".into(),
        expected_revision: 1,
        action: Action::Undo,
    })
    .unwrap();
    assert!(p.search("energy").unwrap().is_empty());
    p.commit(&EditRequest {
        request_id: "redo".into(),
        expected_revision: 2,
        action: Action::Redo,
    })
    .unwrap();
    let expected = p.document().clone();
    let path = p.path().to_path_buf();
    drop(p);
    let mut restored = Package::open(path).unwrap();
    assert_eq!(restored.document(), &expected);
    assert_eq!(restored.recovery().replayed_updates, 3);
    assert!(!restored.can_undo());
    restored.commit(&request("b", 3, vec![add("b")])).unwrap();
    assert_eq!(restored.document().revision, 4);
}

#[test]
fn every_node_kind_roundtrips_with_source() {
    let (_t, mut p) = create();
    let asset = p.assets().put(b"source image bytes").unwrap();
    let kinds = vec![
        Content::DerivationCard {
            pinned: true,
            children: vec![
                coboard_domain::Block::Paragraph {
                    text: "条件".into(),
                },
                coboard_domain::Block::MathBlock {
                    latex: "E=mc^2".into(),
                },
            ],
        },
        Content::MathBlock {
            latex: "x^2".into(),
        },
        Content::Image {
            asset: asset.clone(),
            width: 100.0,
            height: 40.0,
        },
        Content::Stroke {
            points: vec![coboard_domain::InkPoint {
                x: 1.0,
                y: 2.0,
                pressure: 0.6,
                elapsed_ms: 0,
            }],
            width: 2.0,
            color: "#aaff22".into(),
            brush: coboard_domain::BrushStyle::Highlighter,
            opacity: 0.45,
        },
        Content::Shape {
            kind: coboard_domain::ShapeKind::Rectangle,
            end: Point { x: 80.0, y: 40.0 },
            width: 2.5,
            color: "#3366ff".into(),
            fill: Some("#2f6fed".into()),
            corner_radius: Some(8.0),
            text: Some("节点文本".into()),
            rotation: Some(0.25),
            points: Vec::new(),
        },
        Content::Connector {
            from: Some("n0".into()),
            to: Some("n1".into()),
            from_point: None,
            to_point: None,
            from_anchor: coboard_domain::ConnectorAnchor::Right,
            to_anchor: coboard_domain::ConnectorAnchor::Left,
            route: coboard_domain::ConnectorRoute::Curve,
            start_head: coboard_domain::ConnectorHead::None,
            end_head: coboard_domain::ConnectorHead::Arrow,
            dashed: true,
            width: 2.0,
            color: "#1f2329".into(),
            waypoints: vec![Point { x: 40.0, y: 20.0 }],
            label: Some("连线标签".into()),
        },
    ];
    let operations = kinds
        .into_iter()
        .enumerate()
        .map(|(i, content)| Operation::Insert {
            node: Node {
                attrs: NodeAttrs {
                    id: format!("n{i}"),
                    position: Point::default(),
                    source: Some(SourceRef {
                        asset: asset.clone(),
                        rect: [1.0, 2.0, 30.0, 40.0],
                        page: Some(1),
                    }),
                    group_ids: Vec::new(),
                },
                content,
            },
        })
        .collect();
    p.commit(&request("all", 0, operations)).unwrap();
    p.checkpoint().unwrap();
    let doc = p.document().clone();
    let path = p.path().to_path_buf();
    drop(p);
    let p = Package::open(path).unwrap();
    assert_eq!(p.document(), &doc);
    assert!(p.recovery().missing_assets.is_empty());
}

#[test]
fn snapshots_bound_replay_and_preserve_idempotence() {
    let (_t, mut p) = create();
    for i in 0..135 {
        p.commit(&request(
            &format!("r{i}"),
            i,
            vec![Operation::Rename {
                title: format!("title {i}"),
            }],
        ))
        .unwrap();
    }
    let path = p.path().to_path_buf();
    drop(p);
    let mut p = Package::open(path).unwrap();
    assert_eq!(p.recovery().snapshot_revision, 128);
    assert_eq!(p.recovery().replayed_updates, 7);
    let old = request(
        "r0",
        0,
        vec![Operation::Rename {
            title: "title 0".into(),
        }],
    );
    assert_eq!(
        p.commit(&old).unwrap(),
        CommitReceipt {
            revision: 1,
            duplicate: true
        }
    );
    assert_eq!(p.document().revision, 135);
    assert!(matches!(
        p.commit(&request("r0", 0, vec![add("a")])),
        Err(StorageError::RequestConflict)
    ));
}

#[test]
fn sql_failure_does_not_publish_memory_history_or_crdt() {
    let (_t, mut p) = create();
    p.connection.execute_batch("CREATE TRIGGER fail_commit BEFORE INSERT ON oplog BEGIN SELECT RAISE(FAIL, 'injected write failure'); END;").unwrap();
    let r = request("a", 0, vec![add("a")]);
    assert!(p.commit(&r).is_err());
    assert_eq!(p.document().revision, 0);
    assert!(!p.can_undo());
    assert_eq!(crdt::read_document(&p.loro).unwrap(), *p.document());
    p.connection
        .execute_batch("DROP TRIGGER fail_commit;")
        .unwrap();
    p.commit(&r).unwrap();
    let path = p.path().to_path_buf();
    drop(p);
    assert_eq!(Package::open(path).unwrap().document().revision, 1);
}

#[test]
fn retry_reconciles_a_committed_request_with_an_uncertain_reply() {
    let (_t, mut p) = create();
    let old_document = p.document().clone();
    let old_loro = p.loro.fork();
    let r = request("a", 0, vec![add("a")]);
    p.commit(&r).unwrap();
    // Model a durable commit whose in-memory publication/reply was interrupted.
    p.editor = Editor::new(old_document).unwrap();
    p.loro = old_loro;
    assert_eq!(
        p.commit(&r).unwrap(),
        CommitReceipt {
            revision: 1,
            duplicate: true
        }
    );
    assert_eq!(p.document().revision, 1);
    assert!(p.document().nodes.contains_key("a"));
    assert_eq!(crdt::read_document(&p.loro).unwrap(), *p.document());
}

#[test]
fn sqlite_full_preserves_last_commit_and_allows_retry() {
    let (_t, mut p) = create();
    p.commit(&request("a", 0, vec![add("a")])).unwrap();
    let pages: i64 = p
        .connection
        .pragma_query_value(None, "page_count", |r| r.get(0))
        .unwrap();
    p.connection
        .pragma_update(None, "max_page_count", pages)
        .unwrap();
    let text: String = (0..200_000_u32)
        .map(|i| char::from_u32(0x4e00 + ((i.wrapping_mul(2654435761)) % 20000)).unwrap())
        .collect();
    // Respect the domain's UTF-8 byte budget while exceeding the DB's free pages.
    let text = text.chars().take(60_000).collect::<String>();
    let r = request(
        "large",
        1,
        vec![Operation::Insert {
            node: Node::paragraph("large", text, Point::default()),
        }],
    );
    let e = p.commit(&r).unwrap_err();
    assert_eq!(e.code(), "disk_full", "{e}");
    assert_eq!(p.document().revision, 1);
    p.connection
        .pragma_update(None, "max_page_count", 1_000_000)
        .unwrap();
    p.commit(&r).unwrap();
    let path = p.path().to_path_buf();
    drop(p);
    assert_eq!(Package::open(path).unwrap().document().revision, 2);
}

#[test]
fn lock_conflict_and_newer_versions_fail_closed() {
    let (_t, p) = create();
    let path = p.path().to_path_buf();
    assert!(matches!(Package::open(&path), Err(StorageError::Locked)));
    drop(p);
    let manifest_path = path.join("manifest.json");
    let bytes = fs::read(&manifest_path).unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["format_version"] = 99.into();
    let future = serde_json::to_vec(&value).unwrap();
    fs::write(&manifest_path, &future).unwrap();
    let db_before = fs::read(path.join("document.db")).unwrap();
    assert!(matches!(
        Package::open(&path),
        Err(StorageError::UnsupportedVersion(99))
    ));
    assert_eq!(fs::read(&manifest_path).unwrap(), future);
    assert_eq!(fs::read(path.join("document.db")).unwrap(), db_before);
    fs::write(manifest_path, bytes).unwrap();
    let db = Connection::open(path.join("document.db")).unwrap();
    db.pragma_update(None, "user_version", 99).unwrap();
    drop(db);
    assert!(matches!(
        Package::open(&path),
        Err(StorageError::UnsupportedVersion(99))
    ));
}

#[test]
fn truncated_or_corrupt_log_is_not_silently_accepted() {
    for corrupt in [false, true] {
        let (_t, mut p) = create();
        p.commit(&request("a", 0, vec![add("a")])).unwrap();
        if corrupt {
            p.connection
                .execute("UPDATE oplog SET update_bytes=x'00' WHERE revision=1", [])
                .unwrap();
        } else {
            p.connection
                .execute("DELETE FROM oplog WHERE revision=1", [])
                .unwrap();
        }
        let path = p.path().to_path_buf();
        drop(p);
        assert!(matches!(Package::open(path), Err(StorageError::Corrupt(_))));
    }
}

#[test]
fn bad_snapshot_and_incomplete_package_are_preserved() {
    let (_t, mut p) = create();
    p.commit(&request("a", 0, vec![add("a")])).unwrap();
    p.checkpoint().unwrap();
    p.connection
        .execute(
            "UPDATE snapshots SET ast_hash='corrupt' WHERE revision=1",
            [],
        )
        .unwrap();
    let path = p.path().to_path_buf();
    drop(p);
    assert!(Package::open(&path).is_err());
    assert!(path.join("document.db").exists());
    fs::remove_file(path.join("manifest.json")).unwrap();
    assert!(Package::open(&path).is_err());
    assert!(Package::create(&path, "replacement").is_err());
}

#[test]
fn missing_resource_is_reported_and_missing_reference_never_commits() {
    let (_t, mut p) = create();
    let mut n = Node::paragraph("a", "recognized", Point::default());
    let missing = "0".repeat(64);
    n.attrs.source = Some(SourceRef {
        asset: missing,
        rect: [0.0, 0.0, 1.0, 1.0],
        page: None,
    });
    assert!(matches!(
        p.commit(&request(
            "missing",
            0,
            vec![Operation::Insert { node: n.clone() }]
        )),
        Err(StorageError::MissingAsset(_))
    ));
    let hash = p.assets().put(b"original").unwrap();
    n.attrs.source.as_mut().unwrap().asset = hash.clone();
    p.commit(&request("valid", 0, vec![Operation::Insert { node: n }]))
        .unwrap();
    let path = p.path().to_path_buf();
    drop(p);
    fs::remove_file(path.join("assets").join(&hash[..2]).join(&hash)).unwrap();
    let mut p = Package::open(path).unwrap();
    assert_eq!(p.recovery().missing_assets, vec![hash]);
    assert_eq!(p.document().nodes.len(), 1);
    p.commit(&request(
        "remove",
        1,
        vec![Operation::Delete { id: "a".into() }],
    ))
    .unwrap();
}

#[test]
fn resource_integrity_dedup_and_partial_staging() {
    let (_t, p) = create();
    let hash = p.assets().put(b"blob").unwrap();
    assert_eq!(p.assets().put(b"blob").unwrap(), hash);
    assert_eq!(p.assets().read(&hash).unwrap(), b"blob");
    fs::write(
        p.path()
            .join("assets")
            .join(&hash[..2])
            .join(".asset-interrupted.tmp"),
        b"partial",
    )
    .unwrap();
    assert_eq!(p.assets().read(&hash).unwrap(), b"blob");
    assert!(p.assets().read("../../outside").is_err());
    fs::write(
        p.path().join("assets").join(&hash[..2]).join(&hash),
        b"damaged",
    )
    .unwrap();
    assert!(matches!(
        p.assets().read(&hash),
        Err(StorageError::MissingAsset(_))
    ));
    assert!(p.assets().put(b"blob").is_err()); // preserve the damaged original for diagnosis
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_escape_asset_or_database_boundaries() {
    use std::os::unix::fs::symlink;
    let (t, p) = create();
    let outside = t.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let hash = hash(b"blob");
    symlink(&outside, p.path().join("assets").join(&hash[..2])).unwrap();
    assert!(matches!(
        p.assets().put(b"blob"),
        Err(StorageError::UnsafePath)
    ));
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    let path = p.path().to_path_buf();
    drop(p);
    fs::rename(path.join("document.db"), outside.join("document.db")).unwrap();
    symlink(outside.join("document.db"), path.join("document.db")).unwrap();
    assert!(matches!(Package::open(path), Err(StorageError::UnsafePath)));
}

#[cfg(unix)]
#[test]
fn read_only_database_does_not_lose_last_commit() {
    use std::os::unix::fs::PermissionsExt;
    let (_t, mut p) = create();
    p.commit(&request("a", 0, vec![add("a")])).unwrap();
    let path = p.path().to_path_buf();
    drop(p);
    fs::set_permissions(path.join("document.db"), fs::Permissions::from_mode(0o444)).unwrap();
    assert!(Package::open(&path).is_err());
    fs::set_permissions(path.join("document.db"), fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(Package::open(path).unwrap().document().revision, 1);
}

#[test]
fn new_brushes_survive_undo_redo_and_reopen() {
    use coboard_domain::{BrushStyle, Content, InkPoint, Node, NodeAttrs, Point};
    let (dir, mut package) = create();
    let brushes = [BrushStyle::Pencil, BrushStyle::Fountain, BrushStyle::Marker];
    let operations = brushes
        .iter()
        .enumerate()
        .map(|(i, brush)| Operation::Insert {
            node: Node {
                attrs: NodeAttrs {
                    id: format!("brush-{i}"),
                    position: Point { x: 10.0, y: 20.0 },
                    source: None,
                    group_ids: Vec::new(),
                },
                content: Content::Stroke {
                    points: vec![
                        InkPoint {
                            x: 0.0,
                            y: 0.0,
                            pressure: 0.5,
                            elapsed_ms: 0,
                        },
                        InkPoint {
                            x: 60.0,
                            y: 40.0,
                            pressure: 0.8,
                            elapsed_ms: 200,
                        },
                    ],
                    width: 4.0,
                    color: "#e5484d".into(),
                    brush: *brush,
                    opacity: 1.0,
                },
            },
        })
        .collect();
    package.commit(&request("brushes", 0, operations)).unwrap();
    package
        .commit(&EditRequest {
            request_id: "undo-brushes".into(),
            expected_revision: 1,
            action: Action::Undo,
        })
        .unwrap();
    assert!(package.document().nodes.is_empty());
    package
        .commit(&EditRequest {
            request_id: "redo-brushes".into(),
            expected_revision: 2,
            action: Action::Redo,
        })
        .unwrap();
    let expected = package.document().clone();
    let path = package.path().to_path_buf();
    drop(package);
    let restored = Package::open(path).unwrap();
    assert_eq!(restored.document(), &expected);
    assert_eq!(restored.document().nodes.len(), brushes.len());
    drop(restored);
    drop(dir);
}
