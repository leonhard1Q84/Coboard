#![cfg(unix)]
use coboard_domain::{Action, Content, EditRequest, Operation, Point};
use coboard_storage::Package;
use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

#[test]
fn sigkill_recovers_1000_ink_and_move_commands_and_assets() {
    let t = tempfile::tempdir().unwrap();
    let path = t.path().join("强制退出 回放.coboard");
    let mut child = Command::new(env!("CARGO_BIN_EXE_coboard-storage-probe"))
        .arg(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut ready = String::new();
        let result = BufReader::new(stdout).read_line(&mut ready).map(|_| ready);
        let _ = tx.send(result);
    });
    let start = Instant::now();
    let ready = rx.recv_timeout(Duration::from_secs(120));
    // Child::kill is SIGKILL on Unix. This bypasses destructors and SQLite close.
    child.kill().unwrap();
    let status = child.wait().unwrap();
    assert!(!status.success());
    assert_eq!(ready.unwrap().unwrap().trim(), "READY 1001");
    let writing_ms = start.elapsed().as_secs_f64() * 1000.0;
    let mut p = Package::open(&path).unwrap();
    assert_eq!(p.document().revision, 1001);
    assert_eq!(p.document().nodes.len(), 501);
    assert_eq!(
        p.document().nodes["card"].attrs.position,
        Point {
            x: 999.0,
            y: 1998.0
        }
    );
    for i in (0..1000).step_by(2) {
        let node = &p.document().nodes[&format!("stroke_{i}")];
        if let Content::Stroke { points, .. } = &node.content {
            assert_eq!(points.len(), 2);
            assert_eq!(points[0].x, f64::from(i));
            assert_eq!(points[1].elapsed_ms, 16);
        } else {
            panic!("recovered a different node kind");
        }
    }
    for hash in p.document().asset_hashes() {
        assert_eq!(
            p.assets().read(hash).unwrap(),
            b"source bytes for crash acceptance"
        );
    }
    assert!(p.recovery().missing_assets.is_empty());
    println!(
        "1000 commands + source card: write {writing_ms:.2} ms, recover {:.2} ms, replay {} updates after snapshot {}",
        p.recovery().elapsed_ms,
        p.recovery().replayed_updates,
        p.recovery().snapshot_revision
    );
    p.commit(&EditRequest {
        request_id: "after_crash".into(),
        expected_revision: 1001,
        action: Action::Edit {
            operations: vec![Operation::Rename {
                title: "恢复后继续保存".into(),
            }],
        },
    })
    .unwrap();
    drop(p);
    assert_eq!(Package::open(path).unwrap().document().revision, 1002);
}
