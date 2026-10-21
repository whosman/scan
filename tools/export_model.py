"""Export the orientation model (.npz) to the app format (updown.bin + updown.json)."""
import paths as PATHS  # noqa: F401
import json, sys, numpy as np
src = sys.argv[1] if len(sys.argv) > 1 else str(PATHS.PYTHON / "hwscan_updown.npz")
d = np.load(src); meta = {}; parts = []; off = 0
for k in ["mu", "sd", "W1", "b1", "W2", "b2"]:
    a = np.asarray(d[k], np.float32).ravel(); meta[k] = [off, a.size]; off += a.size; parts.append(a)
meta["nh"] = int(d["b1"].size)
open(PATHS.ROOT / "app" / "updown.bin", "wb").write(np.concatenate(parts).tobytes())
json.dump(meta, open(PATHS.ROOT / "app" / "updown.json", "w")); print("exported", src, off * 4, "bytes")
