#!/usr/bin/env python3
"""Draws the 'apartments' texture sheet: nine apartment-block facades.

Each cell is one repeat of a facade: one dwelling unit wide (about 6 m) and
two storeys tall (2 x 2.92 m). The tile is periodic, so the game repeats it
across a block without seams (`repeat: true` in dist/surfaces.js). The game
cuts every cell a little inside its border (CELL_INSET), so each tile is drawn
to fill exactly that inner window and wrapped around it.

  python3 .claude/skills/texture-sheets/scripts/draw-apartments.py

Writes textures/source/apartments.webp (2880 px), textures/source/apartments.json
and the shipped 960 px copy dist/textures/apartments.webp.
"""
import json
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../..'))
CELL = 960            # drawn cell size (the source sheet is 3 x 960)
INSET = 0.035         # dist/surfaces.js CELL_INSET
TILE = 900            # one repeat, drawn before it is fitted to the window
FLOOR = TILE // 2     # one storey
SHIP = 960            # shipped sheet size (dist/surfaces.js SHEET_PIXELS)
CELLS = ['apt_balcony', 'apt_loggia', 'apt_ribbon', 'apt_fins', 'apt_screen',
         'apt_brick', 'apt_glass', 'apt_corridor', 'apt_endwall']


def noise(size, scale, seed, octaves=4):
    """Tileable value noise in [0, 1]."""
    rng = np.random.default_rng(seed)
    out = np.zeros((size, size))
    amp, total = 1.0, 0.0
    for o in range(octaves):
        n = max(2, int(scale * 2 ** o))
        grid = rng.random((n, n))
        idx = np.arange(size) * n / size
        i0 = np.floor(idx).astype(int) % n
        i1 = (i0 + 1) % n
        f = idx - np.floor(idx)
        f = f * f * (3 - 2 * f)
        rows = grid[i0][:, i0] * (1 - f)[None, :] + grid[i0][:, i1] * f[None, :]
        rows1 = grid[i1][:, i0] * (1 - f)[None, :] + grid[i1][:, i1] * f[None, :]
        out += amp * (rows * (1 - f)[:, None] + rows1 * f[:, None])
        total += amp
        amp *= 0.5
    return out / total


def grain(img, seed, strength=10, scale=40):
    """Adds tileable dirt and fine grain so flat paint does not look printed."""
    a = np.asarray(img).astype(float)
    n = noise(img.width, scale, seed)
    fine = np.random.default_rng(seed + 1).normal(0, 1, (img.height, img.width))
    a += ((n - .5) * strength * 2.2 + fine * strength * .35)[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def rect(d, box, fill):
    d.rectangle([int(round(v)) for v in box], fill=fill)


def shade(img, box, top, bottom):
    """Vertical gradient multiplier inside a box (soft shadow under slabs)."""
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    a = np.asarray(img).astype(float)
    rows = np.arange(y0, y1) % img.height    # the tile wraps vertically
    ramp = np.linspace(top, bottom, max(1, y1 - y0))[:, None, None]
    a[rows, max(0, x0):min(img.width, x1)] *= ramp
    img.paste(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)))


def tiles(d, box, size, grout, colors, rng, offset=0):
    """Small facade tiles in running bond."""
    x0, y0, x1, y1 = box
    w, h = size
    row = 0
    y = y0
    while y < y1:
        x = x0 - (w / 2 if row % 2 else 0) - offset
        while x < x1:
            c = colors[rng.integers(len(colors))]
            jitter = rng.integers(-6, 7)
            rect(d, (max(x, x0) + 1, y + 1, min(x + w, x1) - 1, min(y + h, y1) - 1),
                 tuple(int(v + jitter) for v in c))
            x += w
        y += h
        row += 1
    return grout


