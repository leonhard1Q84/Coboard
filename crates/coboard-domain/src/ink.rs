use crate::{BrushStyle, Content, InkPoint, Node, NodeAttrs, Operation, Point, ShapeKind};

/// 1€ Filter for adaptive low-pass smoothing of 2D pointer streams.
/// Eliminates low-speed jitter while keeping fast stroke latency minimal.
#[derive(Debug, Clone)]
pub struct OneEuroFilter2D {
    min_cutoff: f64,
    beta: f64,
    d_cutoff: f64,
    prev_x: Option<f64>,
    prev_y: Option<f64>,
    dx: f64,
    dy: f64,
    prev_ms: Option<u32>,
}

impl Default for OneEuroFilter2D {
    fn default() -> Self {
        Self::new(1.2, 0.007, 1.0)
    }
}

fn alpha(dt: f64, cutoff: f64) -> f64 {
    let tau = 1.0 / (2.0 * std::f64::consts::PI * cutoff.max(1e-6));
    1.0 / (1.0 + tau / dt.max(1e-6))
}

impl OneEuroFilter2D {
    pub fn new(min_cutoff: f64, beta: f64, d_cutoff: f64) -> Self {
        Self {
            min_cutoff,
            beta,
            d_cutoff,
            prev_x: None,
            prev_y: None,
            dx: 0.0,
            dy: 0.0,
            prev_ms: None,
        }
    }

    pub fn filter(&mut self, point: InkPoint) -> InkPoint {
        let Some(prev_ms) = self.prev_ms else {
            self.prev_x = Some(point.x);
            self.prev_y = Some(point.y);
            self.prev_ms = Some(point.elapsed_ms);
            return point;
        };
        let dt = ((point.elapsed_ms.saturating_sub(prev_ms)).max(1) as f64) / 1000.0;
        let prev_x = self.prev_x.unwrap_or(point.x);
        let prev_y = self.prev_y.unwrap_or(point.y);
        let ad = alpha(dt, self.d_cutoff);
        let raw_dx = (point.x - prev_x) / dt;
        let raw_dy = (point.y - prev_y) / dt;
        self.dx = ad * raw_dx + (1.0 - ad) * self.dx;
        self.dy = ad * raw_dy + (1.0 - ad) * self.dy;
        let speed = self.dx.hypot(self.dy);
        let cutoff = self.min_cutoff + self.beta * speed;
        let a = alpha(dt, cutoff);
        let x = a * point.x + (1.0 - a) * prev_x;
        let y = a * point.y + (1.0 - a) * prev_y;
        self.prev_x = Some(x);
        self.prev_y = Some(y);
        self.prev_ms = Some(point.elapsed_ms);
        InkPoint {
            x,
            y,
            pressure: point.pressure.clamp(0.0, 1.0),
            elapsed_ms: point.elapsed_ms,
        }
    }

    pub fn filter_stroke(points: &[InkPoint]) -> Vec<InkPoint> {
        let mut filter = Self::default();
        points.iter().cloned().map(|p| filter.filter(p)).collect()
    }
}

