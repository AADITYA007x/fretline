import json, sys
from PIL import Image, ImageDraw
rows = [json.loads(l) for l in open(sys.argv[1])]
ims = []
for r in rows:
    im = Image.open(r["image"]).convert("RGB")
    im = im.resize((im.width * 2, im.height * 2))
    lab = Image.new("RGB", im.size, (255, 255, 255))
    d = ImageDraw.Draw(lab)
    for L in r["labels"]:
        col = (0, 0, 200) if L["p"] >= 0.8 else (220, 0, 0)
        if L["text"] in ("-", "--"):
            col = (170, 170, 170)
        d.text((L["x"] * 2, L["y"] * 2), L["text"], fill=col)
    ims += [im, lab]
W = max(i.width for i in ims)
o = Image.new("RGB", (W, sum(i.height for i in ims)), (0, 0, 0))
y = 0
for i in ims:
    o.paste(i, (0, y)); y += i.height
o.save(sys.argv[2])
