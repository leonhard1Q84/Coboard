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
    pub points: Vec<Point>,
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

fn point_line_distance(p: Point, a: Point, b: Point) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len = dx.hypot(dy);
    if len <= 1e-9 {
        return (p.x - a.x).hypot(p.y - a.y);
    }
    ((p.x - a.x) * dy - (p.y - a.y) * dx).abs() / len
}

fn snap_line_endpoint(first: Point, last: Point) -> Point {
    let dx = last.x - first.x;
    let dy = last.y - first.y;
    if dy.abs() <= dx.abs() * 0.06 {
        Point {
            x: last.x,
            y: first.y,
        }
    } else if dx.abs() <= dy.abs() * 0.06 {
        Point {
            x: first.x,
            y: last.y,
        }
    } else {
        last
    }
}

fn try_recognize_wave(
    world: &[Point],
    first: Point,
    last: Point,
    path_len: f64,
) -> Option<RecognizedShape> {
    let direct = (last.x - first.x).hypot(last.y - first.y);
    if direct < 36.0 || path_len < 44.0 || direct / path_len < 0.35 {
        return None;
    }
    let ux = (last.x - first.x) / direct;
    let uy = (last.y - first.y) / direct;
    let nx = -uy;
    let ny = ux;
    let mut along = Vec::with_capacity(world.len());
    let mut perp = Vec::with_capacity(world.len());
    let mut backtrack = 0.0;
    let mut prev_along = 0.0;
    for (i, &p) in world.iter().enumerate() {
        let vx = p.x - first.x;
        let vy = p.y - first.y;
        let a = vx * ux + vy * uy;
        let q = vx * nx + vy * ny;
        if a < -direct * 0.12 || a > direct * 1.12 {
            return None;
        }
        if i > 0 && a < prev_along {
            backtrack += prev_along - a;
        }
        prev_along = a;
        along.push(a);
        perp.push(q);
    }
    if backtrack > direct * 0.22 {
        return None;
    }
    let min_prominence = (direct * 0.025).max(5.0);
    let mut extrema: Vec<f64> = Vec::new();
    let mut cur_sign = 0_i32;
    let mut cur_ext = 0.0_f64;
    for &q in &perp {
        if cur_sign == 0 {
            if q.abs() >= min_prominence {
                cur_sign = if q > 0.0 { 1 } else { -1 };
                cur_ext = q;
            }
        } else if (cur_sign > 0 && q > cur_ext) || (cur_sign < 0 && q < cur_ext) {
            cur_ext = q;
        } else if (cur_sign > 0 && q <= -min_prominence) || (cur_sign < 0 && q >= min_prominence) {
            extrema.push(cur_ext);
            cur_sign = if q > 0.0 { 1 } else { -1 };
            cur_ext = q;
        }
    }
    if cur_sign != 0 && cur_ext.abs() >= min_prominence {
        extrema.push(cur_ext);
    }
    if extrema.len() < 3 {
        return None;
    }
    let mut mags: Vec<f64> = extrema.iter().map(|v| v.abs()).collect();
    mags.sort_by(f64::total_cmp);
    let min_mag = mags[0];
    let max_mag = *mags.last()?;
    if max_mag > direct * 0.45 || min_mag < max_mag * 0.35 {
        return None;
    }
    let amp = mags[mags.len() / 2];
    if amp < 5.0 {
        return None;
    }
    let sign = if extrema[0] >= 0.0 { 1.0 } else { -1.0 };
    let cycles = (extrema.len() as f64) * 0.5;
    let err_sq: f64 = along
        .iter()
        .zip(perp.iter())
        .map(|(&a, &q)| {
            let t = (a / direct).clamp(0.0, 1.0);
            let pred = sign * amp * (std::f64::consts::TAU * cycles * t).sin();
            (q - pred).powi(2)
        })
        .sum::<f64>();
    let rmse = (err_sq / world.len() as f64).sqrt();
    if rmse / amp > 0.45 {
        return None;
    }
    let snapped_end = snap_line_endpoint(first, last);
    Some(RecognizedShape {
        kind: ShapeKind::Wave,
        position: first,
        end: snapped_end,
        points: vec![Point {
            x: cycles * sign,
            y: amp,
        }],
    })
}

