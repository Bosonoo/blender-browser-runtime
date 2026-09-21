"""Apply the bounded autosave + canvas adapter to the pinned native build tree.

The old released distribution/source archives are never rewritten. Run on the
new candidate source/cache before compiling wm_files.cc and rebuilding Vite.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent


def replace_once(text: str, before: str, after: str) -> str:
    if text.count(before) != 1:
        raise ValueError("Browser adapter anchor drift: " + before[:100])
    return text.replace(before, after, 1)


def patch_native(text: str, adapter: str) -> str:
    text = replace_once(text, "#  include <emscripten/emscripten.h>",
                        "#  include <atomic>\n#  include <emscripten/emscripten.h>")
    return replace_once(text, "void wm_web_poll_pending_file_open(bContext *C)\n{",
                        adapter + "\n\nvoid wm_web_poll_pending_file_open(bContext *C)\n{\n"
                        "  wm_bosonoo_autosave_poll(C);")


def patch_frontend(text: str) -> str:
    # Only the pre-launch canvas belongs to the DOM. After transfer the native
    # GHOST resize event reads CSS geometry and updates its WebGPU backbuffer.
    # The native patch below also sizes the OffscreenCanvas on its owning thread.
    return replace_once(text,
                        "const fitCanvas = () => {\n  if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {",
                        "const fitCanvas = () => {\n  if (window.Module) return; // Native render thread owns the transferred canvas.\n"
                        "  if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {")


def patch_resize(text: str) -> str:
    return replace_once(text, "  canvas_w_ = uint32_t(w);\n  canvas_h_ = uint32_t(h);\n  if (window_) {",
                        "  canvas_w_ = uint32_t(w);\n  canvas_h_ = uint32_t(h);\n"
                        "  /* Resize on the render pthread that owns the OffscreenCanvas. */\n"
                        "  emscripten_set_canvas_element_size(WEB_CANVAS, canvas_w_, canvas_h_);\n"
                        "  if (window_) {")


def apply(root: Path) -> list[dict]:
    adapter = (HERE / "bosonoo_autosave.inc").read_text(encoding="utf-8")
    paths = [
        ("blender/source/blender/windowmanager/intern/wm_files.cc", lambda t: patch_native(t, adapter)),
        ("blender/intern/ghost/intern/GHOST_SystemWeb.cc", patch_resize),
        ("demo/src/main.js", patch_frontend),
    ]
    # Validate all input hashes and anchors before changing any file.
    staged = []
    for relative, transform in paths:
        path = root / relative
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != SOURCE_SHA256[relative]:
            raise ValueError("Pinned browser adapter input mismatch: " + relative)
        output = transform(raw.decode("utf-8")).encode("utf-8")
        staged.append((path, output, {"path": relative, "before": digest,
                                    "after": hashlib.sha256(output).hexdigest()}))
    for path, output, _ in staged:
        path.write_bytes(output)
    return [receipt for _, _, receipt in staged]


# Blender 6b031d3d41c392883e3c495aa72343e10d15b43d / builder 60315a3.
SOURCE_SHA256 = {
    "blender/source/blender/windowmanager/intern/wm_files.cc": "5dc8424ee52c9acbc0a16140df2acae1f879b18ec5b189135d68ac88c783fc5f",
    "blender/intern/ghost/intern/GHOST_SystemWeb.cc": "c48a61ab566e910f71dce2176fad2eb451defa327267097dfcf5060111464e69",
    "demo/src/main.js": "ccbe20f230067e56e498bfc7cb6fa3534e844c948a942f19d59e5b61b2b54f1b",
}


if __name__ == "__main__":
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    print(json.dumps(apply(args.root), indent=2))
