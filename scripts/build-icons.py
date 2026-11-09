#!/usr/bin/env python3
import os
import shutil
import subprocess
from PIL import Image

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG_SOURCE = os.path.join(REPO_ROOT, "docs/design/logo/v2/concept-b2-recessed-grid.svg")
MONO_SOURCE = os.path.join(REPO_ROOT, "docs/design/logo/icon-monochrome.svg")
DEST_DIR = os.path.join(REPO_ROOT, "apps/coboard-desktop/src-tauri/icons")
DOCS_ASSETS = os.path.join(REPO_ROOT, "docs/design/logo/dist")

os.makedirs(DEST_DIR, exist_ok=True)
os.makedirs(DOCS_ASSETS, exist_ok=True)

print("1. Rasterizing SVG to 1024x1024 base PNG via macOS QuickLook...")
tmp_dir = "/tmp/coboard_icon_build"
os.makedirs(tmp_dir, exist_ok=True)
subprocess.run(["qlmanage", "-t", "-s", "1024", "-o", tmp_dir, SVG_SOURCE], check=True, stderr=subprocess.DEVNULL)
base_png_path = os.path.join(tmp_dir, "concept-b2-recessed-grid.svg.png")

img_1024 = Image.open(base_png_path).convert("RGBA")

print("2. Generating Tauri multi-resolution PNG assets...")
sizes = {
    "icon.png": (512, 512),
    "icon-1024.png": (1024, 1024),
    "32x32.png": (32, 32),
    "128x128.png": (128, 128),
    "128x128@2x.png": (256, 256),
}

for filename, size in sizes.items():
    resized = img_1024.resize(size, Image.Resampling.LANCZOS)
    target_path = os.path.join(DEST_DIR, filename)
    resized.save(target_path, "PNG")
    resized.save(os.path.join(DOCS_ASSETS, filename), "PNG")
    print(f"   -> {filename} ({size[0]}x{size[1]})")

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
    iconset_img = img_1024.resize(size, Image.Resampling.LANCZOS)
    iconset_img.save(os.path.join(iconset_dir, name), "PNG")

icns_output_path = os.path.join(DEST_DIR, "icon.icns")
subprocess.run(["iconutil", "-c", "icns", iconset_dir, "-o", icns_output_path], check=True)
shutil.copy(icns_output_path, os.path.join(DOCS_ASSETS, "icon.icns"))
print("   -> icon.icns compiled successfully.")

print("5. Syncing SVG & MenuBar templates...")
shutil.copy(SVG_SOURCE, os.path.join(DEST_DIR, "icon.svg"))
shutil.copy(SVG_SOURCE, os.path.join(DOCS_ASSETS, "icon.svg"))
shutil.copy(SVG_SOURCE, os.path.join(REPO_ROOT, "docs/design/logo/coboard-icon-official.svg"))
shutil.copy(MONO_SOURCE, os.path.join(DEST_DIR, "icon-monochrome.svg"))
shutil.copy(MONO_SOURCE, os.path.join(DOCS_ASSETS, "icon-monochrome.svg"))
print("   -> icon.svg & icon-monochrome.svg updated.")

print("\nDone! All desktop icon assets built and deployed.")
