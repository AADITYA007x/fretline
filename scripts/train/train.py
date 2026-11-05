"""Train the digit reader on examples from extract.ts and write it out as
src/scan/digits-model.json (a small 2-layer network the app runs itself).

Usage: python train.py OUT.json train1.bin [train2.bin ...]
The last file is held out to check how well it reads examples it never saw.
"""
import json
import struct
import sys

import numpy as np
from sklearn.neural_network import MLPClassifier

D = 16 * 16 + 2
CLASSES = list("0123456789") + ["x", "-"]


def load(path):
    with open(path, "rb") as f:
        buf = f.read()
    n = struct.unpack_from("<I", buf, 0)[0]
    rec = D * 4 + 1
    X = np.empty((n, D), np.float32)
    y = np.empty(n, np.int64)
    for i in range(n):
        o = 4 + i * rec
        X[i] = np.frombuffer(buf, np.float32, D, o)
        y[i] = buf[o + D * 4]
    return X, y


def main():
    out, *files = sys.argv[1:]
    parts = [load(f) for f in files]
    Xtr = np.concatenate([p[0] for p in parts[:-1]])
    ytr = np.concatenate([p[1] for p in parts[:-1]])
    Xte, yte = parts[-1]
    mean = Xtr.mean(0)
    std = Xtr.std(0) + 1e-3
    clf = MLPClassifier(hidden_layer_sizes=(96, 48), alpha=1e-4, batch_size=256, max_iter=60, early_stopping=True, random_state=1)
    clf.fit((Xtr - mean) / std, ytr)
    pred = clf.predict((Xte - mean) / std)
    acc = (pred == yte).mean()
    print(f"train {len(ytr)}  held-out {len(yte)}  held-out accuracy {acc:.4f}")
    digits = yte < 10
    print(f"  digits only: {(pred[digits] == yte[digits]).mean():.4f}")
    # confusions worth knowing
    conf = {}
    for t, p in zip(yte, pred):
        if t != p:
            conf[(CLASSES[t], CLASSES[p])] = conf.get((CLASSES[t], CLASSES[p]), 0) + 1
    print("  most mixed up:", sorted(conf.items(), key=lambda kv: -kv[1])[:10])
    layers = []
    for W, b in zip(clf.coefs_, clf.intercepts_):
        layers.append({"in": W.shape[0], "out": W.shape[1], "w": [round(float(v), 5) for v in W.T.reshape(-1)], "b": [round(float(v), 5) for v in b]})
    assert list(clf.classes_) == list(range(len(CLASSES))), clf.classes_
    with open(out, "w") as f:
        json.dump({"layers": layers, "mean": [round(float(v), 5) for v in mean], "std": [round(float(v), 5) for v in std]}, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