def window(img, d, box, rng, curtain=None, mullions=2, frame=(92, 98, 102), sky=True):
    """Glazed window: frame, sky reflection, room behind and a curtain."""
    x0, y0, x1, y1 = box
    rect(d, (x0 - 8, y0 - 8, x1 + 8, y1 + 8), frame)
    glass = Image.new('RGB', (int(x1 - x0), int(y1 - y0)))
    g = np.zeros((glass.height, glass.width, 3))
    t = np.linspace(0, 1, glass.height)[:, None]
    top = np.array([118, 140, 158]) if sky else np.array([60, 70, 78])
    low = np.array([38, 46, 54])
    g[:] = (top * (1 - t) + low * t)[:, None, :][:, 0, :][:, None, :]
    # A diagonal sheen across the pane.
    xs = np.arange(glass.width)[None, :]
    ys = np.arange(glass.height)[:, None]
    band = np.exp(-((xs - ys * .6 - glass.width * .35) / (glass.width * .12)) ** 2)
    g += band[..., None] * 34
    glass = Image.fromarray(np.clip(g, 0, 255).astype(np.uint8))
    gd = ImageDraw.Draw(glass)
    if curtain is not None:
        side = rng.random() < .5
        cw = glass.width * (.32 + rng.random() * .3)
        cx0 = 0 if side else glass.width - cw
        for i in range(int(cw // 14)):
            fold = 18 * np.sin(i * 1.7)
            c = tuple(int(np.clip(v + fold, 0, 255)) for v in curtain)
            gd.rectangle([cx0 + i * 14, 6, cx0 + i * 14 + 14, glass.height], fill=c)
    img.paste(glass, (int(x0), int(y0)))
    for i in range(1, mullions):
        mx = x0 + (x1 - x0) * i / mullions
        rect(d, (mx - 5, y0, mx + 5, y1), frame)
    rect(d, (x0, y0 + (y1 - y0) * .78 - 4, x1, y0 + (y1 - y0) * .78 + 4), frame)


def frosted_rail(img, box, tint=(196, 206, 206), alpha=.78):
    """Frosted glass balcony panel with rails and posts."""
    x0, y0, x1, y1 = [int(v) for v in box]
    a = np.asarray(img).astype(float)
    region = a[y0:y1, x0:x1]
    t = np.linspace(0, 1, y1 - y0)[:, None, None]
    frost = np.array(tint)[None, None, :] * (1.02 - .1 * t)
    a[y0:y1, x0:x1] = region * (1 - alpha) + frost * alpha
    img.paste(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)))
    d = ImageDraw.Draw(img)
    rect(d, (x0, y0 - 10, x1, y0 + 4), (150, 156, 158))
    rect(d, (x0, y1 - 6, x1, y1 + 4), (120, 126, 128))
    n = max(1, round((x1 - x0) / 210))
    for i in range(n + 1):
        px = x0 + (x1 - x0) * i / n
        rect(d, (px - 6, y0 - 10, px + 6, y1 + 4), (138, 144, 146))


def ac_unit(d, x, y, rng):
    """Outdoor air-conditioner unit standing on a balcony."""
    w, h = 118, 92
    rect(d, (x, y - h, x + w, y), (214, 214, 206))
    d.ellipse([x + 10, y - h + 12, x + 76, y - 14], fill=(170, 172, 168))
    for r in range(4):
        d.ellipse([x + 18 + r * 7, y - h + 20 + r * 7, x + 68 - r * 7, y - 22 - r * 7], outline=(138, 140, 138), width=3)
    rect(d, (x + 84, y - h + 14, x + 110, y - 16), (196, 196, 190))


def slab(img, d, y, color, depth=34, shadow=60):
    """Slab edge band across the tile with a soft shadow underneath."""
    rect(d, (0, y, TILE, y + depth), color)
    rect(d, (0, y + depth - 6, TILE, y + depth), tuple(int(c * .82) for c in color))
    shade(img, (0, y + depth, TILE, y + depth + shadow), .72, 1)


