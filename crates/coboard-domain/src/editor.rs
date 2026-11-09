use crate::{Document, DomainError, Node, Point};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const HISTORY_LIMIT: usize = 256;
pub const MAX_HISTORY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Insert { node: Node },
    Delete { id: String },
    Move { id: String, position: Point },
    Replace { node: Node },
    Rename { title: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Edit { operations: Vec<Operation> },
    Undo,
    Redo,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EditRequest {
    pub request_id: String,
    pub expected_revision: u64,
    pub action: Action,
}

#[derive(Debug, Clone)]
struct HistoryEntry {
    forward: Vec<Operation>,
    inverse: Vec<Operation>,
    bytes: usize,
}

#[derive(Debug, Clone)]
pub struct Editor {
    document: Document,
    undo: VecDeque<HistoryEntry>,
    redo: Vec<HistoryEntry>,
}

impl Editor {
    pub fn new(document: Document) -> Result<Self, DomainError> {
        document.validate()?;
        Ok(Self {
            document,
            undo: VecDeque::new(),
            redo: Vec::new(),
        })
    }
    pub fn document(&self) -> &Document {
        &self.document
    }
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
    /// One request is one undo unit. Preview points/drag positions are not commands.
    /// All operations and final graph invariants succeed together, including undo/redo.
    pub fn apply(&mut self, action: &Action, expected: u64) -> Result<(), DomainError> {
        if self.document.revision != expected {
            return Err(DomainError::Conflict {
                expected,
                actual: self.document.revision,
            });
        }
        let operations = match action {
            Action::Edit { operations } => operations.clone(),
            Action::Undo => self
                .undo
                .back()
                .ok_or(DomainError::EmptyHistory)?
                .inverse
                .clone(),
            Action::Redo => self
                .redo
                .last()
                .ok_or(DomainError::EmptyHistory)?
                .forward
                .clone(),
        };
        if operations.is_empty() || operations.len() > 4096 {
            return Err(DomainError::Invalid("transaction operation budget".into()));
        }
        let mut next = self.document.clone();
        let mut inverse = Vec::new();
        for op in &operations {
            inverse.push(apply_one(&mut next, op)?);
        }
        next.revision = expected
            .checked_add(1)
            .ok_or_else(|| DomainError::Invalid("revision exhausted".into()))?;
        next.validate()?;
        inverse.reverse();
        match action {
            Action::Edit { .. } => {
                let bytes = serde_json::to_vec(&operations)
                    .and_then(|forward| {
                        serde_json::to_vec(&inverse).map(|inverse| forward.len() + inverse.len())
                    })
                    .map_err(|_| DomainError::Invalid("undo serialization failed".into()))?;
                self.undo.push_back(HistoryEntry {
                    forward: operations,
                    inverse,
                    bytes,
                });
                while self.undo.len() > HISTORY_LIMIT
                    || self.undo.iter().map(|entry| entry.bytes).sum::<usize>() > MAX_HISTORY_BYTES
                {
                    self.undo.pop_front();
                }
                self.redo.clear();
            }
            Action::Undo => {
                if let Some(entry) = self.undo.pop_back() {
                    self.redo.push(entry);
                }
            }
            Action::Redo => {
                if let Some(entry) = self.redo.pop() {
                    self.undo.push_back(entry);
                }
            }
        }
        self.document = next;
        Ok(())
    }
}

fn apply_one(doc: &mut Document, operation: &Operation) -> Result<Operation, DomainError> {
    Ok(match operation {
        Operation::Insert { node } => {
            if doc.nodes.contains_key(&node.attrs.id) {
                return Err(DomainError::Duplicate(node.attrs.id.clone()));
            }
            doc.nodes.insert(node.attrs.id.clone(), node.clone());
            Operation::Delete {
                id: node.attrs.id.clone(),
            }
        }
        Operation::Delete { id } => Operation::Insert {
            node: doc
                .nodes
                .remove(id)
                .ok_or_else(|| DomainError::NotFound(id.clone()))?,
        },
        Operation::Move { id, position } => {
            let node = doc
                .nodes
                .get_mut(id)
                .ok_or_else(|| DomainError::NotFound(id.clone()))?;
            let old = node.attrs.position;
            node.attrs.position = *position;
            Operation::Move {
                id: id.clone(),
                position: old,
            }
        }
        Operation::Replace { node } => {
            let old = doc
                .nodes
                .get_mut(&node.attrs.id)
                .ok_or_else(|| DomainError::NotFound(node.attrs.id.clone()))?;
            Operation::Replace {
                node: std::mem::replace(old, node.clone()),
            }
        }
        Operation::Rename { title } => Operation::Rename {
            title: std::mem::replace(&mut doc.title, title.clone()),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Content, NodeAttrs};
    fn editor() -> Editor {
        Editor::new(Document::new("doc", "讲解").unwrap()).unwrap()
    }
    fn add(id: &str) -> Operation {
        Operation::Insert {
            node: Node::paragraph(id, "条件", Point::default()),
        }
    }
    fn edit(operations: Vec<Operation>) -> Action {
        Action::Edit { operations }
    }
    #[test]
    fn atomic_transaction_and_monotonic_undo() {
        let mut e = editor();
        assert!(e.apply(&edit(vec![add("a"), add("a")]), 0).is_err());
        assert!(e.document().nodes.is_empty());
        assert!(!e.can_undo());
        e.apply(&edit(vec![add("a"), add("b")]), 0).unwrap();
        e.apply(&Action::Undo, 1).unwrap();
        assert!(e.document().nodes.is_empty());
        e.apply(&Action::Redo, 2).unwrap();
        assert_eq!(e.document().revision, 3);
        assert_eq!(e.document().nodes.len(), 2);
        assert!(matches!(
            e.apply(&Action::Undo, 1),
            Err(DomainError::Conflict { .. })
        ));
    }
    #[test]
    fn graph_validation_and_group_delete() {
        let mut e = editor();
        let connector = Node {
            attrs: NodeAttrs {
                id: "edge".into(),
                position: Point::default(),
                source: None,
            },
            content: Content::Connector {
                from: "a".into(),
                to: "b".into(),
            },
        };
        e.apply(
            &edit(vec![
                add("a"),
                add("b"),
                Operation::Insert { node: connector },
            ]),
            0,
        )
        .unwrap();
        assert!(
            e.apply(&edit(vec![Operation::Delete { id: "a".into() }]), 1)
                .is_err()
        );
        assert_eq!(e.document().nodes.len(), 3);
        e.apply(
            &edit(vec![
                Operation::Delete { id: "a".into() },
                Operation::Delete { id: "edge".into() },
            ]),
            1,
        )
        .unwrap();
        e.apply(&Action::Undo, 2).unwrap();
        assert_eq!(e.document().nodes.len(), 3);
    }
    #[test]
    fn new_edit_clears_redo_and_history_is_bounded() {
        let mut e = editor();
        e.apply(&edit(vec![add("a")]), 0).unwrap();
        e.apply(&Action::Undo, 1).unwrap();
        e.apply(&edit(vec![add("b")]), 2).unwrap();
        assert!(!e.can_redo());
        for i in 0..300 {
            let rev = e.document().revision;
            e.apply(
                &edit(vec![Operation::Move {
                    id: "b".into(),
                    position: Point {
                        x: f64::from(i),
                        y: 0.0,
                    },
                }]),
                rev,
            )
            .unwrap();
        }
        for _ in 0..HISTORY_LIMIT {
            let rev = e.document().revision;
            e.apply(&Action::Undo, rev).unwrap();
        }
        assert!(!e.can_undo());
    }
    #[test]
    fn jsonml_roundtrip_and_unknown_data_protection() {
        let node = Node::paragraph("a", "中文 e\u{301}", Point::default());
        let value = serde_json::to_value(&node).unwrap();
        assert_eq!(value[0], "paragraph");
        assert_eq!(serde_json::from_value::<Node>(value).unwrap(), node);
        assert!(
            serde_json::from_value::<Node>(
                serde_json::json!(["future", {"id":"a","position":{"x":0,"y":0}}])
            )
            .is_err()
        );
        assert!(serde_json::from_value::<Node>(serde_json::json!(["paragraph", {"id":"a","position":{"x":0,"y":0},"future":true},["text","x"]])).is_err());
    }
    #[test]
    fn rejects_nonfinite_geometry_and_invalid_assets() {
        let mut e = editor();
        let mut node = Node::paragraph(
            "a",
            "x",
            Point {
                x: f64::NAN,
                y: 0.0,
            },
        );
        assert!(
            e.apply(&edit(vec![Operation::Insert { node: node.clone() }]), 0)
                .is_err()
        );
        node.attrs.position = Point::default();
        node.content = Content::Image {
            asset: "../../outside".into(),
            width: 1.0,
            height: 1.0,
        };
        assert!(e.apply(&edit(vec![Operation::Insert { node }]), 0).is_err());
    }
}
