"""
PAP-1694 AC2 — OpenCV-vs-JS parity study for the four `preprocess` primitives.

Consumes the raw planes dumped by pap1694.dump-js-stages.mjs and, for each
primitive, runs the closest cv2 equivalent twice:

  * ISOLATED  — cv2 primitive fed the *JS* input for that stage. Isolates the
                per-primitive delta with no upstream contamination.
  * CHAINED   — full cv2 chain from RGBA. This is what the app would actually
                see if preprocess were ported wholesale, so it is the number
                AC5 (accuracy) risk should be read off.

Host cv2 stands in for the on-device OpenCV: react-native-fast-opencv 1.0.1
bundles org.opencv:opencv:4.12.0, host here is whatever cv2.__version__ says.
Same algorithms, same default params — this is a semantics check, not a
bit-exactness claim across OpenCV builds.
"""
import json, os, sys
import numpy as np
import cv2

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
D = os.path.join(ROOT, '.cache', 'pap1694-parity')
index = json.load(open(os.path.join(D, 'index.json')))

def load(stamp, kind, w, h, ch=1):
    a = np.fromfile(os.path.join(D, f'{stamp}.{kind}.bin'), dtype=np.uint8)
    return a.reshape(h, w, ch) if ch > 1 else a.reshape(h, w)

def stats(js, cv):
    d = np.abs(js.astype(np.int16) - cv.astype(np.int16))
    return dict(
        mean_abs=float(d.mean()),
        max_abs=int(d.max()),
        pct_diff=float((d > 0).mean() * 100),
        pct_gt1=float((d > 1).mean() * 100),
        pct_gt8=float((d > 8).mean() * 100),
    )

def binstats(js, cv):
    a, b = js > 0, cv > 0
    inter = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return dict(
        js_on_pct=float(a.mean() * 100),
        cv_on_pct=float(b.mean() * 100),
        iou=float(inter / union) if union else 1.0,
        pct_diff=float((a != b).mean() * 100),
    )

acc = {}
def add(key, s):
    acc.setdefault(key, []).append(s)

for it in index:
    stamp, w, h = it['stamp'], it['w'], it['h']
    rgba = load(stamp, 'rgba', w, h, 4)
    js_gray  = load(stamp, 'gray',  w, h)
    js_clahe = load(stamp, 'clahe', w, h)
    js_blur  = load(stamp, 'blur',  w, h)
    js_canny = load(stamp, 'canny', w, h)

    clahe_op = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))

    # ---- ISOLATED ----
    cv_gray_i  = cv2.cvtColor(rgba, cv2.COLOR_RGBA2GRAY)
    cv_clahe_i = clahe_op.apply(js_gray)
    cv_blur_i  = cv2.GaussianBlur(js_clahe, (5, 5), 0, borderType=cv2.BORDER_REPLICATE)
    cv_canny_i = cv2.Canny(js_blur, 50, 150, L2gradient=True)
    cv_canny_i_l1 = cv2.Canny(js_blur, 50, 150, L2gradient=False)

    add('iso.gray',  stats(js_gray,  cv_gray_i))
    add('iso.clahe', stats(js_clahe, cv_clahe_i))
    add('iso.blur',  stats(js_blur,  cv_blur_i))
    add('iso.canny_L2', binstats(js_canny, cv_canny_i))
    add('iso.canny_L1', binstats(js_canny, cv_canny_i_l1))

    # ---- CHAINED ----
    g = cv2.cvtColor(rgba, cv2.COLOR_RGBA2GRAY)
    e = clahe_op.apply(g)
    b = cv2.GaussianBlur(e, (5, 5), 0, borderType=cv2.BORDER_REPLICATE)
    c = cv2.Canny(b, 50, 150, L2gradient=True)
    add('chain.gray',  stats(js_gray,  g))
    add('chain.clahe', stats(js_clahe, e))
    add('chain.blur',  stats(js_blur,  b))
    add('chain.canny', binstats(js_canny, c))

print(f'cv2 {cv2.__version__}   n={len(index)} images @ 900px cap\n')
for key in ['iso.gray', 'iso.clahe', 'iso.blur', 'chain.gray', 'chain.clahe', 'chain.blur']:
    rows = acc[key]
    m = {k: float(np.mean([r[k] for r in rows])) for k in rows[0]}
    print(f'{key:<14} mean|Δ|={m["mean_abs"]:6.2f}  max|Δ|={m["max_abs"]:5.1f}  '
          f'pixels Δ≠0={m["pct_diff"]:5.1f}%  Δ>1={m["pct_gt1"]:5.1f}%  Δ>8={m["pct_gt8"]:5.1f}%')
print()
for key in ['iso.canny_L2', 'iso.canny_L1', 'chain.canny']:
    rows = acc[key]
    m = {k: float(np.mean([r[k] for r in rows])) for k in rows[0]}
    print(f'{key:<14} JS edge px={m["js_on_pct"]:5.2f}%  cv edge px={m["cv_on_pct"]:5.2f}%  '
          f'IoU={m["iou"]:.3f}  disagree={m["pct_diff"]:5.2f}% of pixels')

json.dump({k: v for k, v in acc.items()},
          open(os.path.join(ROOT, 'debug-reports', 'pap1694_opencv_parity.json'), 'w'), indent=1)