fn try_recognize_curve(
    world: &[Point],
    first: Point,
    last: Point,
    path_len: f64,
    diag: f64,
) -> Option<RecognizedShape> {
    let direct = (last.x - first.x).hypot(last.y - first.y);
    if direct < 24.0 || direct < diag * 0.35 || path_len > direct * 2.4 {
        return None;
    }
    let ux = (last.x - first.x) / direct;
    let uy = (last.y - first.y) / direct;
    let nx = -uy;
    let ny = ux;
    let mut pos_sum = 0.0;
    let mut neg_sum = 0.0;
    let mut max_abs = 0.0_f64;
    let mut peak_idx = 0usize;
    let mut peak_t = 0.5;
    for (i, &p) in world.iter().enumerate() {
        let vx = p.x - first.x;
        let vy = p.y - first.y;
        let a = vx * ux + vy * uy;
        let q = vx * nx + vy * ny;
        if q >= 0.0 {
            pos_sum += q;
        } else {
            neg_sum += -q;
        }
        if q.abs() > max_abs {
            max_abs = q.abs();
            peak_idx = i;
            peak_t = a / direct;
        }
    }
    let total_sum = pos_sum + neg_sum;
    if total_sum <= 1e-6 || pos_sum.max(neg_sum) / total_sum < 0.88 {
        return None;
    }
    if max_abs < (direct * 0.1).max(10.0)
        || max_abs > direct * 1.1
        || !(0.15..=0.85).contains(&peak_t)
    {
        return None;
    }
    let denom = 2.0 * peak_t * (1.0 - peak_t);
    let peak = world[peak_idx];
    let ctrl = Point {
        x: (peak.x - (1.0 - peak_t).powi(2) * first.x - peak_t.powi(2) * last.x) / denom,
        y: (peak.y - (1.0 - peak_t).powi(2) * first.y - peak_t.powi(2) * last.y) / denom,
    };
    let samples: Vec<Point> = (0..=24)
        .map(|s| {
            let t = f64::from(s) / 24.0;
            let mt = 1.0 - t;
            Point {
                x: mt * mt * first.x + 2.0 * mt * t * ctrl.x + t * t * last.x,
                y: mt * mt * first.y + 2.0 * mt * t * ctrl.y + t * t * last.y,
            }
        })
        .collect();
    let mse = world
        .iter()
        .map(|&p| {
            samples
                .windows(2)
                .map(|w| point_segment_distance(p, w[0], w[1]))
                .fold(f64::INFINITY, f64::min)
                .powi(2)
        })
        .sum::<f64>()
        / world.len() as f64;
    let rmse = mse.sqrt();
    if rmse > (direct.max(max_abs) * 0.085).max(8.0) {
        return None;
    }
    Some(RecognizedShape {
        kind: ShapeKind::Curve,
        position: first,
        end: last,
        points: vec![Point {
            x: ctrl.x - first.x,
            y: ctrl.y - first.y,
        }],
    })
}

