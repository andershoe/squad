"""Generate Squad PWA icons — neutral, not tied to any specific team's colours."""

from PIL import Image, ImageDraw
import os

BG_DARK = (26, 26, 31)
INK = (247, 246, 243)
ACCENT = (214, 40, 40)

OUT = os.path.dirname(os.path.abspath(__file__))

def make_icon(size, maskable=False, filename=None):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if maskable:
        draw.rectangle([0, 0, size, size], fill=BG_DARK)
        scale = 0.55
    else:
        radius = int(size * 0.22)
        draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG_DARK)
        scale = 0.65

    cx, cy = size / 2, size / 2
    dot_radius = size * 0.08 * scale
    gap = size * 0.10 * scale

    positions = [
        (cx - gap * 2, cy + size * 0.04),
        (cx,           cy - size * 0.04),
        (cx + gap * 2, cy + size * 0.04),
    ]
    colors = [INK, ACCENT, INK]

    for (x, y), color in zip(positions, colors):
        if color == ACCENT:
            draw.ellipse([x - dot_radius, y - dot_radius, x + dot_radius, y + dot_radius], fill=color)
        else:
            r = int(dot_radius * 0.4)
            draw.rounded_rectangle(
                [x - dot_radius, y - dot_radius, x + dot_radius, y + dot_radius],
                radius=r, fill=color
            )

    img.save(os.path.join(OUT, filename), "PNG")
    print(f"Wrote {filename}")

make_icon(192, filename="icon-192.png")
make_icon(512, filename="icon-512.png")
make_icon(512, maskable=True, filename="icon-maskable-512.png")
