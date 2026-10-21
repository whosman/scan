"""Make a few synthetic phone photos from open-licence text only (DejaVu font). Used by CI; no private or licensed data."""
import sys, json, os, numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1] if len(sys.argv) > 1 else "tests/samples"
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(3)
font_paths = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf"]
fp = next((f for f in font_paths if os.path.exists(f)), None)
labels = []
for k, (bg, roll) in enumerate([((60, 90, 140), 4), ((205, 210, 214), -8), ((40, 40, 45), 93)]):
    page = Image.new("L", (850, 1100), 250); d = ImageDraw.Draw(page)
    f = ImageFont.truetype(fp, 26) if fp else ImageFont.load_default()
    for i in range(18):
        d.text((70, 60 + i * 52), f"{i + 1}) F = qE = {rng.uniform(1, 9):.2f}E-3 N   x = {rng.integers(10, 99)} cm", fill=30, font=f)
    p = cv2.cvtColor(np.array(page), cv2.COLOR_GRAY2BGR)
    W, H = 1280, 960
    src = np.float32([[0, 0], [850, 0], [850, 1100], [0, 1100]])
    c = np.array([W / 2, H / 2]); s = 0.75
    th = np.radians(roll); Rm = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
    dst = ((src - [425, 550]) * s) @ Rm.T + c + rng.uniform(-25, 25, (4, 2))
    M = cv2.getPerspectiveTransform(src, np.float32(dst))
    img = np.full((H, W, 3), bg, np.uint8)
    warped = cv2.warpPerspective(p, M, (W, H)); mask = cv2.warpPerspective(np.full((1100, 850), 255, np.uint8), M, (W, H)) > 0
    img[mask] = warped[mask]
    yy, xx = np.mgrid[0:H, 0:W]; img = np.clip(img * (0.7 + 0.3 * xx / W)[..., None] + rng.normal(0, 3, img.shape), 0, 255).astype(np.uint8)
    name = f"sample{k + 1}.jpg"; cv2.imwrite(os.path.join(out, name), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    labels.append({"file": name, "quad": np.round(dst, 2).tolist(), "roll": roll})
json.dump(labels, open(os.path.join(out, "labels.json"), "w")); print("wrote", len(labels), "samples to", out)