def cell_balcony(rng):
    img = Image.new('RGB', (TILE, TILE), (196, 180, 156))
    d = ImageDraw.Draw(img)
    tiles(d, (0, 0, TILE, TILE), (60, 30), None, [(201, 186, 160), (194, 178, 151), (206, 192, 168)], rng)
    img = grain(img, 11, 7, 30)
    d = ImageDraw.Draw(img)
    for f in range(2):
        top = f * FLOOR
        window(img, d, (90, top + 70, 420, top + 360), rng, curtain=(224, 220, 206), mullions=2)
        window(img, d, (520, top + 70, 760, top + 300), rng, curtain=(206, 214, 222), mullions=1)
        rect(d, (840, top + 36, TILE, top + FLOOR), (184, 176, 160))   # partition
        rect(d, (0, top + 36, 26, top + FLOOR), (184, 176, 160))
        ac_unit(d, 600, top + FLOOR - 40, rng)
        frosted_rail(img, (26, top + 248, 840, top + FLOOR - 36))
        d = ImageDraw.Draw(img)
        slab(img, d, top + FLOOR - 36, (222, 218, 208))
        d = ImageDraw.Draw(img)
    return img


def cell_loggia(rng):
    img = Image.new('RGB', (TILE, TILE), (226, 224, 216))
    img = grain(img, 21, 6, 24)
    d = ImageDraw.Draw(img)
    for f in range(2):
        top = f * FLOOR
        rect(d, (60, top + 40, 840, top + FLOOR - 40), (150, 148, 140))   # recess
        shade(img, (60, top + 40, 840, top + 140), .62, 1)
        d = ImageDraw.Draw(img)
        window(img, d, (110, top + 70, 470, top + 360), rng, curtain=(236, 232, 222), mullions=3)
        window(img, d, (560, top + 70, 790, top + 360), rng, curtain=None, mullions=1)
        rect(d, (40, top + 270, 860, top + FLOOR - 30), (220, 218, 210))   # solid parapet
        shade(img, (40, top + 270, 860, top + FLOOR - 30), 1.0, .9)
        d = ImageDraw.Draw(img)
        rect(d, (40, top + 246, 860, top + 258), (120, 128, 132))           # handrail
        for px in (60, 450, 840):
            rect(d, (px - 5, top + 246, px + 5, top + 272), (120, 128, 132))
        rect(d, (0, top + FLOOR - 30, TILE, top + FLOOR + 10), (232, 230, 222))
    return grain(img, 22, 4, 60)


def cell_ribbon(rng):
    img = Image.new('RGB', (TILE, TILE), (168, 172, 172))
    d = ImageDraw.Draw(img)
    tiles(d, (0, 0, TILE, TILE), (45, 45), None, [(172, 176, 176), (164, 168, 168), (178, 180, 178)], rng)
    img = grain(img, 31, 6, 30)
    d = ImageDraw.Draw(img)
    for f in range(2):
        top = f * FLOOR
        rect(d, (0, top + 96, TILE, top + 318), (82, 88, 92))
        for i, x in enumerate(range(0, TILE, 225)):
            window(img, d, (x + 10, top + 104, x + 215, top + 310), rng,
                   curtain=[(230, 226, 214), (210, 220, 228), None, (226, 214, 196)][i % 4], mullions=1)
        rect(d, (0, top + 318, TILE, top + 340), (198, 200, 198))           # sill band
        shade(img, (0, top + 340, TILE, top + 380), .82, 1)
        d = ImageDraw.Draw(img)
    return img


def cell_fins(rng):
    img = Image.new('RGB', (TILE, TILE), (206, 204, 196))
    img = grain(img, 41, 6, 30)
    d = ImageDraw.Draw(img)
    for f in range(2):
        top = f * FLOOR
        window(img, d, (120, top + 50, 400, top + 400), rng, curtain=(224, 218, 204), mullions=2)
        window(img, d, (500, top + 50, 780, top + 400), rng, curtain=(212, 222, 226), mullions=2)
        rect(d, (0, top + 410, TILE, top + FLOOR), (190, 188, 180))
    for x in (0, 450):
        rect(d, (x - 34 if x else 0, 0, x + 34, TILE), (232, 230, 222))
        shade(img, (x + 34, 0, x + 70, TILE), .7, .7)
        d = ImageDraw.Draw(img)
    rect(d, (TILE - 34, 0, TILE, TILE), (232, 230, 222))
    return grain(img, 42, 3, 80)


