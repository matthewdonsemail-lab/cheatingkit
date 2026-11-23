"""Render the social preview using the site's OpenTUI Mono font.

Requires Pillow and fonttools[woff]. Run: python scripts/maintenance/generate-og.py
"""

from io import BytesIO
from pathlib import Path
from math import sin

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "public" / "og.png"
FONT_FILE = ROOT / "public" / "opencode" / "fonts" / "opentui-mono-regular-latin-BQZPBadR.woff2"
WIDTH, HEIGHT = 1200, 630


def font(size):
    source = TTFont(FONT_FILE)
    source.flavor = None
    buffer = BytesIO()
    source.save(buffer)
    buffer.seek(0)
    return ImageFont.truetype(buffer, size)


image = Image.new("RGB", (WIDTH, HEIGHT), "#050505")
draw = ImageDraw.Draw(image)

# An ordered white dither rises from the lower-right quadrant. The sparse edge
# keeps the type legible while the denser edge gives the card its texture.
bayer = (
    (0, 48, 12, 60, 3, 51, 15, 63),
    (32, 16, 44, 28, 35, 19, 47, 31),
    (8, 56, 4, 52, 11, 59, 7, 55),
    (40, 24, 36, 20, 43, 27, 39, 23),
    (2, 50, 14, 62, 1, 49, 13, 61),
    (34, 18, 46, 30, 33, 17, 45, 29),
    (10, 58, 6, 54, 9, 57, 5, 53),
    (42, 26, 38, 22, 41, 25, 37, 21),
)
step = 8
for row, y in enumerate(range(365, HEIGHT, step)):
    for col, x in enumerate(range(475, WIDTH, step)):
        horizontal = max(0, (x - 475) / (WIDTH - 475))
        vertical = max(0, (y - 365) / (HEIGHT - 365))
        wave = 0.10 * sin(x / 67 + y / 91)
        density = max(0, min(1, horizontal * 0.54 + vertical * 0.58 + wave - 0.18))
        if density * 64 > bayer[row % 8][col % 8]:
            size = 2 if density < 0.45 else 3
            draw.rectangle((x, y, x + size, y + size), fill="#f2f2f2")

title_font = font(86)
subtitle_font = font(24)
draw.text((70, 170), "CheatingKit", font=title_font, fill="#ffffff")
draw.text((74, 291), "an opensource framework for your agents to", font=subtitle_font, fill="#e7e7e7")
draw.text((74, 328), "not refuse reverse engineering", font=subtitle_font, fill="#e7e7e7")

image.save(OUTPUT, optimize=True)
print(f"Rendered {OUTPUT} ({WIDTH}x{HEIGHT})")
