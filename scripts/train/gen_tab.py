"""Draw made-up tab strips like the ones in guitar lesson videos, with the
truth written next to them, to teach the digit reader.

Mostly the plain kinds seen in real lessons (Times/Arial-like fonts, black
digits on white or a pale highlight, grey staff lines, stems and beams under
the digits, a blue cursor now and then), with some x marks, slides, rests,
arcs and arrows around to learn what is *not* a digit.

Usage: python gen_tab.py OUT_DIR COUNT SEED
"""
import json
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = [
    # (path, weight): the common tab looks first
    ("/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf", 5),
    ("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", 5),
    ("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", 2),
    ("/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf", 1),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 3),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", 2),
    ("/usr/share/fonts/truetype/freefont/FreeSans.ttf", 2),
    ("/usr/share/fonts/truetype/freefont/FreeSerif.ttf", 2),
    ("/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf", 1),
    ("/usr/share/fonts/truetype/crosextra/Caladea-Regular.ttf", 1),
]
FONTS = [(p, w) for p, w in FONTS if os.path.exists(p)]

S = 4  # draw 4x bigger, then shrink (like a video frame)


def pick_font():
    tot = sum(w for _, w in FONTS)
    r = random.uniform(0, tot)
    for p, w in FONTS:
        r -= w
        if r <= 0:
            return p
    return FONTS[0][0]


def fret():
    r = random.random()
    if r < 0.75:
        return str(random.choice([0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 3, 4, 5, 5, 6, 7, 7, 8, 9]))
    return str(random.randint(10, 15))


