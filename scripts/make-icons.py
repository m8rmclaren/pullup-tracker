"""Renders the app icons. Run once; the PNGs are committed (iOS needs PNG, not SVG)."""
import sys
from PIL import Image, ImageDraw

BG = (15, 15, 14)
BAR = (245, 244, 239)
ACCENT = (57, 135, 229)


def draw(size: int, pad: float) -> Image.Image:
    s = 4 * size  # supersample, then downscale for clean edges
    img = Image.new("RGB", (s, s), BG)
    d = ImageDraw.Draw(img)
    inner = s * (1 - 2 * pad)
    o = s * pad
    u = inner / 100
    # the bar
    d.rounded_rectangle([o + 12 * u, o + 22 * u, o + 88 * u, o + 31 * u], radius=4.5 * u, fill=BAR)
    # an upward chevron: the pull
    w = 11 * u
    pts = [(o + 24 * u, o + 74 * u), (o + 50 * u, o + 48 * u), (o + 76 * u, o + 74 * u)]
    d.line(pts, fill=ACCENT, width=int(w), joint="curve")
    for x, y in (pts[0], pts[2]):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=ACCENT)
    return img.resize((size, size), Image.LANCZOS)


out = sys.argv[1]
draw(192, 0.08).save(f"{out}/icon-192.png")
draw(512, 0.08).save(f"{out}/icon-512.png")
draw(512, 0.18).save(f"{out}/maskable-512.png")  # content inside the maskable safe zone
draw(180, 0.08).save(f"{out}/apple-touch-icon.png")
