use crate::{Content, Document, DomainError, Node, Point, ShapeKind, valid_id};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, VecDeque};

pub const HISTORY_LIMIT: usize = 256;
pub const MAX_HISTORY_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_OPERATIONS: usize = 32_768;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Insert { node: Node },
    Delete { id: String },
    Move { id: String, position: Point },
    Translate { ids: Vec<String>, dx: f64, dy: f64 },
    Group { id: String, node_ids: Vec<String> },
    Ungroup { id: String, node_ids: Vec<String> },
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
        if operations.is_empty() || operations.len() > MAX_OPERATIONS {
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

fn unique_ids(ids: &[String], label: &str) -> Result<(), DomainError> {
    if ids.is_empty() {
        return Err(DomainError::Invalid(format!("empty {label} ids")));
    }
    let mut seen = BTreeSet::new();
    for id in ids {
        if !seen.insert(id.as_str()) {
            return Err(DomainError::Invalid(format!("duplicate id in {label}")));
        }
    }
    Ok(())
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
        Operation::Translate { ids, dx, dy } => {
            if !dx.is_finite() || !dy.is_finite() {
                return Err(DomainError::Invalid("nonfinite translation".into()));
            }
            unique_ids(ids, "translate")?;
            for id in ids {
                let node = doc
                    .nodes
                    .get_mut(id)
                    .ok_or_else(|| DomainError::NotFound(id.clone()))?;
                node.attrs.position.x += *dx;
                node.attrs.position.y += *dy;
                if let Content::Shape {
                    kind: ShapeKind::Line | ShapeKind::Arrow | ShapeKind::Curve | ShapeKind::Wave,
                    end,
                    ..
                } = &mut node.content
                {
                    end.x += *dx;
                    end.y += *dy;
                } else if let Content::Connector {
                    from_point,
                    to_point,
                    waypoints,
                    ..
                } = &mut node.content
                {
                    if let Some(p) = from_point {
                        p.x += *dx;
                        p.y += *dy;
                    }
                    if let Some(p) = to_point {
                        p.x += *dx;
                        p.y += *dy;
                    }
                    for wp in waypoints {
                        wp.x += *dx;
                        wp.y += *dy;
                    }
                }
            }
            Operation::Translate {
                ids: ids.clone(),
                dx: -*dx,
                dy: -*dy,
            }
        }
        Operation::Group { id, node_ids } => {
            if !valid_id(id) {
                return Err(DomainError::Invalid("invalid group id".into()));
            }
            unique_ids(node_ids, "group")?;
            for nid in node_ids {
                let node = doc
                    .nodes
                    .get_mut(nid)
                    .ok_or_else(|| DomainError::NotFound(nid.clone()))?;
                if node.attrs.group_ids.iter().any(|existing| existing == id) {
                    return Err(DomainError::Duplicate(id.clone()));
                }
                node.attrs.group_ids.push(id.clone());
            }
            Operation::Ungroup {
                id: id.clone(),
                node_ids: node_ids.clone(),
            }
        }
        Operation::Ungroup { id, node_ids } => {
            if !valid_id(id) {
                return Err(DomainError::Invalid("invalid group id".into()));
            }
            unique_ids(node_ids, "ungroup")?;
            for nid in node_ids {
                let node = doc
                    .nodes
                    .get_mut(nid)
                    .ok_or_else(|| DomainError::NotFound(nid.clone()))?;
                if node.attrs.group_ids.last() != Some(id) {
                    return Err(DomainError::Invalid(
                        "group stack mismatch on ungroup".into(),
                    ));
                }
                node.attrs.group_ids.pop();
            }
            Operation::Group {
                id: id.clone(),
                node_ids: node_ids.clone(),
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
        use crate::{
            ConnectorAnchor, ConnectorHead, ConnectorRoute, DEFAULT_CONNECTOR_COLOR,
            DEFAULT_CONNECTOR_WIDTH,
        };
        let mut e = editor();
        let connector = Node {
            attrs: NodeAttrs {
                id: "edge".into(),
                position: Point::default(),
                source: None,
                group_ids: Vec::new(),
            },
            content: Content::Connector {
                from: Some("a".into()),
                to: Some("b".into()),
                from_point: None,
                to_point: None,
                from_anchor: ConnectorAnchor::Auto,
                to_anchor: ConnectorAnchor::Auto,
                route: ConnectorRoute::Elbow,
                start_head: ConnectorHead::None,
                end_head: ConnectorHead::Arrow,
                dashed: false,
                width: DEFAULT_CONNECTOR_WIDTH,
                color: DEFAULT_CONNECTOR_COLOR.into(),
                waypoints: vec![],
                label: Some("因果".into()),
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
        let graph = e.document().semantic_graph();
        assert_eq!(graph.nodes.len(), 2);
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].label.as_deref(), Some("因果"));
        assert!(graph.edges[0].directed);
        assert!(!graph.edges[0].bidirectional);
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
    fn legacy_connector_jsonml_and_free_endpoint_roundtrip() {
        let legacy = serde_json::json!(["connector", {"id": "c1", "position": {"x": 0, "y": 0}, "from": "a", "to": "b"}]);
        let node: Node = serde_json::from_value(legacy).unwrap();
        assert!(matches!(
            node.content,
            Content::Connector {
                from: Some(ref f),
                to: Some(ref t),
                end_head: crate::ConnectorHead::None,
                ..
            } if f == "a" && t == "b"
        ));
        let roundtrip = serde_json::to_value(&node).unwrap();
        assert_eq!(serde_json::from_value::<Node>(roundtrip).unwrap(), node);

        let mut e = editor();
        let free = Node {
            attrs: NodeAttrs {
                id: "c_free".into(),
                position: Point { x: 10.0, y: 20.0 },
                source: None,
                group_ids: Vec::new(),
            },
            content: Content::Connector {
                from: Some("a".into()),
                to: None,
                from_point: None,
                to_point: Some(Point { x: 200.0, y: 120.0 }),
                from_anchor: crate::ConnectorAnchor::Right,
                to_anchor: crate::ConnectorAnchor::Auto,
                route: crate::ConnectorRoute::Curve,
                start_head: crate::ConnectorHead::None,
                end_head: crate::ConnectorHead::Arrow,
                dashed: true,
                width: 4.0,
                color: "#2f6fed".into(),
                waypoints: vec![Point { x: 110.0, y: 50.0 }],
                label: Some("指向屏幕区".into()),
            },
        };
        e.apply(&edit(vec![add("a"), Operation::Insert { node: free }]), 0)
            .unwrap();
        e.apply(
            &edit(vec![Operation::Translate {
                ids: vec!["c_free".into()],
                dx: 15.0,
                dy: -10.0,
            }]),
            1,
        )
        .unwrap();
        assert!(matches!(
            e.document().nodes["c_free"].content,
            Content::Connector {
                to_point: Some(p),
                ref waypoints,
                ..
            } if p == Point { x: 215.0, y: 110.0 } && waypoints == &vec![Point { x: 125.0, y: 40.0 }]
        ));
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

    #[test]
    fn group_ungroup_and_translate_roundtrip_with_undo() {
        let mut e = editor();
        let line = Node {
            attrs: NodeAttrs {
                id: "line1".into(),
                position: Point { x: 10.0, y: 20.0 },
                source: None,
                group_ids: Vec::new(),
            },
            content: Content::Shape {
                kind: ShapeKind::Arrow,
                end: Point { x: 110.0, y: 70.0 },
                width: 4.0,
                color: "#1f2329".into(),
                fill: None,
                corner_radius: None,
                text: None,
                rotation: None,
                points: Vec::new(),
            },
        };
        e.apply(
            &edit(vec![add("a"), add("b"), Operation::Insert { node: line }]),
            0,
        )
        .unwrap();
        e.apply(
            &edit(vec![Operation::Group {
                id: "g1".into(),
                node_ids: vec!["a".into(), "b".into()],
            }]),
            1,
        )
        .unwrap();
        assert_eq!(e.document().nodes["a"].attrs.group_ids, vec!["g1"]);
        assert_eq!(e.document().nodes["b"].attrs.group_ids, vec!["g1"]);
        e.apply(
            &edit(vec![Operation::Group {
                id: "g2".into(),
                node_ids: vec!["a".into(), "b".into(), "line1".into()],
            }]),
            2,
        )
        .unwrap();
        assert_eq!(e.document().nodes["a"].attrs.group_ids, vec!["g1", "g2"]);
        assert_eq!(e.document().nodes["line1"].attrs.group_ids, vec!["g2"]);
        e.apply(
            &edit(vec![Operation::Translate {
                ids: vec!["a".into(), "b".into(), "line1".into()],
                dx: 25.0,
                dy: -10.0,
            }]),
            3,
        )
        .unwrap();
        assert_eq!(
            e.document().nodes["a"].attrs.position,
            Point { x: 25.0, y: -10.0 }
        );
        assert_eq!(
            e.document().nodes["line1"].attrs.position,
            Point { x: 35.0, y: 10.0 }
        );
        assert!(matches!(
            e.document().nodes["line1"].content,
            Content::Shape { end, .. } if end == Point { x: 135.0, y: 60.0 }
        ));
        // Wrong stack order fails atomically
        assert!(
            e.apply(
                &edit(vec![Operation::Ungroup {
                    id: "g1".into(),
                    node_ids: vec!["a".into(), "b".into()],
                }]),
                4
            )
            .is_err()
        );
        e.apply(
            &edit(vec![Operation::Ungroup {
                id: "g2".into(),
                node_ids: vec!["a".into(), "b".into(), "line1".into()],
            }]),
            4,
        )
        .unwrap();
        assert_eq!(e.document().nodes["a"].attrs.group_ids, vec!["g1"]);
        assert!(e.document().nodes["line1"].attrs.group_ids.is_empty());
        // Undo ungroup + translate + group
        e.apply(&Action::Undo, 5).unwrap();
        assert_eq!(e.document().nodes["a"].attrs.group_ids, vec!["g1", "g2"]);
        e.apply(&Action::Undo, 6).unwrap();
        assert_eq!(e.document().nodes["a"].attrs.position, Point::default());
        assert!(matches!(
            e.document().nodes["line1"].content,
            Content::Shape { end, .. } if end == Point { x: 110.0, y: 70.0 }
        ));
        // JSONML roundtrip preserves group_ids and omits empty
        let json_a = serde_json::to_value(&e.document().nodes["a"]).unwrap();
        assert_eq!(json_a[1]["group_ids"], serde_json::json!(["g1", "g2"]));
        assert_eq!(
            serde_json::from_value::<Node>(json_a).unwrap(),
            e.document().nodes["a"]
        );
    }

    #[test]
    fn rejects_invalid_group_ids_and_duplicate_translate_ids() {
        let mut e = editor();
        e.apply(&edit(vec![add("a"), add("b")]), 0).unwrap();
        assert!(
            e.apply(
                &edit(vec![Operation::Translate {
                    ids: vec!["a".into(), "a".into()],
                    dx: 1.0,
                    dy: 1.0,
                }]),
                1
            )
            .is_err()
        );
        assert!(
            e.apply(
                &edit(vec![Operation::Group {
                    id: "bad group!".into(),
                    node_ids: vec!["a".into()],
                }]),
                1
            )
            .is_err()
        );
    }
}