def one(seed, out_dir, idx):
    random.seed(seed)
    sp = random.uniform(9, 21)  # staff spacing in the final picture
    W = 640
    H = int(sp * 8.5)
    big = Image.new("RGB", (W * S, H * S), (255, 255, 255))
    d = ImageDraw.Draw(big)
    bgc = random.choice([(255, 255, 255), (250, 250, 250), (245, 245, 245)])
    d.rectangle([0, 0, W * S, H * S], fill=bgc)
    # a pale highlighted bar sometimes
    if random.random() < 0.4:
        x0 = random.uniform(0, W * 0.7)
        hl = random.choice([(250, 246, 190), (252, 248, 205), (235, 245, 215)])
        d.rectangle([x0 * S, 0, (x0 + random.uniform(80, 260)) * S, H * S], fill=hl)
    top = sp * 1.25
    lines = [top + i * sp for i in range(6)]
    gray = random.randint(120, 195)
    lw = max(1, round(random.uniform(0.7, 1.3) * S))
    for y in lines:
        d.line([(0, y * S), (W * S, y * S)], fill=(gray, gray, gray), width=lw)

    fpath = pick_font()
    dh = random.uniform(0.65, 0.92) * sp  # digit height
    font = ImageFont.truetype(fpath, int(dh * S / 0.72))
    ink = random.choice([(0, 0, 0), (20, 20, 20), (40, 40, 40), (60, 60, 60)])
    truth = []
    x = random.uniform(1.0, 2.5) * sp
    stems = random.random() < 0.5
    prev_stem = None
    while x < W - sp * 1.5:
        nstr = random.choices([1, 1, 1, 2, 2, 3], k=1)[0]
        strings = random.sample(range(6), nstr)
        bottom_digit = None
        for s in strings:
            y = lines[s]
            if random.random() < 0.06:
                text = "x"
                f = ImageFont.truetype(fpath, int(dh * S / 0.72 * 0.9))
            else:
                text = fret()
                f = font
            bb = d.textbbox((0, 0), text, font=f)
            tw, th = bb[2] - bb[0], bb[3] - bb[1]
            cx, cy = x * S, y * S
            if random.random() < 0.75:  # tab editors clear the line behind a digit
                pad = S * random.uniform(0.5, 1.5)
                d.rectangle([cx - tw / 2 - pad, cy - th / 2 - pad / 2, cx + tw / 2 + pad, cy + th / 2 + pad / 2], fill=bgc)
            d.text((cx - tw / 2 - bb[0], cy - th / 2 - bb[1]), text, font=f, fill=ink)
            truth.append({"string": s + 1, "x": x, "text": text})
            if bottom_digit is None or y * S + th / 2 > bottom_digit[1]:
                bottom_digit = (cx, y * S + th / 2)
        # stems hang from the lowest digit (sometimes touching it), beams join them
        if stems and bottom_digit:
            sx = bottom_digit[0] + random.uniform(-0.05, 0.05) * sp * S
            gap = random.choice([0, 0, 1, 2]) * S
            yb = (lines[5] + sp * random.uniform(0.6, 1.1)) * S
            d.line([(sx, bottom_digit[1] + gap), (sx, yb)], fill=ink, width=lw)
            if prev_stem and random.random() < 0.6:
                d.rectangle([prev_stem[0], yb - 2 * S, sx, yb + random.choice([0, 1]) * S], fill=ink)
            prev_stem = (sx, yb)
        step = random.uniform(1.6, 3.2) * sp
        # things that aren't digits, in the gap before the next column
        gap_x = x * S + step * S * 0.5
        r = random.random()
        if step > 2.2 * sp:
            if r < 0.06:  # a slide mark between this column and the next
                s = random.randrange(6)
                y = lines[s] * S
                d.line([(gap_x - sp * 0.35 * S, y + sp * 0.22 * S), (gap_x + sp * 0.35 * S, y - sp * 0.22 * S)], fill=ink, width=max(S, lw))
            elif r < 0.1:  # a rest: a zigzag across the middle
                y0 = lines[2] * S - sp * 0.6 * S
                pts = [(gap_x + (S * 3 if k % 2 else 0), y0 + k * sp * 0.35 * S) for k in range(5)]
                d.line(pts, fill=ink, width=max(S, lw * 2))
            elif r < 0.13:  # a strum arrow just before the next column
                ax = (x + step) * S - sp * 0.7 * S
                d.line([(ax, lines[0] * S), (ax, lines[4] * S)], fill=ink, width=max(S, lw))
                d.polygon([(ax - sp * 0.3 * S, lines[4] * S), (ax + sp * 0.3 * S, lines[4] * S), (ax, lines[4] * S + sp * 0.6 * S)], fill=ink)
            elif r < 0.16:  # a bar line
                d.line([(gap_x, lines[0] * S), (gap_x, lines[5] * S)], fill=(40, 40, 40), width=lw)
        if random.random() < 0.12 and step > 2.0 * sp:
            # a letter or sign sitting on a string (h, p, brackets, a dot...): not a digit
            jc = random.choice(list("hpbsrHPT~()<>/") + ["\\", ".", "~"])
            js = random.randrange(6)
            jf = ImageFont.truetype(fpath, int(dh * S / 0.72 * random.uniform(0.7, 1.0)))
            bb = d.textbbox((0, 0), jc, font=jf)
            jx, jy = gap_x, lines[js] * S
            d.text((jx - (bb[2] - bb[0]) / 2 - bb[0], jy - (bb[3] - bb[1]) / 2 - bb[1]), jc, font=jf, fill=ink)
        if r > 0.9:  # an arc over this note and the next, above the top string used
            y = lines[0] * S - sp * 0.6 * S
            d.arc([x * S, y - sp * 0.25 * S, (x + step) * S, y + sp * 0.25 * S], 200, 340, fill=ink, width=max(S, lw))
        x += step
    # the moving cursor
    if random.random() < 0.3:
        cx = random.uniform(10, W - 10) * S
        d.line([(cx, 0), (cx, H * S)], fill=random.choice([(40, 60, 220), (120, 200, 230)]), width=max(S, lw * 2))
    small = big.resize((W, H), Image.LANCZOS)
    if random.random() < 0.6:
        small = small.filter(ImageFilter.GaussianBlur(random.uniform(0.2, 0.6)))
    name = f"t{idx:05d}.jpg"
    small.save(os.path.join(out_dir, name), quality=random.randint(60, 92))
    return {"image": name, "lines": lines, "spacing": sp, "truth": truth}


def main():
    out_dir, count, seed = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    os.makedirs(out_dir, exist_ok=True)
    items = [one(seed * 100000 + i, out_dir, i) for i in range(count)]
    with open(os.path.join(out_dir, "truth.json"), "w") as f:
        json.dump(items, f)


if __name__ == "__main__":
    main()