/// Generates a closed variable-width outline polygon for dynamic freehand ink.
pub fn stroke_outline(points: &[InkPoint], base_width: f64, brush: BrushStyle) -> Vec<Point> {
    if points.is_empty() || !base_width.is_finite() || base_width <= 0.0 {
        return Vec::new();
    }
    if points.len() == 1 {
        let p = &points[0];
        let r = (base_width * 0.5 * (0.4 + 0.6 * p.pressure.clamp(0.0, 1.0))).max(0.5);
        return (0..8)
            .map(|i| {
                let angle = (i as f64) * std::f64::consts::TAU / 8.0;
                Point {
                    x: p.x + r * angle.cos(),
                    y: p.y + r * angle.sin(),
                }
            })
            .collect();
    }
    let mut left = Vec::with_capacity(points.len());
    let mut right = Vec::with_capacity(points.len());
    for i in 0..points.len() {
        let curr = &points[i];
        let prev = if i > 0 { &points[i - 1] } else { curr };
        let next = if i + 1 < points.len() {
            &points[i + 1]
        } else {
            curr
        };
        let mut tx = next.x - prev.x;
        let mut ty = next.y - prev.y;
        let len = tx.hypot(ty);
        if len > 1e-6 {
            tx /= len;
            ty /= len;
        } else {
            tx = 1.0;
            ty = 0.0;
        }
        let nx = -ty;
        let ny = tx;
        let radius = match brush {
            BrushStyle::Highlighter | BrushStyle::Marker => base_width * 0.5,
            BrushStyle::Pencil => base_width * (0.25 + 0.25 * curr.pressure),
            BrushStyle::Fountain => base_width * (0.2 + 0.6 * (nx * 0.707 + ny * 0.707).abs()),
            BrushStyle::Pen => {
                let dt = (curr.elapsed_ms.saturating_sub(prev.elapsed_ms).max(1) as f64) / 1000.0;
                let speed = (curr.x - prev.x).hypot(curr.y - prev.y) / dt;
                let speed_factor = (1.0 - (speed / 3500.0).min(0.45)).max(0.55);
                let pressure_factor = 0.35 + 0.65 * curr.pressure.clamp(0.0, 1.0);
                let taper = if i == 0 || i + 1 == points.len() {
                    0.65
                } else {
                    1.0
                };
                (base_width * 0.5 * pressure_factor * speed_factor * taper).max(0.5)
            }
        };
        left.push(Point {
            x: curr.x + nx * radius,
            y: curr.y + ny * radius,
        });
        right.push(Point {
            x: curr.x - nx * radius,
            y: curr.y - ny * radius,
        });
    }
    right.reverse();
    left.extend(right);
    left
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecognizedShape {
    pub kind: ShapeKind,
    pub position: Point,
    pub end: Point,
}

fn point_segment_distance(p: Point, a: Point, b: Point) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let l2 = dx * dx + dy * dy;
    if l2 <= 1e-9 {
        return (p.x - a.x).hypot(p.y - a.y);
    }
    let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / l2).clamp(0.0, 1.0);
    let proj_x = a.x + t * dx;
    let proj_y = a.y + t * dy;
    (p.x - proj_x).hypot(p.y - proj_y)
}

/// Recognizes freehand strokes on pause (INK-10) into clean geometric primitives:
/// Line, Rectangle, or Ellipse.
pub fn recognize_shape(points: &[InkPoint], node_offset: Point) -> Option<RecognizedShape> {
    if points.len() < 4 {
        return None;
    }
    let world: Vec<Point> = points
        .iter()
        .map(|p| Point {
            x: p.x + node_offset.x,
            y: p.y + node_offset.y,
        })
        .collect();
    let first = *world.first()?;
    let last = *world.last()?;
    let mut path_len = 0.0;
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for (i, p) in world.iter().enumerate() {
        min_x = min_x.min(p.x);
        min_y = min_y.min(p.y);
        max_x = max_x.max(p.x);
        max_y = max_y.max(p.y);
        if i > 0 {
            path_len += (p.x - world[i - 1].x).hypot(p.y - world[i - 1].y);
        }
    }
    if path_len < 24.0 {
        return None;
    }
    let direct = (last.x - first.x).hypot(last.y - first.y);
    let max_dev = world
        .iter()
        .map(|&p| point_segment_distance(p, first, last))
        .fold(0.0_f64, f64::max);
    if direct / path_len >= 0.91 && max_dev <= (direct * 0.08).max(8.0) {
        return Some(RecognizedShape {
            kind: ShapeKind::Line,
            position: first,
            end: last,
        });
    }
    let w = max_x - min_x;
    let h = max_y - min_y;
    let diag = w.hypot(h);
    if w < 18.0 || h < 18.0 || direct > diag * 0.38 {
        return None;
    }
    let rect_err: f64 = world
        .iter()
        .map(|p| {
            let dx = (p.x - min_x).abs().min((max_x - p.x).abs());
            let dy = (p.y - min_y).abs().min((max_y - p.y).abs());
            dx.min(dy)
        })
        .sum::<f64>()
        / (world.len() as f64 * diag);
    let cx = (min_x + max_x) * 0.5;
    let cy = (min_y + max_y) * 0.5;
    let rx = w * 0.5;
    let ry = h * 0.5;
    let ellipse_err: f64 = world
        .iter()
        .map(|p| {
            let nx = (p.x - cx) / rx;
            let ny = (p.y - cy) / ry;
            let r = nx.hypot(ny);
            (r - 1.0).abs() * rx.min(ry)
        })
        .sum::<f64>()
        / (world.len() as f64 * diag);
    if rect_err <= 0.075 && rect_err <= ellipse_err * 0.92 {
        return Some(RecognizedShape {
            kind: ShapeKind::Rectangle,
            position: Point { x: min_x, y: min_y },
            end: Point { x: w, y: h },
        });
    }
    if ellipse_err <= 0.085 {
        return Some(RecognizedShape {
            kind: ShapeKind::Ellipse,
            position: Point { x: min_x, y: min_y },
            end: Point { x: w, y: h },
        });
    }
    None
}

