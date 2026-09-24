"""Bosonoo person-session guards for browser Blender 5.3 alpha (every session).

bridge.js runs this manifest-pinned pack script with ``--python`` after the
hydrated ``.blend`` has loaded, in person sessions and AI command sessions
alike. It holds no mailbox, no network and no file access.

Why it exists: the wasm build runs every window-manager job synchronously on
Blender's main thread (``wm_jobs.cc`` WM_jobs_start, ``__EMSCRIPTEN__`` branch).
A material, world or light preview is first requested while the interface is
being drawn, and a preview without stored pixels starts its "Generating icon
preview..." job at once, inside ``wm_draw_update`` - which holds
``GPU_context_main_lock()``. The EEVEE preview render then enters
``DRW_render_context_enable``, which takes that same non-recursive lock again
because the WebGPU backend forces ``use_main_context_workaround``. Blender's
main loop blocks forever on its own mutex (the page itself stays responsive).
The Preview panels start a shader-preview job the same way.

The guard needs no rebuild: a preview marked user-edited is never auto-rendered
(``interface_icons.cc`` icon_set_image), so every material, world, light and
texture gets a plain swatch preview before the interface draws it, and the
Properties "Preview" panels show a note instead of starting a render. F12 and
viewport shading start their work from events, not from drawing, and are left
alone.
"""
from __future__ import annotations

import math
from collections import OrderedDict

try:  # Loaded outside Blender by the unit tests.
    import bpy
    from bpy.app.handlers import persistent
except ImportError:  # pragma: no cover - exercised only outside Blender
    bpy = None

    def persistent(function):
        return function

ICON_SIZE = 32       # ICON_SIZE_ICON render size (ICON_RENDER_DEFAULT_HEIGHT)
IMAGE_SIZE = 128     # ICON_SIZE_PREVIEW render size (PREVIEW_RENDER_DEFAULT_HEIGHT)
# Only the ID types whose automatic preview is an EEVEE render.
COLLECTIONS = ("materials", "worlds", "lights", "textures")
PREVIEW_NOTE = "Live previews are off in browser Blender: rendering one here stops Blender."
LOG_PREFIX = "[bosonoo-session]"
_LIGHT = (-0.45, 0.55, 0.70)   # unnormalised key light, up-left-front (rows run bottom-up)
MAX_CACHED_SWATCHES = 16       # Colour-picker drags must not retain every preview ever generated.
_swatches: OrderedDict = OrderedDict()  # (size, rgb) -> flat premultiplied RGBA floats
_painted: dict = {}            # ID pointer -> rgb last painted


def _log(*parts) -> None:
    print(LOG_PREFIX, *parts, flush=True)


def _to_srgb(channel: float) -> float:
    value = min(max(float(channel), 0.0), 1.0)
    return value * 12.92 if value <= 0.0031308 else 1.055 * value ** (1.0 / 2.4) - 0.055


def swatch_pixels(size: int, rgb) -> list:
    """A lit ball on transparency: size*size premultiplied sRGB RGBA floats, rows bottom-up."""
    key = (int(size), tuple(round(float(c), 4) for c in rgb[:3]))
    cached = _swatches.get(key)
    if cached is not None:
        _swatches.move_to_end(key)
        return cached
    colour = [_to_srgb(c) for c in key[1]]
    norm = math.sqrt(sum(c * c for c in _LIGHT))
    light = [c / norm for c in _LIGHT]
    radius = size * 0.45
    centre = (size - 1) / 2.0
    pixels = []
    for row in range(size):
        dy = (row - centre) / radius
        for col in range(size):
            dx = (col - centre) / radius
            distance = math.sqrt(dx * dx + dy * dy)
            # One pixel of antialiasing at the rim.
            alpha = min(max((1.0 - distance) * radius + 0.5, 0.0), 1.0)
            if alpha <= 0.0:
                pixels.extend((0.0, 0.0, 0.0, 0.0))
                continue
            nz = math.sqrt(max(0.0, 1.0 - min(distance, 1.0) ** 2))
            diffuse = max(0.0, dx * light[0] + dy * light[1] + nz * light[2])
            shade = 0.3 + 0.7 * diffuse
            pixels.extend((min(1.0, c * shade) * alpha for c in colour))
            pixels.append(alpha)
    _swatches[key] = pixels
    while len(_swatches) > MAX_CACHED_SWATCHES:
        _swatches.popitem(last=False)
    return pixels


