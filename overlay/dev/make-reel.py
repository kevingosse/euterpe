"""Cut a `frames:` model sheet (renderer/sheet.js) into frames and assemble an animated GIF.

    electron dev/render-sheet.js --sheet=frames:reel:21 --scale=3 --bg=#1e1c22 --out=reel.png
    python dev/make-reel.py reel.png ../docs/clawd.gif --scale=3
"""
import sys
from PIL import Image

CELL_W, CELL_H, LABEL, COLS, FPS = 80, 64, 18, 12, 12


def main():
    src, dst = sys.argv[1], sys.argv[2]
    scale = next((int(a.split("=")[1]) for a in sys.argv[3:] if a.startswith("--scale=")), 3)
    sheet = Image.open(src).convert("RGB")
    cw, ch = CELL_W * scale, CELL_H * scale
    rows = sheet.height // (ch + LABEL)
    frames = []
    for r in range(rows):
        for c in range(COLS):
            x, y = c * cw, r * (ch + LABEL)
            frame = sheet.crop((x, y, x + cw, y + ch))
            if frame.getbbox() is None or len(frame.getcolors(1 << 16) or []) <= 1:
                continue  # an empty trailing cell
            frames.append(frame)
    # one shared palette, built from a montage of every frame, keeps the pixel art exact
    montage = Image.new("RGB", (cw, ch * len(frames)))
    for i, f in enumerate(frames):
        montage.paste(f, (0, i * ch))
    palette = montage.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    out = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
    out[0].save(dst, save_all=True, append_images=out[1:], duration=round(1000 / FPS), loop=0, optimize=True, disposal=1)
    print(f"{dst}: {len(out)} frames")


if __name__ == "__main__":
    main()