def cell_screen(rng):
    img = Image.new('RGB', (TILE, TILE), (186, 184, 176))
    d = ImageDraw.Draw(img)
    for f in range(2):
        top = f * FLOOR
        window(img, d, (80, top + 60, 440, top + 380), rng, curtain=(226, 222, 210), mullions=2)
        window(img, d, (520, top + 60, 820, top + 380), rng, curtain=None, mullions=2)
        ac_unit(d, 450, top + FLOOR - 40, rng)
    # Perforated metal screen panels over the balconies, lower two thirds.
    a = np.asarray(img).astype(float)
    ys, xs = np.mgrid[0:TILE, 0:TILE]
    holes = (((xs % 18) - 9) ** 2 + ((ys % 18) - 9) ** 2) < 26
    panel = (ys % FLOOR > 200) & (ys % FLOOR < FLOOR - 30)
    metal = np.array([204, 206, 204])
    a = np.where((panel & ~holes)[..., None], a * .25 + metal * .75, a)
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    for f in range(2):
        top = f * FLOOR
        for x in range(0, TILE + 1, 300):
            rect(d, (x - 5, top + 196, x + 5, top + FLOOR - 30), (150, 152, 150))
        slab(img, d, top + FLOOR - 30, (214, 212, 204), 30, 50)
        d = ImageDraw.Draw(img)
    return grain(img, 51, 4, 60)


def cell_brick(rng):
    img = Image.new('RGB', (TILE, TILE), (120, 112, 104))
    d = ImageDraw.Draw(img)
    tiles(d, (0, 0, TILE, TILE), (75, 25), None, [(150, 84, 66), (138, 76, 60), (160, 94, 74), (128, 70, 58)], rng)
    img = grain(img, 61, 6, 30)
    d = ImageDraw.Draw(img)
    for f in range(2):
        top = f * FLOOR
        for x0, x1 in ((110, 380), (520, 790)):
            window(img, d, (x0, top + 80, x1, top + 370), rng,
                   curtain=(228, 222, 206) if x0 < 300 else (214, 204, 186), mullions=2, frame=(214, 210, 200))
            rect(d, (x0 - 24, top + 376, x1 + 24, top + 396), (206, 200, 186))   # stone sill
            shade(img, (x0 - 24, top + 396, x1 + 24, top + 420), .75, 1)
            d = ImageDraw.Draw(img)
            rect(d, (x0 - 4, top + 250, x1 + 4, top + 258), (52, 54, 56))       # french balcony rail
            for px in range(x0, x1 + 1, 30):
                rect(d, (px - 2, top + 250, px + 2, top + 376), (52, 54, 56))
        rect(d, (0, top + FLOOR - 18, TILE, top + FLOOR), (176, 168, 152))
    return img


def cell_glass(rng):
    img = Image.new('RGB', (TILE, TILE), (64, 70, 74))
    d = ImageDraw.Draw(img)
    for f in range(2):
        top = f * FLOOR
        window(img, d, (30, top + 50, 870, top + 400), rng, curtain=(196, 196, 190), mullions=4,
               frame=(58, 62, 66))
        frosted_rail(img, (0, top + 246, TILE, top + FLOOR - 28), tint=(150, 176, 186), alpha=.42)
        d = ImageDraw.Draw(img)
        slab(img, d, top + FLOOR - 28, (88, 94, 98), 28, 36)
        d = ImageDraw.Draw(img)
    return grain(img, 71, 3, 60)