def id_colour(idblock) -> tuple:
    """The colour a swatch shows: base colour, world colour, light colour, else grey."""
    try:
        tree = getattr(idblock, "node_tree", None)
        if tree is not None:
            for node in tree.nodes:
                if node.type == "BSDF_PRINCIPLED":
                    value = node.inputs["Base Color"].default_value
                    return (float(value[0]), float(value[1]), float(value[2]))
        for name in ("diffuse_color", "color"):
            value = getattr(idblock, name, None)
            if value is not None and len(value) >= 3:
                return (float(value[0]), float(value[1]), float(value[2]))
    except Exception:  # noqa: BLE001 - a swatch is never worth an error
        pass
    return (0.6, 0.6, 0.6)


def paint_preview(idblock, *, force: bool = False) -> bool:
    """Mark both preview sizes of ``idblock`` user-edited with a swatch. True when painted."""
    rgb = id_colour(idblock)
    pointer = idblock.as_pointer()
    preview = idblock.preview
    if (not force and preview is not None and preview.is_icon_custom and preview.is_image_custom
            and _painted.get(pointer) == rgb):
        return False
    preview = idblock.preview_ensure()
    for size, size_attr, pixels_attr in ((ICON_SIZE, "icon_size", "icon_pixels_float"),
                                         (IMAGE_SIZE, "image_size", "image_pixels_float")):
        if tuple(getattr(preview, size_attr)) != (size, size):
            setattr(preview, size_attr, (size, size))   # also sets PRV_USER_EDITED
        getattr(preview, pixels_attr).foreach_set(swatch_pixels(size, rgb))
    _painted[pointer] = rgb
    return True


def guard_previews() -> int:
    painted = 0
    for collection in COLLECTIONS:
        for idblock in getattr(bpy.data, collection, ()):
            if idblock.library is not None:
                continue  # linked: Blender already skips its preview render
            try:
                painted += paint_preview(idblock)
            except Exception as exc:  # noqa: BLE001 - keep guarding the rest
                _log("preview guard skipped", repr(idblock.name), type(exc).__name__)
    return painted


def _preview_note_draw(self, _context) -> None:
    self.layout.label(text=PREVIEW_NOTE, icon="INFO")


def guard_preview_panels() -> list:
    """Replace the draw of every Properties "Preview" panel that would start a preview render."""
    patched = []
    for cls in _panel_classes():
        if (getattr(cls, "bl_space_type", "") == "PROPERTIES" and getattr(cls, "bl_label", "") == "Preview"
                and getattr(cls, "draw", None) is not _preview_note_draw):
            cls.draw = _preview_note_draw
            patched.append(cls.__name__)
    return patched


def _panel_classes():
    seen, stack = set(), list(bpy.types.Panel.__subclasses__())
    while stack:
        cls = stack.pop()
        if cls in seen:
            continue
        seen.add(cls)
        stack.extend(cls.__subclasses__())
        yield cls


@persistent
def _on_load_post(*_args) -> None:
    _painted.clear()
    _guard("load")


@persistent
def _on_depsgraph_update_post(*_args) -> None:
    # New materials (the Material tab's New button, a script, an append) and
    # colour edits: repaint before the next interface draw asks for a preview.
    guard_previews()


@persistent
def _on_undo_redo(*_args) -> None:
    # Undo restores IDs from memory, previews included; guard them again
    # before the interface draws.
    guard_previews()


def _guard(reason: str) -> None:
    try:
        panels = guard_preview_panels()
        painted = guard_previews()
        _log("preview guard on", reason, "painted", painted, "panels", ",".join(sorted(panels)) or "-")
    except Exception as exc:  # noqa: BLE001 - never stop the session over a guard
        _log("preview guard failed", type(exc).__name__, exc)


def install() -> None:
    handlers = bpy.app.handlers
    for name, function in (("load_post", _on_load_post), ("depsgraph_update_post", _on_depsgraph_update_post),
                           ("undo_post", _on_undo_redo), ("redo_post", _on_undo_redo)):
        chain = getattr(handlers, name)
        if not any(getattr(item, "__name__", "") == function.__name__ for item in chain):
            chain.append(function)
    _guard("start")


if bpy is not None and __name__ == "__main__":
    install()
