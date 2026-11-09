use coboard_domain::{Action, Content, EditRequest, InkPoint, Node, NodeAttrs, Operation, Point};
use coboard_storage::Package;
use std::{
    io::{BufRead, Write},
    path::PathBuf,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("package path required")?;
    let mut package = Package::create(path, "崩溃恢复验收")?;
    let asset = package.assets().put(b"source bytes for crash acceptance")?;
    package.commit(&EditRequest {
        request_id: "card".into(),
        expected_revision: 0,
        action: Action::Edit {
            operations: vec![Operation::Insert {
                node: Node {
                    attrs: NodeAttrs {
                        id: "card".into(),
                        position: Point::default(),
                        source: Some(coboard_domain::SourceRef {
                            asset,
                            rect: [0.0, 0.0, 100.0, 40.0],
                            page: None,
                        }),
                    },
                    content: Content::DerivationCard {
                        pinned: true,
                        children: vec![coboard_domain::Block::MathBlock {
                            latex: "E=mc^2".into(),
                        }],
                    },
                },
            }],
        },
    })?;
    for i in 0..1000 {
        let operation = if i % 2 == 0 {
            Operation::Insert {
                node: Node {
                    attrs: NodeAttrs {
                        id: format!("stroke_{i}"),
                        position: Point::default(),
                        source: None,
                    },
                    content: Content::Stroke {
                        points: vec![
                            InkPoint {
                                x: f64::from(i),
                                y: 1.0,
                                pressure: 0.5,
                                elapsed_ms: 0,
                            },
                            InkPoint {
                                x: f64::from(i) + 1.0,
                                y: 2.0,
                                pressure: 0.7,
                                elapsed_ms: 16,
                            },
                        ],
                        width: 2.0,
                        color: "#42a5ff".into(),
                        brush: coboard_domain::BrushStyle::Pen,
                        opacity: 1.0,
                    },
                },
            }
        } else {
            Operation::Move {
                id: "card".into(),
                position: Point {
                    x: f64::from(i),
                    y: f64::from(i * 2),
                },
            }
        };
        package.commit(&EditRequest {
            request_id: format!("step_{i}"),
            expected_revision: package.document().revision,
            action: Action::Edit {
                operations: vec![operation],
            },
        })?;
    }
    // Parent reads this acknowledgement before SIGKILL. No checkpoint or Drop runs.
    println!("READY {}", package.document().revision);
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    Ok(())
}
