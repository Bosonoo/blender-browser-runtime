"""Fix the pinned WebGPU curvature pass's unsupported integer texture sampling.

Applied only to candidate Blender sources, never a published source archive.
The four object-id reads retain nearest/clamp-to-edge sampling semantics. Other
backends, floating-point normals, and the curvature lighting calculation stay
unchanged. The bundled Tint rejects textureSample(texture_2d<u32>, ...); explicit
texelFetch becomes the supported WGSL textureLoad operation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

SOURCE_PATH = "blender/source/blender/draw/engines/workbench/shaders/workbench_curvature.bsl.hh"
SOURCE_SHA256 = "d1578c991113ae235e66d722b45e804815a9e6f09f655ab7c96aca4364de06c1"

ORIGINAL = """  uint object_up = texture(object_id_tx, uv + offset.zy).r;
  uint object_down = texture(object_id_tx, uv - offset.zy).r;
  uint object_right = texture(object_id_tx, uv + offset.xz).r;
  uint object_left = texture(object_id_tx, uv - offset.xz).r;"""

REPLACEMENT = """#ifdef GPU_WEBGPU
  /* Integer textures cannot use WGSL textureSample. Preserve nearest sampling
   * and clamp-to-edge using exact integer texel loads instead. */
  int2 id_extent = textureSize(object_id_tx, 0);
  int2 id_max = id_extent - int2(1);
  uint object_up = texelFetch(
      object_id_tx, clamp(int2((uv + offset.zy) * float2(id_extent)), int2(0), id_max), 0).r;
  uint object_down = texelFetch(
      object_id_tx, clamp(int2((uv - offset.zy) * float2(id_extent)), int2(0), id_max), 0).r;
  uint object_right = texelFetch(
      object_id_tx, clamp(int2((uv + offset.xz) * float2(id_extent)), int2(0), id_max), 0).r;
  uint object_left = texelFetch(
      object_id_tx, clamp(int2((uv - offset.xz) * float2(id_extent)), int2(0), id_max), 0).r;
#else
""" + ORIGINAL + "\n#endif"


def patch_source(source: str) -> str:
    if REPLACEMENT in source or source.count(ORIGINAL) != 1:
        raise ValueError("Curvature shader source anchor drift")
    return source.replace(ORIGINAL, REPLACEMENT, 1)


def apply(root: Path) -> dict:
    path = root / SOURCE_PATH
    original = path.read_bytes()
    before = hashlib.sha256(original).hexdigest()
    if before != SOURCE_SHA256:
        raise ValueError("Pinned curvature shader input mismatch")
    result = patch_source(original.decode("utf-8")).encode("utf-8")
    path.write_bytes(result)
    return {"path": SOURCE_PATH, "before": before, "after": hashlib.sha256(result).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    print(json.dumps(apply(args.root), indent=2))