fn erased_by_path(pt: Point, offset: Point, eraser: &[Point], radius: f64) -> bool {
    let world = Point {
        x: pt.x + offset.x,
        y: pt.y + offset.y,
    };
    if eraser.len() == 1 {
        return (world.x - eraser[0].x).hypot(world.y - eraser[0].y) <= radius;
    }
    eraser
        .windows(2)
        .any(|w| point_segment_distance(world, w[0], w[1]) <= radius)
}

fn stroke_hits_eraser(node: &Node, eraser: &[Point], radius: f64) -> bool {
    let Content::Stroke { points, width, .. } = &node.content else {
        return false;
    };
    let hit_radius = (radius + width * 0.5).max(1.0);
    let offset = node.attrs.position;
    if points
        .iter()
        .any(|p| erased_by_path(Point { x: p.x, y: p.y }, offset, eraser, hit_radius))
    {
        return true;
    }
    for seg in points.windows(2) {
        let steps =
            (((seg[1].x - seg[0].x).hypot(seg[1].y - seg[0].y) / 6.0).ceil() as usize).clamp(1, 32);
        for s in 1..steps {
            let t = (s as f64) / (steps as f64);
            let sample = Point {
                x: seg[0].x + (seg[1].x - seg[0].x) * t,
                y: seg[0].y + (seg[1].y - seg[0].y) * t,
            };
            if erased_by_path(sample, offset, eraser, hit_radius) {
                return true;
            }
        }
    }
    false
}

/// Whole-stroke eraser (INK-03 mode 1): returns Delete operations for any stroke hit by the path.
pub fn erase_whole_strokes<'a>(
    nodes: impl IntoIterator<Item = &'a Node>,
    eraser: &[Point],
    radius: f64,
) -> Vec<Operation> {
    if eraser.is_empty() || !radius.is_finite() || radius <= 0.0 {
        return Vec::new();
    }
    nodes
        .into_iter()
        .filter(|node| stroke_hits_eraser(node, eraser, radius))
        .map(|node| Operation::Delete {
            id: node.attrs.id.clone(),
        })
        .collect()
}

