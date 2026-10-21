"""Python access to the Rust/WebAssembly engine (app/engine-simd.wasm) through wasmtime. Used by the tests and the benchmarks.
The same module runs in the browser, so what is measured here is what the students get."""
import ctypes, os
import numpy as np
from wasmtime import Engine, Store, Module, Instance

HERE = os.path.dirname(os.path.abspath(__file__))
WASM = os.environ.get("HWSCAN_WASM") or os.path.join(HERE, "..", "app", "engine-simd.wasm")


class Engine_:
    def __init__(self, path=WASM):
        self.engine = Engine(); self.store = Store(self.engine)
        self.module = Module.from_file(self.engine, path)
        self.inst = Instance(self.store, self.module, [])
        ex = self.inst.exports(self.store)
        self.mem = ex["memory"]; self.ex = ex
        self.nf = ex["hw_nf"](self.store)

    def call(self, name, *args):
        return self.ex[name](self.store, *args)

    def _base(self):
        return ctypes.cast(self.mem.data_ptr(self.store), ctypes.c_void_p).value

    def write(self, data: bytes):
        p = self.call("hw_alloc", len(data))
        ctypes.memmove(self._base() + p, data, len(data))
        return p

    def read_f32(self, ptr, n):
        return np.frombuffer((ctypes.c_char * (4 * n)).from_address(self._base() + ptr), dtype=np.float32).copy()

    def read_u8(self, ptr, n):
        return np.frombuffer((ctypes.c_char * n).from_address(self._base() + ptr), dtype=np.uint8).copy()

    def set_weights(self, w):
        w = np.asarray(w, np.float32); p = self.write(w.tobytes()); self.call("hw_set_weights", p, len(w)); self.call("hw_free", p, w.nbytes)

    def detect(self, bgr):
        h, w = bgr.shape[:2]
        rgba = np.dstack([bgr[:, :, 2], bgr[:, :, 1], bgr[:, :, 0], np.full((h, w), 255, np.uint8)])
        p = self.write(np.ascontiguousarray(rgba).tobytes())
        found = self.call("hw_detect", p, w, h)
        self.call("hw_free", p, rgba.nbytes)
        info = self.read_f32(self.call("hw_det_info"), 40)
        n = self.call("hw_cand_count"); stride = self.call("hw_cand_stride")
        cands = self.read_f32(self.call("hw_cand_buf"), n * stride).reshape(n, stride) if n else np.zeros((0, stride), np.float32)
        return found, info, cands

def _quad_features(self, q):
    q = np.asarray(q, np.float32).reshape(8); p = self.write(q.tobytes()); o = self.call("hw_alloc", 4 * (self.nf + 1))
    self.call("hw_quad_features", p, o); r = self.read_f32(o, self.nf + 1); self.call("hw_free", p, 32); self.call("hw_free", o, 4 * (self.nf + 1)); return r


Engine_.quad_features = _quad_features

PAPERS = {"letter": (11.0 / 8.5, 11.0), "a4": (11.69 / 8.27, 11.69)}
WARNINGS = [
    (1, "The photo is too small to read well. Move the phone closer."),
    (2, "The photo is blurry. Hold still and tap the screen to focus."),
    (4, "There is glare on the page. Tilt the phone or move the light."),
    (8, "Part of the page is cut off. Keep all four corners in view."),
    (16, "The page edges are hard to see. Use a darker table and keep all four corners in view."),
    (32, "We could not tell which way is up. Please check this page."),
]


def _load_model(self):
    import json
    base = os.path.join(HERE, "..", "app")
    meta = json.load(open(os.path.join(base, "updown.json"))); raw = open(os.path.join(base, "updown.bin"), "rb").read()
    p = self.write(raw)
    self.call("hw_set_model", p, len(raw) // 4, meta["mu"][0], meta["sd"][0], meta["W1"][0], meta["b1"][0], meta["W2"][0], meta["b2"][0], meta["b1"][1])
    self.call("hw_free", p, len(raw))


def _process(self, bgr, quad=None, dpi=200, paper="letter", margin=10.0, autorotate=True):
    h, w = bgr.shape[:2]
    rgba = np.dstack([bgr[:, :, 2], bgr[:, :, 1], bgr[:, :, 0], np.full((h, w), 255, np.uint8)])
    p = self.write(np.ascontiguousarray(rgba).tobytes())
    ratio, long_in = PAPERS[paper]
    o = [ratio, long_in, dpi, margin, 1.0 if autorotate else 0.0, 1.0 if quad is not None else 0.0] + (list(np.asarray(quad, np.float32).reshape(8)) if quad is not None else [0.0] * 8)
    op = self.write(np.asarray(o, np.float32).tobytes())
    found = self.call("hw_process", p, w, h, op)
    self.call("hw_free", p, rgba.nbytes); self.call("hw_free", op, 56)
    ow, oh = self.call("hw_out_w"), self.call("hw_out_h")
    out = self.read_u8(self.call("hw_out_rgba"), ow * oh * 4).reshape(oh, ow, 4)
    gray = ((77 * out[:, :, 0].astype(np.uint16) + 151 * out[:, :, 1].astype(np.uint16) + 28 * out[:, :, 2].astype(np.uint16)) >> 8).astype(np.uint8)
    info = self.read_f32(self.call("hw_proc_info"), 32)
    return found, out, gray, info


def warnings_of(info):
    bits = int(info[19]); return [t for b, t in WARNINGS if bits & b]


Engine_.process = _process
Engine_.load_model = _load_model