def cell_corridor(rng):
    """The back of a block: open access corridors with doors."""
    img = Image.new('RGB', (TILE, TILE), (200, 198, 190))
    img = grain(img, 81, 6, 24)
    d = ImageDraw.Draw(img)
    for f in range(2):
        top = f * FLOOR
        rect(d, (0, top + 36, TILE, top + FLOOR - 36), (118, 116, 110))     # corridor shadow
        shade(img, (0, top + 36, TILE, top + 160), .55, 1)
        d = ImageDraw.Draw(img)
        rect(d, (130, top + 90, 300, top + 380), (82, 90, 96))              # steel door
        rect(d, (146, top + 106, 284, top + 364), (96, 104, 110))
        rect(d, (262, top + 230, 274, top + 250), (190, 190, 182))          # handle
        rect(d, (340, top + 120, 420, top + 220), (176, 176, 168))          # meter box
        window(img, d, (520, top + 120, 760, top + 250), rng, curtain=None, mullions=1, sky=False)
        for gx in range(520, 761, 24):
            rect(d, (gx - 2, top + 120, gx + 2, top + 250), (150, 152, 150))  # grille
        d.ellipse([440, top + 50, 480, top + 74], fill=(250, 246, 226))     # ceiling light
        rect(d, (0, top + 270, TILE, top + FLOOR - 30), (210, 208, 200))    # parapet
        shade(img, (0, top + 270, TILE, top + FLOOR - 30), 1.0, .88)
        d = ImageDraw.Draw(img)
        rect(d, (0, top + 252, TILE, top + 262), (110, 116, 118))           # handrail
        rect(d, (0, top + FLOOR - 30, TILE, top + FLOOR + 6), (216, 214, 206))
    return grain(img, 82, 4, 60)


def cell_endwall(rng):
    """The gable end of a block: plain painted concrete, small windows."""
    img = Image.new('RGB', (TILE, TILE), (206, 202, 192))
    img = grain(img, 91, 9, 16)
    d = ImageDraw.Draw(img)
    for f in range(2):
        top = f * FLOOR
        rect(d, (0, top + FLOOR - 3, TILE, top + FLOOR + 3), (176, 172, 162))  # formwork joint
        window(img, d, (360, top + 150, 540, top + 300), rng, curtain=(222, 218, 206), mullions=1)
        rect(d, (350, top + 304, 550, top + 318), (188, 184, 174))
    rect(d, (TILE - 40, 0, TILE - 26, TILE), (150, 150, 146))                # drain pipe
    # Rain streaks under the windows.
    a = np.asarray(img).astype(float)
    streak = noise(TILE, 3, 92, 2)[:, :1].repeat(TILE, 1).T
    xs = np.arange(TILE)
    mask = (np.abs(xs - 450) < 90)[None, :] * (np.linspace(0, 1, TILE)[:, None] % .5 > .34)
    a *= (1 - .12 * mask * streak[:TILE, :TILE])[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


DRAW = [cell_balcony, cell_loggia, cell_ribbon, cell_fins, cell_screen,
        cell_brick, cell_glass, cell_corridor, cell_endwall]


def fit(tile):
    """Places one repeat in the cell's inner window and wraps it outward."""
    window = CELL * (1 - 2 * INSET)
    scaled = tile.resize((round(window), round(window)), Image.LANCZOS)
    cell = Image.new('RGB', (CELL, CELL))
    start = CELL * INSET
    for oy in (-1, 0, 1):
        for ox in (-1, 0, 1):
            cell.paste(scaled, (round(start + ox * window), round(start + oy * window)))
    return cell


def main():
    sheet = Image.new('RGB', (CELL * 3, CELL * 3))
    for i, draw in enumerate(DRAW):
        rng = np.random.default_rng(1000 + i)
        random.seed(1000 + i)
        tile = draw(rng).filter(ImageFilter.GaussianBlur(.6))
        sheet.paste(fit(tile), ((i % 3) * CELL, (i // 3) * CELL))
    source = os.path.join(ROOT, 'textures/source/apartments.webp')
    sheet.save(source, quality=92)
    sheet.resize((SHIP, SHIP), Image.LANCZOS).save(os.path.join(ROOT, 'dist/textures/apartments.webp'),
                                                   quality=56, method=6)
    with open(os.path.join(ROOT, 'textures/source/apartments.json'), 'w') as f:
        json.dump({'source': 'drawn', 'script': '.claude/skills/texture-sheets/scripts/draw-apartments.py',
                   'size': f'{CELL * 3}x{CELL * 3}', 'cells': CELLS}, f, indent=2)
        f.write('\n')


if __name__ == '__main__':
    main()
