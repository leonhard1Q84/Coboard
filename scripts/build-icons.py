#!/usr/bin/env python3
import os
import re
import shutil
import subprocess
import tempfile
from PIL import Image

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG_SOURCE = os.path.join(REPO_ROOT, "docs/design/logo/v2/concept-b2-recessed-grid.svg")
MONO_SOURCE = os.path.join(REPO_ROOT, "docs/design/logo/icon-monochrome.svg")
DEST_DIR = os.path.join(REPO_ROOT, "apps/coboard-desktop/src-tauri/icons")
PUBLIC_DIR = os.path.join(REPO_ROOT, "apps/coboard-desktop/public")
DOCS_ASSETS = os.path.join(REPO_ROOT, "docs/design/logo/dist")

SWIFT_RASTERIZER = r'''
import AppKit
import Foundation
import WebKit

guard CommandLine.arguments.count == 3 else {
    fputs("Usage: svg2png <input.html> <output.png>\n", stderr)
    exit(1)
}

let htmlPath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]
let htmlURL = URL(fileURLWithPath: htmlPath)

final class RasterDelegate: NSObject, WKNavigationDelegate {
    let outputPath: String
    init(outputPath: String) {
        self.outputPath = outputPath
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let config = WKSnapshotConfiguration()
        config.rect = CGRect(x: 0, y: 0, width: 1024, height: 1024)
        config.snapshotWidth = 1024
        webView.takeSnapshot(with: config) { image, error in
            if let error = error {
                fputs("Snapshot error: \(error)\n", stderr)
                exit(1)
            }
            guard let image = image,
                  let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else {
                fputs("PNG conversion failed\n", stderr)
                exit(1)
            }
            do {
                try png.write(to: URL(fileURLWithPath: self.outputPath))
                exit(0)
            } catch {
                fputs("Write error: \(error)\n", stderr)
                exit(1)
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fputs("Navigation error: \(error)\n", stderr)
        exit(1)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fputs("Provisional navigation error: \(error)\n", stderr)
        exit(1)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1024, height: 1024), configuration: WKWebViewConfiguration())
webView.setValue(false, forKey: "drawsBackground")

let delegate = RasterDelegate(outputPath: outputPath)
webView.navigationDelegate = delegate
webView.loadFileURL(htmlURL, allowingReadAccessTo: htmlURL.deletingLastPathComponent())

DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
    fputs("Timed out waiting for SVG rasterization\n", stderr)
    exit(1)
}

app.run()
'''

os.makedirs(DEST_DIR, exist_ok=True)
os.makedirs(PUBLIC_DIR, exist_ok=True)
os.makedirs(DOCS_ASSETS, exist_ok=True)

with tempfile.TemporaryDirectory(prefix="coboard_icon_build_") as tmp_dir:
    print("1. Rasterizing SVG to transparent 1024x1024 base PNG via WebKit...")
    with open(SVG_SOURCE, "r", encoding="utf-8") as f:
        svg_markup = re.sub(r"^\s*<\?xml[^>]*\?>\s*", "", f.read())

    html_path = os.path.join(tmp_dir, "icon.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(
            "<!doctype html><html><head><meta charset=\"utf-8\"><style>"
            "html,body{margin:0;padding:0;width:1024px;height:1024px;background:transparent!important;overflow:hidden;}"
            "svg{display:block;width:1024px;height:1024px;}"
            "</style></head><body>"
            + svg_markup
            + "</body></html>"
        )

    swift_path = os.path.join(tmp_dir, "svg2png.swift")
    with open(swift_path, "w", encoding="utf-8") as f:
        f.write(SWIFT_RASTERIZER)

    base_png_path = os.path.join(tmp_dir, "base.png")
    subprocess.run(["swift", swift_path, html_path, base_png_path], check=True)

    img_raw = Image.open(base_png_path).convert("RGBA")
    img_1024 = img_raw if img_raw.size == (1024, 1024) else img_raw.resize((1024, 1024), Image.Resampling.LANCZOS)
    if img_1024.getpixel((0, 0))[3] != 0:
        raise RuntimeError(f"Expected transparent corner alpha=0, got {img_1024.getpixel((0, 0))}")

    print("2. Generating Tauri multi-resolution PNG assets...")
    sizes = {
        "icon.png": (512, 512),
        "icon-1024.png": (1024, 1024),
        "32x32.png": (32, 32),
        "128x128.png": (128, 128),
        "128x128@2x.png": (256, 256),
    }

    for filename, size in sizes.items():
        resized = img_1024 if size == (1024, 1024) else img_1024.resize(size, Image.Resampling.LANCZOS)
        target_path = os.path.join(DEST_DIR, filename)
        resized.save(target_path, "PNG")
        resized.save(os.path.join(DOCS_ASSETS, filename), "PNG")
        print(f"   -> {filename} ({size[0]}x{size[1]})")

    shutil.copy(os.path.join(DEST_DIR, "32x32.png"), os.path.join(PUBLIC_DIR, "favicon.png"))
    print("   -> public/favicon.png (32x32)")

    print("3. Generating Windows icon.ico...")
    ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    img_1024.save(os.path.join(DEST_DIR, "icon.ico"), format="ICO", sizes=ico_sizes)
    img_1024.save(os.path.join(DOCS_ASSETS, "icon.ico"), format="ICO", sizes=ico_sizes)
    print("   -> icon.ico generated successfully.")

    print("4. Generating macOS icon.icns via iconutil...")
    iconset_dir = os.path.join(tmp_dir, "icon.iconset")
    os.makedirs(iconset_dir, exist_ok=True)

    icns_mapping = [
        ("icon_16x16.png", (16, 16)),
        ("icon_16x16@2x.png", (32, 32)),
        ("icon_32x32.png", (32, 32)),
        ("icon_32x32@2x.png", (64, 64)),
        ("icon_128x128.png", (128, 128)),
        ("icon_128x128@2x.png", (256, 256)),
        ("icon_256x256.png", (256, 256)),
        ("icon_256x256@2x.png", (512, 512)),
        ("icon_512x512.png", (512, 512)),
        ("icon_512x512@2x.png", (1024, 1024)),
    ]

    for name, size in icns_mapping:
        iconset_img = img_1024 if size == (1024, 1024) else img_1024.resize(size, Image.Resampling.LANCZOS)
        iconset_img.save(os.path.join(iconset_dir, name), "PNG")

    icns_output_path = os.path.join(DEST_DIR, "icon.icns")
    subprocess.run(["iconutil", "-c", "icns", iconset_dir, "-o", icns_output_path], check=True)
    shutil.copy(icns_output_path, os.path.join(DOCS_ASSETS, "icon.icns"))
    print("   -> icon.icns compiled successfully.")

    print("5. Syncing SVG & MenuBar templates...")
    shutil.copy(SVG_SOURCE, os.path.join(DEST_DIR, "icon.svg"))
    shutil.copy(SVG_SOURCE, os.path.join(PUBLIC_DIR, "favicon.svg"))
    shutil.copy(SVG_SOURCE, os.path.join(DOCS_ASSETS, "icon.svg"))
    shutil.copy(SVG_SOURCE, os.path.join(REPO_ROOT, "docs/design/logo/coboard-icon-official.svg"))
    shutil.copy(MONO_SOURCE, os.path.join(DEST_DIR, "icon-monochrome.svg"))
    shutil.copy(MONO_SOURCE, os.path.join(DOCS_ASSETS, "icon-monochrome.svg"))
    print("   -> icon.svg, favicon.svg & icon-monochrome.svg updated.")

print("\nDone! All desktop icon assets built and deployed.")
