use serde::{Deserialize, Serialize, de::Error as _, ser::SerializeSeq};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_NODES: usize = 100_000;
pub const MAX_TEXT_BYTES: usize = 256 * 1024;
pub const MAX_STROKE_POINTS: usize = 100_000;

#[derive(Debug, Error, PartialEq)]
pub enum DomainError {
    #[error("unsupported document schema: {0}")]
    UnsupportedVersion(u32),
    #[error("invalid document: {0}")]
    Invalid(String),
    #[error("revision conflict: expected {expected}, actual {actual}")]
    Conflict { expected: u64, actual: u64 },
    #[error("object not found: {0}")]
    NotFound(String),
    #[error("object already exists: {0}")]
    Duplicate(String),
    #[error("no edit to undo or redo")]
    EmptyHistory,
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}

pub fn valid_asset(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub fn valid(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.x.abs() <= 1e9 && self.y.abs() <= 1e9
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SourceRef {
    pub asset: String,
    /// Source coordinates, independent of canvas position. Width and height are positive.
    pub rect: [f64; 4],
    pub page: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NodeAttrs {
    pub id: String,
    pub position: Point,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceRef>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrushStyle {
    #[default]
    Pen,
    Highlighter,
    Pencil,
    Fountain,
    Marker,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShapeKind {
    Line,
    Arrow,
    Rectangle,
    Ellipse,
}

pub const fn default_opacity() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct InkPoint {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
    pub elapsed_ms: u32,
}

/// Closed, typed content schema. Card children are blocks, never arbitrary objects.
#[derive(Debug, Clone, PartialEq)]
pub enum Content {
    DerivationCard {
        pinned: bool,
        children: Vec<Block>,
    },
    Paragraph {
        text: String,
    },
    MathBlock {
        latex: String,
    },
    Image {
        asset: String,
        width: f64,
        height: f64,
    },
    Stroke {
        points: Vec<InkPoint>,
        width: f64,
        color: String,
        brush: BrushStyle,
        opacity: f64,
    },
    Shape {
        kind: ShapeKind,
        end: Point,
        width: f64,
        color: String,
    },
    Connector {
        from: String,
        to: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Block {
    Paragraph { text: String },
    MathBlock { latex: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub attrs: NodeAttrs,
    pub content: Content,
}

// A node is real JSONML: [tag, attributes, child...]. Block payloads are bounded,
// nonrecursive JSONML children; Rust callers never manipulate untyped node state.
impl Serialize for Node {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut attrs = serde_json::to_value(&self.attrs).map_err(serde::ser::Error::custom)?;
        let mut children = Vec::new();
        let tag = match &self.content {
            Content::DerivationCard {
                pinned,
                children: blocks,
            } => {
                attrs["pinned"] = (*pinned).into();
                for block in blocks {
                    children.push(match block {
                        Block::Paragraph { text } => {
                            serde_json::json!(["paragraph", {}, ["text", text]])
                        }
                        Block::MathBlock { latex } => {
                            serde_json::json!(["math_block", {"latex": latex}])
                        }
                    });
                }
                "derivation_card"
            }
            Content::Paragraph { text } => {
                children.push(serde_json::json!(["text", text]));
                "paragraph"
            }
            Content::MathBlock { latex } => {
                attrs["latex"] = latex.clone().into();
                "math_block"
            }
            Content::Image {
                asset,
                width,
                height,
            } => {
                attrs["asset"] = asset.clone().into();
                attrs["width"] = (*width).into();
                attrs["height"] = (*height).into();
                "image"
            }
            Content::Stroke {
                points,
                width,
                color,
                brush,
                opacity,
            } => {
                attrs["points"] =
                    serde_json::to_value(points).map_err(serde::ser::Error::custom)?;
                attrs["width"] = (*width).into();
                attrs["color"] = color.clone().into();
                if *brush != BrushStyle::Pen {
                    attrs["brush"] =
                        serde_json::to_value(brush).map_err(serde::ser::Error::custom)?;
                }
                if (*opacity - 1.0).abs() > 1e-6 {
                    attrs["opacity"] = (*opacity).into();
                }
                "stroke"
            }
            Content::Shape {
                kind,
                end,
                width,
                color,
            } => {
                attrs["kind"] = serde_json::to_value(kind).map_err(serde::ser::Error::custom)?;
                attrs["end"] = serde_json::to_value(end).map_err(serde::ser::Error::custom)?;
                attrs["width"] = (*width).into();
                attrs["color"] = color.clone().into();
                "shape"
            }
            Content::Connector { from, to } => {
                attrs["from"] = from.clone().into();
                attrs["to"] = to.clone().into();
                "connector"
            }
        };
        let mut seq = serializer.serialize_seq(Some(2 + children.len()))?;
        seq.serialize_element(tag)?;
        seq.serialize_element(&attrs)?;
        for child in children {
            seq.serialize_element(&child)?;
        }
        seq.end()
    }
}

fn take<T: serde::de::DeserializeOwned>(
    attrs: &mut serde_json::Map<String, Value>,
    key: &str,
) -> Result<T, String> {
    serde_json::from_value(attrs.remove(key).ok_or_else(|| format!("missing {key}"))?)
        .map_err(|e| e.to_string())
}

fn parse_text(v: &Value) -> Result<String, String> {
    let a = v.as_array().ok_or("text child must be an array")?;
    if a.len() != 2 || a[0] != "text" {
        return Err("invalid text child".into());
    }
    a[1].as_str()
        .map(String::from)
        .ok_or("text must be a string".into())
}

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let parts = Vec::<Value>::deserialize(d)?;
        let parse = || -> Result<Self, String> {
            if parts.len() < 2 {
                return Err("JSONML requires a tag and attributes".into());
            }
            let tag = parts[0].as_str().ok_or("invalid JSONML tag")?;
            let mut a = parts[1]
                .as_object()
                .cloned()
                .ok_or("invalid JSONML attributes")?;
            let children = &parts[2..];
            if tag != "derivation_card" && tag != "paragraph" && !children.is_empty() {
                return Err("unexpected JSONML children".into());
            }
            let content = match tag {
                "derivation_card" => {
                    let pinned = take(&mut a, "pinned")?;
                    if children.len() > 1024 {
                        return Err("too many card blocks".into());
                    }
                    let mut blocks = Vec::new();
                    for c in children {
                        let p = c.as_array().ok_or("invalid card block")?;
                        match p.first().and_then(Value::as_str) {
                            Some("paragraph") if p.len() == 3 && p[1] == serde_json::json!({}) => {
                                blocks.push(Block::Paragraph {
                                    text: parse_text(&p[2])?,
                                })
                            }
                            Some("math_block")
                                if p.len() == 2
                                    && p[1].as_object().is_some_and(|a| a.len() == 1) =>
                            {
                                blocks.push(Block::MathBlock {
                                    latex: serde_json::from_value(p[1]["latex"].clone())
                                        .map_err(|e| e.to_string())?,
                                })
                            }
                            _ => return Err("unknown or malformed card block".into()),
                        }
                    }
                    Content::DerivationCard {
                        pinned,
                        children: blocks,
                    }
                }
                "paragraph" if children.len() == 1 => Content::Paragraph {
                    text: parse_text(&children[0])?,
                },
                "math_block" => Content::MathBlock {
                    latex: take(&mut a, "latex")?,
                },
                "image" => Content::Image {
                    asset: take(&mut a, "asset")?,
                    width: take(&mut a, "width")?,
                    height: take(&mut a, "height")?,
                },
                "stroke" => {
                    let points = take(&mut a, "points")?;
                    let width = take(&mut a, "width")?;
                    let color = take(&mut a, "color")?;
                    let brush = match a.remove("brush") {
                        Some(v) => serde_json::from_value(v).map_err(|e| e.to_string())?,
                        None => BrushStyle::Pen,
                    };
                    let opacity = match a.remove("opacity") {
                        Some(v) => serde_json::from_value(v).map_err(|e| e.to_string())?,
                        None => 1.0,
                    };
                    Content::Stroke {
                        points,
                        width,
                        color,
                        brush,
                        opacity,
                    }
                }
                "shape" => Content::Shape {
                    kind: take(&mut a, "kind")?,
                    end: take(&mut a, "end")?,
                    width: take(&mut a, "width")?,
                    color: take(&mut a, "color")?,
                },
                "connector" => Content::Connector {
                    from: take(&mut a, "from")?,
                    to: take(&mut a, "to")?,
                },
                _ => return Err(format!("unknown or malformed JSONML tag: {tag}")),
            };
            let attrs: NodeAttrs =
                serde_json::from_value(Value::Object(a)).map_err(|e| e.to_string())?;
            let node = Self { attrs, content };
            node.validate().map_err(|e| e.to_string())?;
            Ok(node)
        };
        parse().map_err(D::Error::custom)
    }
}

impl Node {
    pub fn paragraph(id: impl Into<String>, text: impl Into<String>, position: Point) -> Self {
        Self {
            attrs: NodeAttrs {
                id: id.into(),
                position,
                source: None,
            },
            content: Content::Paragraph { text: text.into() },
        }
    }
    pub fn validate(&self) -> Result<(), DomainError> {
        let invalid = |s: &str| DomainError::Invalid(s.into());
        if !valid_id(&self.attrs.id) || !self.attrs.position.valid() {
            return Err(invalid("invalid object identity or position"));
        }
        if let Some(s) = &self.attrs.source
            && (!valid_asset(&s.asset)
                || !s.rect.iter().all(|v| v.is_finite() && v.abs() <= 1e9)
                || s.rect[2] <= 0.0
                || s.rect[3] <= 0.0
                || s.page == Some(0))
        {
            return Err(invalid("invalid source reference"));
        }
        let text_ok = |s: &str| {
            if s.len() <= MAX_TEXT_BYTES {
                Ok(())
            } else {
                Err(invalid("text budget exceeded"))
            }
        };
        match &self.content {
            Content::DerivationCard { children, .. } => {
                if children.len() > 1024 {
                    return Err(invalid("card block budget exceeded"));
                }
                for b in children {
                    match b {
                        Block::Paragraph { text } => text_ok(text)?,
                        Block::MathBlock { latex } => text_ok(latex)?,
                    }
                }
            }
            Content::Paragraph { text } => text_ok(text)?,
            Content::MathBlock { latex } => text_ok(latex)?,
            Content::Image {
                asset,
                width,
                height,
            } => {
                if !valid_asset(asset)
                    || !width.is_finite()
                    || !height.is_finite()
                    || *width <= 0.0
                    || *height <= 0.0
                {
                    return Err(invalid("invalid image"));
                }
            }
            Content::Stroke {
                points,
                width,
                color,
                opacity,
                ..
            } => {
                if points.is_empty()
                    || points.len() > MAX_STROKE_POINTS
                    || !width.is_finite()
                    || *width <= 0.0
                    || *width > 1024.0
                    || !opacity.is_finite()
                    || !(*opacity > 0.0 && *opacity <= 1.0)
                    || color.len() != 7
                    || !color.starts_with('#')
                    || !color[1..].bytes().all(|c| c.is_ascii_hexdigit())
                {
                    return Err(invalid("invalid stroke"));
                }
                let mut previous = 0;
                for p in points {
                    if !(Point { x: p.x, y: p.y }).valid()
                        || !p.pressure.is_finite()
                        || !(0.0..=1.0).contains(&p.pressure)
                        || p.elapsed_ms < previous
                    {
                        return Err(invalid("invalid stroke sample"));
                    }
                    previous = p.elapsed_ms;
                }
            }
            Content::Shape {
                kind,
                end,
                width,
                color,
            } => {
                if !end.valid()
                    || !width.is_finite()
                    || *width <= 0.0
                    || *width > 1024.0
                    || color.len() != 7
                    || !color.starts_with('#')
                    || !color[1..].bytes().all(|c| c.is_ascii_hexdigit())
                {
                    return Err(invalid("invalid shape"));
                }
                match kind {
                    ShapeKind::Rectangle | ShapeKind::Ellipse => {
                        if end.x <= 0.0 || end.y <= 0.0 {
                            return Err(invalid("shape dimensions must be positive"));
                        }
                    }
                    ShapeKind::Line | ShapeKind::Arrow => {
                        if (end.x - self.attrs.position.x).hypot(end.y - self.attrs.position.y)
                            <= 0.0
                        {
                            return Err(invalid("line shape length must be positive"));
                        }
                    }
                }
            }
            Content::Connector { from, to } => {
                if !valid_id(from) || !valid_id(to) || from == to {
                    return Err(invalid("invalid connector endpoints"));
                }
            }
        }
        Ok(())
    }
    pub fn asset_hashes(&self) -> impl Iterator<Item = &str> {
        self.attrs
            .source
            .as_ref()
            .map(|s| s.asset.as_str())
            .into_iter()
            .chain(match &self.content {
                Content::Image { asset, .. } => Some(asset.as_str()),
                _ => None,
            })
    }
    pub fn search_text(&self) -> String {
        match &self.content {
            Content::Paragraph { text } => text.clone(),
            Content::MathBlock { latex } => latex.clone(),
            Content::DerivationCard { children, .. } => children
                .iter()
                .map(|b| match b {
                    Block::Paragraph { text } => text.as_str(),
                    Block::MathBlock { latex } => latex.as_str(),
                })
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub nodes: BTreeMap<String, Node>,
}

impl Document {
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Result<Self, DomainError> {
        let document = Self {
            schema_version: SCHEMA_VERSION,
            id: id.into(),
            title: title.into(),
            revision: 0,
            nodes: BTreeMap::new(),
        };
        document.validate()?;
        Ok(document)
    }
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(DomainError::UnsupportedVersion(self.schema_version));
        }
        if !valid_id(&self.id)
            || self.title.trim().is_empty()
            || self.title.len() > 512
            || self.nodes.len() > MAX_NODES
            || self.revision > i64::MAX as u64
        {
            return Err(DomainError::Invalid(
                "document identity, title, revision or node budget".into(),
            ));
        }
        for (id, node) in &self.nodes {
            node.validate()?;
            if id != &node.attrs.id {
                return Err(DomainError::Invalid(
                    "node map key differs from stable id".into(),
                ));
            }
            if let Content::Connector { from, to } = &node.content {
                for endpoint in [from, to] {
                    let target = self
                        .nodes
                        .get(endpoint)
                        .ok_or_else(|| DomainError::NotFound(endpoint.clone()))?;
                    if matches!(target.content, Content::Connector { .. }) {
                        return Err(DomainError::Invalid(
                            "connector cannot target another connector".into(),
                        ));
                    }
                }
            }
        }
        Ok(())
    }
    pub fn asset_hashes(&self) -> BTreeSet<&str> {
        self.nodes.values().flat_map(Node::asset_hashes).collect()
    }
}
