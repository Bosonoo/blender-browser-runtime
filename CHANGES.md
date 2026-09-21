# Distributed modifications

## 2026-09-21 — Blender 5.3 alpha browser runtime

- Added a fixed-path native save adapter and native dirty-state reporting.
  Serialization runs in Blender's event loop and waits for modal operations.
- Added debounced automatic saving, save-receipt reconciliation and recovery
  handling in the browser bridge.
- Stopped automatic saving when the active native document changes unexpectedly.
- Assigned canvas resizing to the native render thread after OffscreenCanvas
  transfer and guarded the frontend against invalid canvas-size writes.
- Replaced WebGPU workbench curvature integer-object-ID texture sampling with
  bounded texel reads.
- Added broker-ready reporting, bounded project hydration and isolated engine
  workspace lifecycle handling.

## 2026-09-20 — browser rebuild corrections

- Namespaced two bundled CPython Expat symbols to avoid duplicate linkage.
- Selected the source-built native Python interpreter for host code generation.
- Linked the pinned WebGPU port, Brotli and source-built SQLite/bzip2 with
  undefined-symbol failures enabled.
- Rebuilt the embedded decoder from retained zstd 1.5.6 source.
- Recorded an empty optional shader-cache seed with native compilation on misses.

## 2026-09-21 — standalone source repository

- Published the Blender-side adapter and native changes with a fresh Git history.
- Extracted the Blender-specific adapter generator and verified that it produces
  the same four adapter files as the distributed pack.
- Mirrored the complete native corresponding-source archive without modifying
  its bytes. No new runtime binary or host application deployment was made.