/// Partial/pixel eraser (INK-03 mode 2): splits intersected strokes into remaining sub-strokes.
pub fn erase_partial_stroke(node: &Node, eraser: &[Point], radius: f64) -> Vec<Operation> {
    let Content::Stroke {
        points,
        width,
        color,
        brush,
        opacity,
    } = &node.content
    else {
        return Vec::new();
    };
    if eraser.is_empty()
        || !radius.is_finite()
        || radius <= 0.0
        || !stroke_hits_eraser(node, eraser, radius)
    {
        return Vec::new();
    }
    let hit_radius = (radius + width * 0.5).max(1.0);
    let offset = node.attrs.position;
    let mut dense = Vec::with_capacity(points.len() * 2);
    for (idx, p) in points.iter().enumerate() {
        if idx > 0 {
            let prev = &points[idx - 1];
            let dist = (p.x - prev.x).hypot(p.y - prev.y);
            let steps = ((dist / 4.0).ceil() as usize).clamp(1, 32);
            for s in 1..steps {
                let t = (s as f64) / (steps as f64);
                dense.push(InkPoint {
                    x: prev.x + (p.x - prev.x) * t,
                    y: prev.y + (p.y - prev.y) * t,
                    pressure: prev.pressure + (p.pressure - prev.pressure) * t,
                    elapsed_ms: prev.elapsed_ms
                        + (((p.elapsed_ms.saturating_sub(prev.elapsed_ms)) as f64) * t) as u32,
                });
            }
        }
        dense.push(p.clone());
    }
    let mut segments: Vec<Vec<InkPoint>> = Vec::new();
    let mut current: Vec<InkPoint> = Vec::new();
    for p in dense {
        if erased_by_path(Point { x: p.x, y: p.y }, offset, eraser, hit_radius) {
            if current.len() >= 2 {
                segments.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        } else {
            current.push(p);
        }
    }
    if current.len() >= 2 {
        segments.push(current);
    }
    let mut ops = vec![Operation::Delete {
        id: node.attrs.id.clone(),
    }];
    for (i, mut seg) in segments.into_iter().enumerate() {
        if let Some(first_ms) = seg.first().map(|p| p.elapsed_ms) {
            for p in &mut seg {
                p.elapsed_ms = p.elapsed_ms.saturating_sub(first_ms);
            }
        }
        let base_id = &node.attrs.id;
        let suffix = format!("_s{i}");
        let prefix_len = base_id.len().min(128usize.saturating_sub(suffix.len()));
        let child_id = format!("{}{suffix}", &base_id[..prefix_len]);
        ops.push(Operation::Insert {
            node: Node {
                attrs: NodeAttrs {
                    id: child_id,
                    position: node.attrs.position,
                    source: node.attrs.source.clone(),
                },
                content: Content::Stroke {
                    points: seg,
                    width: *width,
                    color: color.clone(),
                    brush: *brush,
                    opacity: *opacity,
                },
            },
        });
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Action, Document, Editor};

    fn sample_stroke(id: &str, points: Vec<InkPoint>) -> Node {
        Node {
            attrs: NodeAttrs {
                id: id.into(),
                position: Point::default(),
                source: None,
            },
            content: Content::Stroke {
                points,
                width: 4.0,
                color: "#2b3a51".into(),
                brush: BrushStyle::Pen,
                opacity: 1.0,
            },
        }
    }

    #[test]
    fn one_euro_filter_smooths_jitter_and_preserves_bounds() {
        let raw = vec![
            InkPoint {
                x: 0.0,
                y: 0.0,
                pressure: 0.5,
                elapsed_ms: 0,
            },
            InkPoint {
                x: 1.0,
                y: 2.5,
                pressure: 0.6,
                elapsed_ms: 8,
            },
            InkPoint {
                x: 2.0,
                y: -2.0,
                pressure: 0.7,
                elapsed_ms: 16,
            },
            InkPoint {
                x: 3.0,
                y: 1.5,
                pressure: 0.8,
                elapsed_ms: 24,
            },
        ];
        let smoothed = OneEuroFilter2D::filter_stroke(&raw);
        assert_eq!(smoothed.len(), raw.len());
        assert_eq!(smoothed[0], raw[0]);
        assert!((smoothed[2].y).abs() < (raw[2].y).abs());
    }

    #[test]
    fn dynamic_outline_generates_closed_polygon() {
        let pts = vec![
            InkPoint {
                x: 10.0,
                y: 10.0,
                pressure: 0.3,
                elapsed_ms: 0,
            },
            InkPoint {
                x: 40.0,
                y: 12.0,
                pressure: 0.9,
                elapsed_ms: 16,
            },
            InkPoint {
                x: 80.0,
                y: 15.0,
                pressure: 0.4,
                elapsed_ms: 32,
            },
        ];
        let poly = stroke_outline(&pts, 6.0, BrushStyle::Pen);
        assert_eq!(poly.len(), pts.len() * 2);
        assert!(poly.iter().all(|p| p.valid()));
    }

    #[test]
    fn shape_recognition_classifies_line_rectangle_and_ellipse() {
        let line: Vec<InkPoint> = (0..10)
            .map(|i| InkPoint {
                x: (i as f64) * 15.0,
                y: (i as f64) * 5.0 + ((i % 2) as f64) * 0.4,
                pressure: 0.5,
                elapsed_ms: i * 16,
            })
            .collect();
        let recognized_line = recognize_shape(&line, Point::default()).unwrap();
        assert_eq!(recognized_line.kind, ShapeKind::Line);

        let mut rect = Vec::new();
        let mut t = 0;
        for i in 0..=10 {
            rect.push(InkPoint {
                x: (i as f64) * 10.0,
                y: 0.0,
                pressure: 0.5,
                elapsed_ms: t,
            });
            t += 8;
        }
        for i in 1..=8 {
            rect.push(InkPoint {
                x: 100.0,
                y: (i as f64) * 10.0,
                pressure: 0.5,
                elapsed_ms: t,
            });
            t += 8;
        }
        for i in (0..10).rev() {
            rect.push(InkPoint {
                x: (i as f64) * 10.0,
                y: 80.0,
                pressure: 0.5,
                elapsed_ms: t,
            });
            t += 8;
        }
        for i in (0..8).rev() {
            rect.push(InkPoint {
                x: 0.0,
                y: (i as f64) * 10.0,
                pressure: 0.5,
                elapsed_ms: t,
            });
            t += 8;
        }
        let recognized_rect = recognize_shape(&rect, Point::default()).unwrap();
        assert_eq!(recognized_rect.kind, ShapeKind::Rectangle);
        assert_eq!(recognized_rect.position, Point { x: 0.0, y: 0.0 });
        assert_eq!(recognized_rect.end, Point { x: 100.0, y: 80.0 });

        let circle: Vec<InkPoint> = (0..=36)
            .map(|i| {
                let angle = (i as f64) * std::f64::consts::TAU / 36.0;
                InkPoint {
                    x: 100.0 + 50.0 * angle.cos(),
                    y: 100.0 + 40.0 * angle.sin(),
                    pressure: 0.5,
                    elapsed_ms: i * 8,
                }
            })
            .collect();
        let recognized_ellipse = recognize_shape(&circle, Point::default()).unwrap();
        assert_eq!(recognized_ellipse.kind, ShapeKind::Ellipse);
    }

    #[test]
    fn dual_mode_eraser_supports_whole_and_partial_split_with_undo() {
        let mut editor = Editor::new(Document::new("doc", "擦除测试").unwrap()).unwrap();
        let stroke = sample_stroke(
            "s1",
            vec![
                InkPoint {
                    x: 0.0,
                    y: 50.0,
                    pressure: 0.5,
                    elapsed_ms: 0,
                },
                InkPoint {
                    x: 50.0,
                    y: 50.0,
                    pressure: 0.5,
                    elapsed_ms: 20,
                },
                InkPoint {
                    x: 100.0,
                    y: 50.0,
                    pressure: 0.5,
                    elapsed_ms: 40,
                },
            ],
        );
        editor
            .apply(
                &Action::Edit {
                    operations: vec![Operation::Insert {
                        node: stroke.clone(),
                    }],
                },
                0,
            )
            .unwrap();
        let eraser_path = vec![Point { x: 50.0, y: 30.0 }, Point { x: 50.0, y: 70.0 }];
        let partial_ops = erase_partial_stroke(&stroke, &eraser_path, 8.0);
        assert_eq!(partial_ops.len(), 3);
        editor
            .apply(
                &Action::Edit {
                    operations: partial_ops,
                },
                1,
            )
            .unwrap();
        assert!(!editor.document().nodes.contains_key("s1"));
        assert!(editor.document().nodes.contains_key("s1_s0"));
        assert!(editor.document().nodes.contains_key("s1_s1"));
        editor.apply(&Action::Undo, 2).unwrap();
        assert!(editor.document().nodes.contains_key("s1"));

        let whole_ops = erase_whole_strokes(editor.document().nodes.values(), &eraser_path, 8.0);
        assert_eq!(whole_ops, vec![Operation::Delete { id: "s1".into() }]);
    }
}
