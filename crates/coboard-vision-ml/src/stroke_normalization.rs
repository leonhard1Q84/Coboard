//! Model-only direction normalization. Never changes document ink or undo units.

use crate::incremental::Stroke;

/// Normalize a three-sided clockwise box's backward bottom edge. Corner detection
/// uses relative geometric error, not device pixels or the number of samples.
pub(crate) fn normalize_box_strokes(strokes: &[Stroke]) -> Vec<Stroke> {
    let mut out = Vec::with_capacity(strokes.len() + 1);
    for stroke in strokes {
        if let Some(corner) = backward_bottom_corner(stroke) {
            out.push(stroke[..=corner].to_vec());
            out.push(stroke[corner..].iter().rev().copied().collect());
        } else {
            out.push(stroke.clone());
        }
    }
    out
}

fn backward_bottom_corner(stroke: &Stroke) -> Option<usize> {
    if stroke.len() < 4 {
        return None;
    }
    let mut min = [f32::INFINITY; 2];
    let mut max = [f32::NEG_INFINITY; 2];
    for point in stroke {
        for axis in 0..2 {
            if !point[axis].is_finite() {
                return None;
            }
            min[axis] = min[axis].min(point[axis]);
            max[axis] = max[axis].max(point[axis]);
        }
    }
    let scale = (max[0] - min[0]).max(max[1] - min[1]);
    if scale <= f32::EPSILON {
        return None;
    }
    // Bounded RDP: stop as soon as the contour needs more than four corners.
    // Keep original indices so normalization preserves every sampled point.
    let tolerance2 = (scale * 0.02).powi(2);
    let mut corners = vec![0, stroke.len() - 1];
    let mut pending = vec![(0, stroke.len() - 1)];
    while let Some((first, last)) = pending.pop() {
        let a = stroke[first];
        let b = stroke[last];
        let d = [b[0] - a[0], b[1] - a[1]];
        let length2 = d[0] * d[0] + d[1] * d[1];
        let mut farthest = None;
        let mut error = tolerance2;
        for (index, p) in stroke.iter().enumerate().take(last).skip(first + 1) {
            let t = if length2 > 0.0 {
                (((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / length2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let distance2 = (p[0] - a[0] - t * d[0]).powi(2) + (p[1] - a[1] - t * d[1]).powi(2);
            if distance2 > error {
                error = distance2;
                farthest = Some(index);
            }
        }
        if let Some(index) = farthest {
            corners.push(index);
            if corners.len() > 4 {
                return None;
            }
            pending.push((first, index));
            pending.push((index, last));
        }
    }
    if corners.len() != 4 {
        return None;
    }
    corners.sort_unstable();
    let [a, b, c, d] = [
        stroke[corners[0]],
        stroke[corners[1]],
        stroke[corners[2]],
        stroke[corners[3]],
    ];
    let horizontal = |a: [f32; 2], b: [f32; 2], direction: f32| {
        let dx = direction * (b[0] - a[0]);
        dx > scale * 0.2 && (b[1] - a[1]).abs() < dx * 0.3
    };
    let dy = c[1] - b[1];
    (horizontal(a, b, 1.0)
        && dy > scale * 0.2
        && (c[0] - b[0]).abs() < dy * 0.3
        && horizontal(c, d, -1.0))
    .then_some(corners[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampled_box_normalization_preserves_geometry_at_any_size() {
        for scale in [0.01, 0.1, 1.0, 10.0] {
            for density in [1, 4, 32] {
                let vertices = [[0.0, 0.0], [60.0, 0.0], [60.0, 50.0], [0.0, 50.0]];
                let mut stroke = Vec::new();
                for edge in vertices.windows(2) {
                    for i in 0..density {
                        let t = i as f32 / density as f32;
                        stroke.push([
                            100.0 + scale * (edge[0][0] * (1.0 - t) + edge[1][0] * t),
                            200.0 + scale * (edge[0][1] * (1.0 - t) + edge[1][1] * t),
                        ]);
                    }
                }
                stroke.push([100.0, 200.0 + 50.0 * scale]);
                let original = stroke.clone();
                let output = normalize_box_strokes(std::slice::from_ref(&stroke));
                assert_eq!(output.len(), 2, "scale={scale}, density={density}");
                assert_eq!(output[0], original[..=2 * density]);
                assert_eq!(
                    output[1],
                    original[2 * density..]
                        .iter()
                        .rev()
                        .copied()
                        .collect::<Stroke>()
                );
                assert_eq!(stroke, original);
            }
        }
    }

    #[test]
    fn leaves_open_curves_diagonals_and_degenerate_strokes_alone() {
        let strokes = vec![
            vec![[0.0, 0.0]; 100],
            vec![[0.0, 0.0], [50.0, 0.0], [50.0, 50.0]],
            vec![[0.0, 0.0], [50.0, 0.0], [10.0, 50.0], [60.0, 50.0]],
            vec![
                [0.0, 0.0],
                [50.0, 0.0],
                [50.0, 50.0],
                [0.0, 50.0],
                [0.0, 0.0],
            ],
        ];
        assert_eq!(normalize_box_strokes(&strokes), strokes);
    }
}