/// Recognizes freehand strokes on pause / shape draw (INK-10) into clean geometric primitives:
/// Line, Arrow, Wave, Curve, Rectangle, Ellipse, Triangle, or Diamond.
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
            end: snap_line_endpoint(first, last),
            points: Vec::new(),
        });
    }

    // Single-stroke arrow: straight shaft from `first` to farthest `apex`, followed by short backward barb(s).
    let (apex_idx, shaft_len) = world
        .iter()
        .enumerate()
        .fold((0usize, 0.0_f64), |best, (i, p)| {
            let d = (p.x - first.x).hypot(p.y - first.y);
            if d > best.1 { (i, d) } else { best }
        });
    if shaft_len >= 24.0 && apex_idx >= 2 && apex_idx + 1 < world.len() {
        let apex = world[apex_idx];
        let prefix_len: f64 = world[..=apex_idx]
            .windows(2)
            .map(|w| (w[1].x - w[0].x).hypot(w[1].y - w[0].y))
            .sum();
        let prefix_dev = world[..=apex_idx]
            .iter()
            .map(|&p| point_segment_distance(p, first, apex))
            .fold(0.0_f64, f64::max);
        let barb_len = path_len - prefix_len;
        if prefix_len / shaft_len <= 1.15
            && prefix_dev <= (shaft_len * 0.07).max(6.0)
            && barb_len >= (shaft_len * 0.06).max(6.0)
            && barb_len <= shaft_len * 0.65
        {
            let ux = (apex.x - first.x) / shaft_len;
            let uy = (apex.y - first.y) / shaft_len;
            let mut max_perp = 0.0_f64;
            let mut valid_barbs = true;
            for &p in &world[apex_idx + 1..] {
                let vx = p.x - apex.x;
                let vy = p.y - apex.y;
                let dist = vx.hypot(vy);
                if dist > shaft_len * 0.45 {
                    valid_barbs = false;
                    break;
                }
                let along = vx * ux + vy * uy;
                if along > (shaft_len * 0.04).max(3.0) {
                    valid_barbs = false;
                    break;
                }
                max_perp = max_perp.max((vx * -uy + vy * ux).abs());
            }
            if valid_barbs && max_perp >= 4.0 {
                return Some(RecognizedShape {
                    kind: ShapeKind::Arrow,
                    position: first,
                    end: snap_line_endpoint(first, apex),
                    points: Vec::new(),
                });
            }
        }
    }

    let w = max_x - min_x;
    let h = max_y - min_y;
    let diag = w.hypot(h);

    if let Some(wave) = try_recognize_wave(&world, first, last, path_len) {
        return Some(wave);
    }

    if w >= 18.0
        && h >= 18.0
        && direct <= diag * 0.42
        && path_len <= 3.0 * (w + h)
        && path_len >= 1.15 * (w + h)
    {
        let rect_err: f64 = world
            .iter()
            .map(|p| {
                let dx = (p.x - min_x).abs().min((max_x - p.x).abs());
                let dy = (p.y - min_y).abs().min((max_y - p.y).abs());
                dx.min(dy)
            })
            .sum::<f64>()
            / (world.len() as f64 * diag);
        let corners = [
            Point { x: min_x, y: min_y },
            Point { x: max_x, y: min_y },
            Point { x: max_x, y: max_y },
            Point { x: min_x, y: max_y },
        ];
        let corner_coverage = corners.iter().all(|c| {
            world
                .iter()
                .any(|p| (p.x - c.x).hypot(p.y - c.y) < diag * 0.2)
        });
        let rect_mids_ok = (0..4).all(|i| {
            let mid = Point {
                x: (corners[i].x + corners[(i + 1) % 4].x) * 0.5,
                y: (corners[i].y + corners[(i + 1) % 4].y) * 0.5,
            };
            world
                .iter()
                .any(|p| (p.x - mid.x).hypot(p.y - mid.y) < diag * 0.2)
        });

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
        let mut quadrant_mask = 0_u8;
        for p in &world {
            let q = match (p.x >= cx, p.y >= cy) {
                (true, true) => 1,
                (false, true) => 2,
                (false, false) => 4,
                (true, false) => 8,
            };
            quadrant_mask |= q;
        }
        let ellipse_closed = quadrant_mask == 0b1111;

        let diamond_pts = [
            Point { x: cx, y: min_y },
            Point { x: max_x, y: cy },
            Point { x: cx, y: max_y },
            Point { x: min_x, y: cy },
        ];
        let diamond_err: f64 = world
            .iter()
            .map(|&p| {
                (0..4)
                    .map(|i| point_segment_distance(p, diamond_pts[i], diamond_pts[(i + 1) % 4]))
                    .fold(f64::INFINITY, f64::min)
            })
            .sum::<f64>()
            / (world.len() as f64 * diag);
        let diamond_coverage = diamond_pts.iter().all(|c| {
            world
                .iter()
                .any(|p| (p.x - c.x).hypot(p.y - c.y) < diag * 0.18)
        });

        // 3-pass farthest-vertex triangle check + 1 cyclic refinement pass
        let center = Point { x: cx, y: cy };
        let mut v0 = world
            .iter()
            .copied()
            .max_by(|a, b| {
                (a.x - center.x)
                    .hypot(a.y - center.y)
                    .total_cmp(&(b.x - center.x).hypot(b.y - center.y))
            })
            .unwrap_or(first);
        let mut v1 = world
            .iter()
            .copied()
            .max_by(|a, b| {
                (a.x - v0.x)
                    .hypot(a.y - v0.y)
                    .total_cmp(&(b.x - v0.x).hypot(b.y - v0.y))
            })
            .unwrap_or(last);
        let v2 = world
            .iter()
            .copied()
            .max_by(|a, b| {
                point_line_distance(*a, v0, v1).total_cmp(&point_line_distance(*b, v0, v1))
            })
            .unwrap_or(center);
        v0 = world
            .iter()
            .copied()
            .max_by(|a, b| {
                point_line_distance(*a, v1, v2).total_cmp(&point_line_distance(*b, v1, v2))
            })
            .unwrap_or(v0);
        v1 = world
            .iter()
            .copied()
            .max_by(|a, b| {
                point_line_distance(*a, v0, v2).total_cmp(&point_line_distance(*b, v0, v2))
            })
            .unwrap_or(v1);
        let tri_area = 0.5 * ((v1.x - v0.x) * (v2.y - v0.y) - (v2.x - v0.x) * (v1.y - v0.y)).abs();
        let tri_err = if tri_area > 0.18 * w * h {
            let tri_verts = [v0, v1, v2];
            let err = world
                .iter()
                .map(|&p| {
                    (0..3)
                        .map(|i| point_segment_distance(p, tri_verts[i], tri_verts[(i + 1) % 3]))
                        .fold(f64::INFINITY, f64::min)
                })
                .sum::<f64>()
                / (world.len() as f64 * diag);
            let tri_edges_ok = (0..3).all(|i| {
                let mid = Point {
                    x: (tri_verts[i].x + tri_verts[(i + 1) % 3].x) * 0.5,
                    y: (tri_verts[i].y + tri_verts[(i + 1) % 3].y) * 0.5,
                };
                world
                    .iter()
                    .any(|p| (p.x - mid.x).hypot(p.y - mid.y) < diag * 0.22)
            });
            if tri_edges_ok { err } else { f64::INFINITY }
        } else {
            f64::INFINITY
        };

        if rect_err <= 0.065
            && corner_coverage
            && rect_mids_ok
            && rect_err <= ellipse_err * 0.92
            && rect_err <= tri_err * 0.92
        {
            let (rx_pos, ry_pos, rw, rh) = if (w - h).abs() / w.max(h) <= 0.12 {
                let s = (w + h) * 0.5;
                (cx - s * 0.5, cy - s * 0.5, s, s)
            } else {
                (min_x, min_y, w, h)
            };
            return Some(RecognizedShape {
                kind: ShapeKind::Rectangle,
                position: Point {
                    x: rx_pos,
                    y: ry_pos,
                },
                end: Point { x: rw, y: rh },
                points: Vec::new(),
            });
        }
        if diamond_err <= 0.065
            && diamond_coverage
            && diamond_err < ellipse_err
            && diamond_err < tri_err
        {
            return Some(RecognizedShape {
                kind: ShapeKind::Diamond,
                position: Point { x: min_x, y: min_y },
                end: Point { x: w, y: h },
                points: Vec::new(),
            });
        }
        if tri_err <= 0.075 && tri_err < ellipse_err {
            let mut verts = [v0, v1, v2];
            // Sort deterministically clockwise around centroid.
            let tcx = (verts[0].x + verts[1].x + verts[2].x) / 3.0;
            let tcy = (verts[0].y + verts[1].y + verts[2].y) / 3.0;
            verts.sort_by(|a, b| {
                (a.y - tcy)
                    .atan2(a.x - tcx)
                    .total_cmp(&(b.y - tcy).atan2(b.x - tcx))
            });
            // Gently level almost-horizontal or almost-vertical edges (< ~5.7 deg).
            for i in 0..3 {
                let j = (i + 1) % 3;
                let dx = (verts[j].x - verts[i].x).abs();
                let dy = (verts[j].y - verts[i].y).abs();
                if dy > 0.0 && dy <= dx * 0.1 {
                    let avg_y = (verts[i].y + verts[j].y) * 0.5;
                    verts[i].y = avg_y;
                    verts[j].y = avg_y;
                } else if dx > 0.0 && dx <= dy * 0.1 {
                    let avg_x = (verts[i].x + verts[j].x) * 0.5;
                    verts[i].x = avg_x;
                    verts[j].x = avg_x;
                }
            }
            let t_min_x = verts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
            let t_min_y = verts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
            let t_max_x = verts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
            let t_max_y = verts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
            return Some(RecognizedShape {
                kind: ShapeKind::Triangle,
                position: Point {
                    x: t_min_x,
                    y: t_min_y,
                },
                end: Point {
                    x: (t_max_x - t_min_x).max(1.0),
                    y: (t_max_y - t_min_y).max(1.0),
                },
                points: verts
                    .into_iter()
                    .map(|p| Point {
                        x: p.x - t_min_x,
                        y: p.y - t_min_y,
                    })
                    .collect(),
            });
        }
        if ellipse_err <= 0.09 && ellipse_closed {
            let (ex, ey, ew, eh) = if (w - h).abs() / w.max(h) <= 0.14 {
                let d = (w + h) * 0.5;
                (cx - d * 0.5, cy - d * 0.5, d, d)
            } else {
                (min_x, min_y, w, h)
            };
            return Some(RecognizedShape {
                kind: ShapeKind::Ellipse,
                position: Point { x: ex, y: ey },
                end: Point { x: ew, y: eh },
                points: Vec::new(),
            });
        }
    }

    try_recognize_curve(&world, first, last, path_len, diag)
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
                    group_ids: node.attrs.group_ids.clone(),
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
                group_ids: Vec::new(),
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

        // Triangle
        let mut tri = Vec::new();
        let tri_verts = [(50.0, 0.0), (100.0, 80.0), (0.0, 80.0), (50.0, 0.0)];
        for seg in tri_verts.windows(2) {
            for s in 0..8 {
                let f = f64::from(s) / 8.0;
                tri.push(InkPoint {
                    x: seg[0].0 + (seg[1].0 - seg[0].0) * f,
                    y: seg[0].1 + (seg[1].1 - seg[0].1) * f,
                    pressure: 0.5,
                    elapsed_ms: (tri.len() as u32) * 10,
                });
            }
        }
        tri.push(InkPoint {
            x: 50.0,
            y: 0.0,
            pressure: 0.5,
            elapsed_ms: 300,
        });
        assert_eq!(
            recognize_shape(&tri, Point::default()).unwrap().kind,
            ShapeKind::Triangle
        );

        // Diamond
        let mut diamond = Vec::new();
        let d_verts = [
            (50.0, 0.0),
            (100.0, 50.0),
            (50.0, 100.0),
            (0.0, 50.0),
            (50.0, 0.0),
        ];
        for seg in d_verts.windows(2) {
            for s in 0..8 {
                let f = f64::from(s) / 8.0;
                diamond.push(InkPoint {
                    x: seg[0].0 + (seg[1].0 - seg[0].0) * f,
                    y: seg[0].1 + (seg[1].1 - seg[0].1) * f,
                    pressure: 0.5,
                    elapsed_ms: (diamond.len() as u32) * 10,
                });
            }
        }
        diamond.push(InkPoint {
            x: 50.0,
            y: 0.0,
            pressure: 0.5,
            elapsed_ms: 350,
        });
        assert_eq!(
            recognize_shape(&diamond, Point::default()).unwrap().kind,
            ShapeKind::Diamond
        );

        // Single-stroke arrow
        let arrow: Vec<InkPoint> = [
            (0.0, 50.0),
            (40.0, 50.0),
            (80.0, 50.0),
            (120.0, 50.0),
            (105.0, 38.0),
            (120.0, 50.0),
            (105.0, 62.0),
        ]
        .into_iter()
        .enumerate()
        .map(|(i, (x, y))| InkPoint {
            x,
            y,
            pressure: 0.5,
            elapsed_ms: (i as u32) * 15,
        })
        .collect();
        let recognized_arrow = recognize_shape(&arrow, Point::default()).unwrap();
        assert_eq!(recognized_arrow.kind, ShapeKind::Arrow);
        assert_eq!(recognized_arrow.end, Point { x: 120.0, y: 50.0 });

        // Slightly open top-apex hand-drawn tilted triangle
        let mut open_tri = Vec::new();
        let segs = [
            ((55.0, 12.0), (140.0, 95.0)),
            ((140.0, 95.0), (10.0, 88.0)),
            ((10.0, 88.0), (48.0, 22.0)),
        ];
        for (a, b) in segs {
            for s in 0..=8 {
                let f = f64::from(s) / 8.0;
                open_tri.push(InkPoint {
                    x: a.0 + (b.0 - a.0) * f,
                    y: a.1 + (b.1 - a.1) * f,
                    pressure: 0.5,
                    elapsed_ms: (open_tri.len() as u32) * 10,
                });
            }
        }
        let rec_open_tri = recognize_shape(&open_tri, Point::default()).unwrap();
        assert_eq!(rec_open_tri.kind, ShapeKind::Triangle);
        assert_eq!(rec_open_tri.points.len(), 3);

        // Sine wave
        let wave: Vec<InkPoint> = (0..=48)
            .map(|i| {
                let t = f64::from(i) / 48.0;
                InkPoint {
                    x: t * 180.0,
                    y: 18.0 * (std::f64::consts::TAU * 2.0 * t).sin(),
                    pressure: 0.5,
                    elapsed_ms: (i as u32) * 12,
                }
            })
            .collect();
        let rec_wave = recognize_shape(&wave, Point::default()).unwrap();
        assert_eq!(rec_wave.kind, ShapeKind::Wave);
        assert_eq!(rec_wave.points.len(), 1);

        // Smooth arc curve
        let arc: Vec<InkPoint> = (0..=24)
            .map(|i| {
                let t = f64::from(i) / 24.0;
                let mt = 1.0 - t;
                InkPoint {
                    x: 2.0 * mt * t * 70.0 + t * t * 140.0,
                    y: 2.0 * mt * t * -45.0,
                    pressure: 0.5,
                    elapsed_ms: (i as u32) * 12,
                }
            })
            .collect();
        let rec_arc = recognize_shape(&arc, Point::default()).unwrap();
        assert_eq!(rec_arc.kind, ShapeKind::Curve);
        assert_eq!(rec_arc.points.len(), 1);
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
