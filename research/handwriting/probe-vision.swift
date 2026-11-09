import Foundation
import CoreGraphics
import Vision

struct Point { let x: Double; let y: Double }
struct Stroke { let points: [Point]; let width: Double }
enum ProbeError: Error { case input, raster }

func raster(_ strokes: [Stroke]) throws -> CGImage {
    let points = strokes.flatMap(\.points)
    guard let x0 = points.map(\.x).min(), let x1 = points.map(\.x).max(),
          let y0 = points.map(\.y).min(), let y1 = points.map(\.y).max() else { throw ProbeError.input }
    let pad = 20.0, scale = min(2.0, 2048 / max(1, max(x1 - x0, y1 - y0) + 2 * pad))
    let w = max(32, Int(ceil((x1 - x0 + 2 * pad) * scale)))
    let h = max(32, Int(ceil((y1 - y0 + 2 * pad) * scale)))
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
        bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw ProbeError.raster }
    ctx.setFillColor(CGColor(gray: 1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.translateBy(x: 0, y: CGFloat(h)); ctx.scaleBy(x: scale, y: -scale)
    ctx.translateBy(x: pad - x0, y: pad - y0)
    ctx.setStrokeColor(CGColor(gray: 0, alpha: 1)); ctx.setFillColor(CGColor(gray: 0, alpha: 1))
    ctx.setLineCap(.round); ctx.setLineJoin(.round)
    for stroke in strokes {
        guard let first = stroke.points.first else { continue }
        ctx.setLineWidth(stroke.width); ctx.beginPath(); ctx.move(to: CGPoint(x: first.x, y: first.y))
        for point in stroke.points.dropFirst() { ctx.addLine(to: CGPoint(x: point.x, y: point.y)) }
        ctx.strokePath()
        if stroke.points.count == 1 {
            ctx.fillEllipse(in: CGRect(x: first.x - stroke.width / 2, y: first.y - stroke.width / 2, width: stroke.width, height: stroke.width))
        }
    }
    guard let image = ctx.makeImage() else { throw ProbeError.raster }
    return image
}

func runProbe() throws {
    guard CommandLine.arguments.count == 2 else { throw ProbeError.input }
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    guard let fixtures = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { throw ProbeError.input }
    for fixture in fixtures {
        guard let name = fixture["name"] as? String, let expected = fixture["expected"] as? String,
              let nodes = fixture["strokes"] as? [[Any]] else { throw ProbeError.input }
        var strokes: [Stroke] = []
        for node in nodes {
            guard node.count == 2, let s = node[1] as? [String: Any], let pos = s["position"] as? [String: Double],
                  let px = pos["x"], let py = pos["y"], let ps = s["points"] as? [[String: Any]],
                  let width = s["width"] as? Double else { throw ProbeError.input }
            let points = try ps.map { p -> Point in
                guard let x = p["x"] as? Double, let y = p["y"] as? Double else { throw ProbeError.input }
                return Point(x: px + x, y: py + y)
            }
            strokes.append(Stroke(points: points, width: width))
        }
        let image = try raster(strokes)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false
        let supported = try request.supportedRecognitionLanguages()
        guard supported.contains("zh-Hans"), supported.contains("en-US") else { throw ProbeError.input }
        var timings: [Double] = [], actual = "", confidence: [Float] = [], cold = 0.0
        for index in 0..<11 {
            let start = DispatchTime.now().uptimeNanoseconds
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
            let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
            if index == 0 { cold = elapsed } else { timings.append(elapsed) }
            let candidates = (request.results ?? []).compactMap { $0.topCandidates(1).first }
            actual = candidates.map(\.string).joined(separator: " ")
            confidence = candidates.map(\.confidence)
        }
        timings.sort()
        let result: [String: Any] = ["fixture": name, "expected": expected, "actual": actual,
            "confidence": confidence, "firstCallMs": cold, "warmSamples": timings.count,
            "warmP50Ms": timings[4], "warmP95Ms": timings[9],
            "scope": "synthetic raster recognition only; excludes UI, IPC and grouping"]
        let output = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        print(String(decoding: output, as: UTF8.self))
    }
}

do { try runProbe() } catch {
    fputs("Vision probe failed: \(error)\n", stderr)
    exit(1)
}
