# SPDX-License-Identifier: GPL-3.0-or-later
"""Fixed, bounded Blender mailbox. No Python, RNA path or operator from a caller.

This trusted pack script is passed explicitly with --python after
--disable-autoexec. Uploaded .blend handlers and text blocks stay disabled.
All commands run on Blender's main thread; project persistence remains the
existing native autosave/snapshot receipt path.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import struct

ROOT = "/bosonoo/automation"
# The browser runtime's file layer keeps the bytes it already read from a path, so a
# rewritten request file came back as old-prefix + new-suffix and every command after
# the first was lost. In the browser the bridge therefore writes request N once to
# in-N.json (in memory) and the answer goes to a new out-N.json; no path is reused.
LIVE_ROOT = "/tmp/bosonoo-automation"
MAX_REQUEST_BYTES = 48 * 1024
MAX_OBJECTS = 2000
MAX_EXPORT_BYTES = 8 * 1024 * 1024
MAX_EXPORT_OBJECTS = 64
MAX_EMISSION_STRENGTH = 100
PRIMITIVES = ("cube", "plane", "uv_sphere", "cylinder", "cone", "torus", "ico_sphere")
_NAME = re.compile(r"^[^\x00-\x1f/\\]{1,80}$")
_KEY = re.compile(r"^[A-Za-z0-9_-]{1,96}$")
_revision = 1
_busy = False
_completed = {}
_last_input = None
_live_seq = 1


def _fields(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise ValueError("Unsupported or missing command field")
    return value


def _name(value):
    if not isinstance(value, str) or not _NAME.fullmatch(value) or value.strip() != value:
        raise ValueError("Use a plain, bounded object name")
    return value


def _vector(value, size=3, *, minimum=-10000, maximum=10000):
    if not isinstance(value, list) or len(value) != size or any(
        type(x) not in (int, float) or not math.isfinite(x) or not minimum <= x <= maximum for x in value
    ):
        raise ValueError("Use bounded finite numeric vectors")
    return tuple(float(x) for x in value)


def validate(operation, args):
    if operation in {"blender.scene.inspect", "blender.project.save"}:
        _fields(args, ())
        return args
    if operation == "blender.scene.edit":
        _fields(args, ("expected_scene_revision", "operations"), ("expected_scene_revision", "operations"))
        ops = args["operations"]
        if not isinstance(ops, list) or not 1 <= len(ops) <= 32:
            raise ValueError("Use between one and 32 edits")
        for op in ops:
            if not isinstance(op, dict):
                raise ValueError("Each edit must be an object")
            kind = op.get("kind")
            if kind == "create_mesh":
                _fields(op, ("kind", "name", "primitive", "location", "rotation", "scale", "color"), ("kind", "name", "primitive"))
                _name(op["name"])
                if op["primitive"] not in PRIMITIVES:
                    raise ValueError("Unsupported primitive")
            elif kind == "set_transform":
                _fields(op, ("kind", "object_name", "location", "rotation", "scale"), ("kind", "object_name"))
                _name(op["object_name"])
                if not any(key in op for key in ("location", "rotation", "scale")):
                    raise ValueError("Supply a transform")
            elif kind == "set_material":
                _fields(op, ("kind", "object_name", "color", "roughness", "metallic", "emission_color", "emission_strength"),
                        ("kind", "object_name", "color"))
                _name(op["object_name"])
                for key in ("roughness", "metallic"):
                    if key in op:
                        _vector([op[key]], 1, minimum=0, maximum=1)
                if ("emission_color" in op) != ("emission_strength" in op):
                    raise ValueError("Supply emission_color and emission_strength together")
                if "emission_color" in op:
                    _vector(op["emission_color"], 4, minimum=0, maximum=1)
                    _vector([op["emission_strength"]], 1, minimum=0, maximum=MAX_EMISSION_STRENGTH)
            elif kind == "delete_object":
                _fields(op, ("kind", "object_name"), ("kind", "object_name"))
                _name(op["object_name"])
            elif kind == "set_parent":
                # A null or absent parent clears it; both directions keep the world transform.
                _fields(op, ("kind", "object_name", "parent"), ("kind", "object_name"))
                _name(op["object_name"])
                if op.get("parent") is not None and _name(op["parent"]) == op["object_name"]:
                    raise ValueError("An object cannot be its own parent")
            elif kind == "set_shading":
                _fields(op, ("kind", "object_name", "shading"), ("kind", "object_name", "shading"))
                _name(op["object_name"])
                if op["shading"] not in ("smooth", "flat"):
                    raise ValueError("Use smooth or flat shading")
            else:
                raise ValueError("Unsupported edit kind")
            for key in ("location", "rotation", "scale"):
                if key in op:
                    _vector(op[key])
                    if key == "scale" and any(abs(x) < 0.0001 for x in op[key]):
                        raise ValueError("Scale must be nonzero")
            if "color" in op:
                _vector(op["color"], 4, minimum=0, maximum=1)
    elif operation == "blender.image.import":
        _fields(args, ("expected_scene_revision", "asset_key", "sha256", "name", "object_name"),
                ("expected_scene_revision", "asset_key", "sha256", "name"))
        if not isinstance(args["asset_key"], str) or not _KEY.fullmatch(args["asset_key"]):
            raise ValueError("Invalid staged asset")
        if not isinstance(args["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", args["sha256"]):
            raise ValueError("Invalid asset digest")
        _name(args["name"])
        if "object_name" in args:
            _name(args["object_name"])
    elif operation == "blender.scene.export_glb":
        _fields(args, ("expected_scene_revision", "name", "objects"), ("expected_scene_revision", "name"))
        _name(args["name"])
        if "objects" in args and (not isinstance(args["objects"], list) or not 1 <= len(args["objects"]) <= MAX_EXPORT_OBJECTS
                                  or len(set(map(_name, args["objects"]))) != len(args["objects"])):
            raise ValueError("Export between one and 64 distinct object names")
    else:
        raise ValueError("Unsupported Blender operation")
    if type(args.get("expected_scene_revision")) is not int or args["expected_scene_revision"] < 1:
        raise ValueError("A current scene revision is required")
    return args


def _mesh(primitive):
    if primitive == "cube":
        return ([(x, y, z) for z in (-1, 1) for y in (-1, 1) for x in (-1, 1)],
                [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)])
    if primitive == "plane":
        return [(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [(0, 1, 2, 3)]
    sides = 24
    ring = [(math.cos(i * math.tau / sides), math.sin(i * math.tau / sides)) for i in range(sides)]
    if primitive in {"cylinder", "cone"}:
        verts = [(x, y, -1) for x, y in ring]
        faces = [tuple(reversed(range(sides)))]
        if primitive == "cone":
            verts.append((0, 0, 1))
            faces += [(i, (i + 1) % sides, sides) for i in range(sides)]
        else:
            verts += [(x, y, 1) for x, y in ring]
            faces += [tuple(range(sides, sides * 2))]
            faces += [(i, (i + 1) % sides, (i + 1) % sides + sides, i + sides) for i in range(sides)]
        return verts, faces
    if primitive == "torus":
        # Ring radius 0.75 and tube radius 0.25 keep the shared unit-box UV projection.
        tube = [(math.cos(j * math.tau / 12), math.sin(j * math.tau / 12)) for j in range(12)]
        verts = [((0.75 + 0.25 * c) * x, (0.75 + 0.25 * c) * y, 0.25 * s) for x, y in ring for c, s in tube]
        return verts, [(i * 12 + j, (i + 1) % sides * 12 + j, (i + 1) % sides * 12 + (j + 1) % 12, i * 12 + (j + 1) % 12)
                       for i in range(sides) for j in range(12)]
    if primitive == "ico_sphere":
        # Blender's default two subdivisions of a unit icosahedron: 162 vertices, 320 faces.
        t = (1 + math.sqrt(5)) / 2
        verts = [tuple(c / math.hypot(*p) for c in p) for p in ((-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t),
                 (0, 1, t), (0, -1, -t), (0, 1, -t), (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1))]
        faces = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
                 (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
        for _level in range(2):
            middle, refined = {}, []
            for a, b, c in faces:
                m = []
                for p, q in ((a, b), (b, c), (c, a)):
                    if (min(p, q), max(p, q)) not in middle:
                        mid = [(u + v) / 2 for u, v in zip(verts[p], verts[q])]
                        middle[min(p, q), max(p, q)] = len(verts)
                        verts.append(tuple(x / math.hypot(*mid) for x in mid))
                    m.append(middle[min(p, q), max(p, q)])
                refined += [(a, m[0], m[2]), (b, m[1], m[0]), (c, m[2], m[1]), tuple(m)]
            faces = refined
        return verts, faces
    verts = [(0, 0, 1)]
    for r in range(1, 12):
        a = math.pi * r / 12
        verts += [(math.sin(a) * x, math.sin(a) * y, math.cos(a)) for x, y in ring]
    bottom = len(verts)
    verts.append((0, 0, -1))
    faces = [(0, 1 + i, 1 + (i + 1) % sides) for i in range(sides)]
    for r in range(10):
        first = 1 + r * sides
        faces += [(first + i, first + sides + i, first + sides + (i + 1) % sides, first + (i + 1) % sides) for i in range(sides)]
    last = 1 + 10 * sides
    faces += [(bottom, last + (i + 1) % sides, last + i) for i in range(sides)]
    return verts, faces


def _object(bpy, name):
    obj = bpy.context.scene.objects.get(name)
    if obj is None or obj.library or obj.override_library or obj.type != "MESH" or obj.data.library or obj.data.users != 1:
        raise ValueError("The named object must be a local, unshared mesh in this scene")
    return obj


def _material(bpy, name, color, image=None, roughness=0.6, metallic=0.0, emission=None):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = color
    shader = next((node for node in material.node_tree.nodes if node.bl_idname == "ShaderNodeBsdfPrincipled"), None)
    needed = ("Base Color", "Roughness", "Metallic") + (("Emission Color", "Emission Strength") if emission else ())
    if shader is None or any(shader.inputs.get(key) is None for key in needed):
        bpy.data.materials.remove(material)
        raise RuntimeError("This Blender material schema is unsupported")
    shader.inputs["Base Color"].default_value = color
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    if emission:
        shader.inputs["Emission Color"].default_value, shader.inputs["Emission Strength"].default_value = emission
    if image is not None:
        texture = material.node_tree.nodes.new("ShaderNodeTexImage")
        texture.image = image
        material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    return material


def _snapshot(obj, kind=None):
    # Everything an edit may change on an existing object, restored exactly on failure.
    state = {"obj": obj, "pointer": obj.as_pointer(),
             "parent": (obj.parent, obj.parent_type, obj.matrix_parent_inverse.copy()) if kind == "set_parent" else None,
             "transform": (obj.location.copy(), obj.rotation_euler.copy(), obj.rotation_quaternion.copy(),
                           tuple(obj.rotation_axis_angle), obj.scale.copy()),
             "materials": list(obj.data.materials), "smooth": None,
             "collections": list(obj.users_collection) if kind == "delete_object" else []}
    if kind == "set_shading":
        state["smooth"] = [False] * len(obj.data.polygons)
        obj.data.polygons.foreach_get("use_smooth", state["smooth"])
    return state


def _restore(state):
    obj = state["obj"]
    for collection in state["collections"]:
        if obj.name not in collection.objects:
            collection.objects.link(obj)
    if state["parent"] is not None:
        # Blender resets the parent inverse when the parent is assigned, so restore it last.
        obj.parent = state["parent"][0]
        obj.parent_type, obj.matrix_parent_inverse = state["parent"][1:]
    obj.location, obj.rotation_euler, obj.rotation_quaternion, obj.rotation_axis_angle, obj.scale = state["transform"]
    obj.data.materials.clear()
    for material in state["materials"]:
        obj.data.materials.append(material)
    if state["smooth"] is not None:
        obj.data.polygons.foreach_set("use_smooth", state["smooth"])
        obj.data.update()


def _parent(bpy, obj, parent):
    seen, ancestor = set(), parent
    while ancestor is not None and ancestor not in seen:
        if ancestor == obj:
            raise ValueError("That parent would create a parenting loop")
        seen.add(ancestor)
        ancestor = ancestor.parent
    from mathutils import Matrix
    # Evaluate earlier edits in this request so the world matrix is current.
    bpy.context.view_layer.update()
    world = obj.matrix_world.copy()
    obj.parent_type = "OBJECT"
    obj.parent = parent
    obj.matrix_parent_inverse = Matrix.Identity(4)
    # Local values stay meaningful: the child's transform becomes relative to its parent.
    obj.matrix_world = world


def inspect(bpy):
    objects = list(bpy.context.scene.objects)
    return {"scene_revision": _revision, "coverage_status": "partial" if len(objects) > 100 else "complete",
            "object_count": len(objects), "objects": [{"name": obj.name, "type": obj.type,
            "parent": obj.parent.name if obj.parent else None,
            "location": list(obj.location), "rotation": list(obj.rotation_euler), "scale": list(obj.scale),
            "vertices": len(obj.data.vertices) if obj.type == "MESH" else None,
            "editable": not bool(obj.library or obj.override_library or (obj.type == "MESH" and (obj.data.library or obj.data.users != 1)))}
            for obj in objects[:100]]}


def _gltf_without_ctypes():
    # The browser build's Python has no _ctypes, yet the glTF exporter imports its
    # Draco module (ctypes only at compression time; compression stays off) on load.
    try:
        import ctypes  # noqa: F401
    except ImportError:
        import sys
        import types
        sys.modules.setdefault("ctypes", types.ModuleType("ctypes"))


def _native_gltf():
    # Blender's own glTF exporter needs numpy, which the browser build's Python also lacks.
    try:
        import numpy  # noqa: F401
    except ImportError:
        return False
    return True


# glTF is Y-up: glTF axis i = sign * Blender axis, i.e. (x, y, z) -> (x, z, -y) for points and
# normals, and C @ M @ C^-1 for node matrices, so C(M p) == G (C p) for every point p.
_AXES = ((0, 1), (2, 1), (1, -1), (3, 1))
_IDENTITY = [float(r == c) for c in range(4) for r in range(4)]
_LIMIT = "GLB export unavailable or exceeds the output limit"


def _y_up(matrix):
    # Column-major, as glTF stores node matrices.
    return [si * sj * matrix[pi][pj] for pj, sj in _AXES for pi, si in _AXES]


def _view(gltf, blob, data, target=None):
    blob.extend(bytes(-len(blob) % 4))
    if len(blob) + len(data) > MAX_EXPORT_BYTES:
        raise RuntimeError(_LIMIT)
    gltf.setdefault("bufferViews", []).append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data), **({"target": target} if target else {})})
    blob.extend(data)
    return len(gltf["bufferViews"]) - 1


def _accessor(gltf, blob, values, kind, target, code="f", bounds=False):
    width, raw = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[kind], struct.pack(f"<{len(values)}{code}", *values)
    item = {"bufferView": _view(gltf, blob, raw, target), "componentType": 5126 if code == "f" else 5125, "count": len(values) // width, "type": kind}
    if bounds:
        # min/max describe the stored float32 values exactly.
        stored = struct.unpack(f"<{len(values)}{code}", raw)
        item["min"], item["max"] = ([pick(stored[i::width]) for i in range(width)] for pick in (min, max))
    gltf.setdefault("accessors", []).append(item)
    return len(gltf["accessors"]) - 1


def _glb(gltf, blob):
    # 12-byte header, a space-padded JSON chunk, then a zero-padded BIN chunk when there is data.
    if blob:
        gltf["buffers"] = [{"byteLength": len(blob)}]
    text = json.dumps(gltf, separators=(",", ":"), allow_nan=False).encode()
    body = struct.pack("<II", len(text) + -len(text) % 4, 0x4E4F534A) + text + b" " * (-len(text) % 4)
    if blob:
        body += struct.pack("<II", len(blob) + -len(blob) % 4, 0x004E4942) + bytes(blob) + bytes(-len(blob) % 4)
    return struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body


def _pbr(gltf, blob, material, cache):
    if ("material", material) in cache:
        return cache["material", material]
    tree = material.node_tree
    shader = next((node for node in tree.nodes if node.bl_idname == "ShaderNodeBsdfPrincipled"), None) if tree else None
    inputs = shader.inputs if shader else {}

    def value(key, default):
        socket = inputs.get(key)
        return socket.default_value if socket is not None else default

    def unit(x):
        return min(1.0, max(0.0, float(x)))

    alpha = unit(value("Alpha", material.diffuse_color[3]))
    pbr = {"baseColorFactor": [unit(c) for c in tuple(value("Base Color", material.diffuse_color))[:3]] + [alpha],
           "metallicFactor": unit(value("Metallic", material.metallic)), "roughnessFactor": unit(value("Roughness", material.roughness))}
    out = {"name": material.name, "pbrMetallicRoughness": pbr, "doubleSided": not material.use_backface_culling}
    if alpha < 1:
        out["alphaMode"] = "BLEND"
    base = inputs.get("Base Color")
    link = next((link for link in base.links if not link.is_muted), None) if base is not None else None
    image = link.from_node.image if link and link.from_node.bl_idname == "ShaderNodeTexImage" else None
    # Only image bytes packed in the .blend are embedded; an external file is never referenced.
    raw = bytes(image.packed_file.data) if image is not None and image.packed_file else b""
    mime = "image/png" if raw.startswith(b"\x89PNG\r\n\x1a\n") else "image/jpeg" if raw.startswith(b"\xff\xd8\xff") else None
    if mime:
        if ("texture", image) not in cache:
            gltf.setdefault("samplers", [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}])
            gltf.setdefault("images", []).append({"name": image.name, "mimeType": mime, "bufferView": _view(gltf, blob, raw)})
            gltf.setdefault("textures", []).append({"sampler": 0, "source": len(gltf["images"]) - 1})
            cache["texture", image] = len(gltf["textures"]) - 1
        pbr["baseColorTexture"], pbr["baseColorFactor"] = {"index": cache["texture", image], "texCoord": 0}, [1.0, 1.0, 1.0, alpha]
    strength, glow = max(0.0, float(value("Emission Strength", 0))), [unit(c) for c in tuple(value("Emission Color", (0, 0, 0)))[:3]]
    if strength > 0 and max(glow) > 0:
        out["emissiveFactor"] = [c * min(strength, 1.0) for c in glow]
        if strength > 1:
            out["extensions"] = {"KHR_materials_emissive_strength": {"emissiveStrength": strength}}
            gltf["extensionsUsed"] = ["KHR_materials_emissive_strength"]
    gltf.setdefault("materials", []).append(out)
    cache["material", material] = len(gltf["materials"]) - 1
    return cache["material", material]


def _primitives(gltf, blob, obj, evaluated, cache):
    mesh = evaluated.to_mesh()
    try:
        mesh.calc_loop_triangles()
        tris, corners, layer = mesh.loop_triangles, mesh.loops, mesh.uv_layers.active
        # Every triangle costs at least its three 4-byte indices; refuse before copying a huge mesh.
        if len(blob) + 12 * len(tris) > MAX_EXPORT_BYTES:
            raise RuntimeError(_LIMIT)
        loops, slots, vertex = [0] * (3 * len(tris)), [0] * len(tris), [0] * len(corners)
        co, normal, uv = [0.0] * (3 * len(mesh.vertices)), [0.0] * (3 * len(corners)), [0.0] * (2 * len(corners)) if layer else None
        tris.foreach_get("loops", loops)
        tris.foreach_get("material_index", slots)
        corners.foreach_get("vertex_index", vertex)
        mesh.vertices.foreach_get("co", co)
        # Corner (split) normals already follow flat, smooth and sharp-edge shading.
        mesh.corner_normals.foreach_get("vector", normal)
        if layer:
            layer.data.foreach_get("uv", uv)
    finally:
        evaluated.to_mesh_clear()
    groups = {}
    for t, slot in enumerate(slots):
        seen, order = groups.setdefault(slot, ({}, []))
        for c in loops[3 * t:3 * t + 3]:
            v, (x, y, z) = 3 * vertex[c], normal[3 * c:3 * c + 3]
            length = math.sqrt(x * x + y * y + z * z)
            x, y, z = (x / length, y / length, z / length) if length > 1e-12 else (0.0, 0.0, 1.0)
            # One vertex per distinct corner; glTF texture space starts at the top (v' = 1 - v).
            key = (co[v], co[v + 2], -co[v + 1], x, z, -y) + ((uv[2 * c], 1 - uv[2 * c + 1]) if uv else ())
            order.append(seen.setdefault(key, len(seen)))
    primitives = []
    for slot, (seen, order) in sorted(groups.items()):
        keys = list(seen)
        attributes = {"POSITION": _accessor(gltf, blob, [x for key in keys for x in key[:3]], "VEC3", 34962, bounds=True),
                      "NORMAL": _accessor(gltf, blob, [x for key in keys for x in key[3:6]], "VEC3", 34962)}
        if uv:
            attributes["TEXCOORD_0"] = _accessor(gltf, blob, [x for key in keys for x in key[6:]], "VEC2", 34962)
        primitive = {"attributes": attributes, "indices": _accessor(gltf, blob, order, "SCALAR", 34963, "I")}
        material = obj.material_slots[slot].material if slot < len(obj.material_slots) else None
        if material is not None:
            primitive["material"] = _pbr(gltf, blob, material, cache)
        primitives.append(primitive)
    return primitives


def _write_glb(bpy, objects, path):
    """Pure-Python GLB 2.0 writer for Pythons without numpy, where Blender's exporter cannot load.

    Mesh objects only (no cameras, lights, animation, skins, morph targets or instances): evaluated
    triangles, corner normals, the active UV map and one primitive per used material slot; each
    material's first Principled BSDF factors, emission and a packed PNG/JPEG base colour image.
    """
    graph = bpy.context.evaluated_depsgraph_get()
    meshes = [obj for obj in objects if obj.type == "MESH"]
    index = {obj: i for i, obj in enumerate(meshes)}
    gltf, blob, cache, children, nodes = {"asset": {"version": "2.0", "generator": "Bosonoo Blender adapter"}, "scene": 0}, bytearray(), {}, {}, []
    for obj in meshes:
        if obj.parent in index:
            children.setdefault(obj.parent, []).append(index[obj])
    for obj in meshes:
        evaluated = obj.evaluated_get(graph)
        matrix = evaluated.matrix_world
        if obj.parent in index:
            # A child keeps its place relative to an exported parent; any other object is a root at its world matrix.
            matrix = obj.parent.evaluated_get(graph).matrix_world.inverted_safe() @ matrix
        node, flat = {"name": obj.name}, _y_up(matrix)
        if flat != _IDENTITY:
            node["matrix"] = flat
        if obj in children:
            node["children"] = children[obj]
        primitives = _primitives(gltf, blob, obj, evaluated, cache)
        if primitives:
            node["mesh"] = len(gltf.setdefault("meshes", []))
            gltf["meshes"].append({"name": obj.data.name, "primitives": primitives})
        nodes.append(node)
    roots = [index[obj] for obj in meshes if obj.parent not in index]
    gltf["scenes"] = [{"nodes": roots} if roots else {}]
    if nodes:
        gltf["nodes"] = nodes
    data = _glb(gltf, blob)
    if len(data) > MAX_EXPORT_BYTES:
        raise RuntimeError(_LIMIT)
    with open(path, "wb") as handle:
        handle.write(data)


def _export(bpy, args, command_id):
    global _busy
    layer = bpy.context.view_layer
    chosen = [layer.objects.get(name) for name in args.get("objects", ())]
    if None in chosen:
        raise ValueError("Every exported object must be in the current view layer")
    selected, active = {obj for obj in layer.objects if obj.select_get()}, layer.objects.active
    export_path = f"{ROOT}/outputs/{command_id}.glb"
    os.makedirs(f"{ROOT}/outputs", exist_ok=True)
    try:
        # Selection is transient view state: it is restored below and never
        # counts as a scene edit, so the caller's scene revision stays current.
        _busy = True
        if chosen:
            for obj in layer.objects:
                obj.select_set(obj in chosen)
            if not all(obj.select_get() for obj in chosen):
                raise ValueError("A named object is hidden or cannot be selected for export")
        result = None
        if _native_gltf():
            _gltf_without_ctypes()
            try:
                result = bpy.ops.export_scene.gltf(filepath=export_path, check_existing=False, export_format="GLB", use_selection=bool(chosen),
                    use_active_scene=True, export_animations=False, export_cameras=False, export_extras=False, export_lights=False)
            except Exception as error:
                # Only an exporter that cannot import its modules falls back; any other failure stays a failure.
                if not isinstance(error, ImportError) and not re.search(r"\b(ImportError|ModuleNotFoundError)\b", str(error)):
                    raise
        if result is None:
            _write_glb(bpy, chosen or list(layer.objects), export_path)
            result = {"FINISHED"}
    finally:
        if chosen:
            for obj in layer.objects:
                obj.select_set(obj in selected)
            layer.objects.active = active
        layer.update()
        _busy = False
    if "FINISHED" not in result or not 0 < os.path.getsize(export_path) <= MAX_EXPORT_BYTES:
        raise RuntimeError("GLB export unavailable or exceeds the output limit")
    with open(export_path, "rb") as handle:
        payload = handle.read(MAX_EXPORT_BYTES + 1)
    return {"scene_revision": _revision, "output": {"key": command_id, "mime": "model/gltf-binary",
        "name": args["name"].removesuffix(".glb") + ".glb", "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()},
        **({"exported_objects": [obj.name for obj in chosen]} if chosen else {})}


def execute(bpy, operation, args, command_id):
    global _revision, _busy
    validate(operation, args)
    if operation == "blender.scene.inspect":
        return inspect(bpy)
    if operation == "blender.project.save":
        # JS asks the native serializer and resolves only after a Library receipt.
        return {"execution": "native_save_required", "scene_revision": _revision}
    if args["expected_scene_revision"] != _revision:
        raise ValueError("SCENE_REVISION_CONFLICT: inspect the current scene before editing")
    if bpy.context.mode != "OBJECT":
        raise ValueError("Return Blender to Object Mode before requesting this operation")
    if operation == "blender.scene.export_glb":
        return _export(bpy, args, command_id)
    # A delete cannot be undone once its data is removed, so refuse before any
    # mutation when Blender could not record the undo boundary below.
    if not bpy.ops.ed.undo_push.poll():
        raise RuntimeError("Blender could not record this edit for saving")
    created_objects, created_meshes, materials, backups, imported, doomed, removed, deleted_names = [], [], [], [], None, [], set(), []
    try:
        _busy = True
        if operation == "blender.scene.edit":
            # Later edits may name objects created earlier in this request. Every name
            # stays reserved for the whole request, so nothing is silently renamed;
            # a delete frees its scene-cap slot.
            scene_names = set(bpy.context.scene.objects.keys())
            taken, live, created, deleted = scene_names | set(bpy.data.objects.keys()), len(scene_names), set(), set()
            for op in args["operations"]:
                if op["kind"] == "create_mesh":
                    if op["name"] in taken or live >= MAX_OBJECTS:
                        raise ValueError("Object name already exists or scene object limit reached")
                    taken.add(op["name"])
                    created.add(op["name"])
                    live += 1
                    continue
                if op["kind"] == "delete_object" and op["object_name"] in created:
                    raise ValueError("Do not create and delete the same object in one request")
                for name in filter(None, (op["object_name"], op.get("parent"))):
                    if name in deleted:
                        raise ValueError("An edit names an object deleted earlier in this request")
                    if name not in created:
                        _object(bpy, name)
                if op["kind"] == "delete_object":
                    deleted.add(op["object_name"])
                    live -= 1
            for op in args["operations"]:
                if op["kind"] == "create_mesh":
                    mesh = bpy.data.meshes.new(op["name"])
                    created_meshes.append(mesh)
                    verts, faces = _mesh(op["primitive"])
                    mesh.from_pydata(verts, [], faces)
                    mesh.update()
                    # A deterministic primitive UV map makes imported artwork useful.
                    uv = mesh.uv_layers.new(name="UVMap")
                    for polygon in mesh.polygons:
                        for index in polygon.loop_indices:
                            co = mesh.vertices[mesh.loops[index].vertex_index].co
                            uv.data[index].uv = ((co.x + 1) / 2, (co.y + 1) / 2)
                    obj = bpy.data.objects.new(op["name"], mesh)
                    created_objects.append(obj)
                    bpy.context.scene.collection.objects.link(obj)
                else:
                    obj = _object(bpy, op["object_name"])
                    backups.append(_snapshot(obj, op["kind"]))
                    if op["kind"] == "set_parent":
                        _parent(bpy, obj, _object(bpy, op["parent"]) if op.get("parent") is not None else None)
                    elif op["kind"] == "set_shading":
                        obj.data.polygons.foreach_set("use_smooth", [op["shading"] == "smooth"] * len(obj.data.polygons))
                        obj.data.update()
                    elif op["kind"] == "delete_object":
                        if len(obj.users_scene) != 1:
                            raise ValueError("The named object is also used by another scene")
                        if any(child not in doomed for child in obj.children):
                            raise ValueError("Delete or unparent this object's children first")
                        # Unlinked now and removed only after every edit succeeds, so rollback can relink it.
                        for collection in list(obj.users_collection):
                            collection.objects.unlink(obj)
                        doomed.append(obj)
                for key, attribute in (("location", "location"), ("rotation", "rotation_euler"), ("scale", "scale")):
                    if key in op:
                        setattr(obj, attribute, _vector(op[key]))
                if "color" in op:
                    emission = ((_vector(op["emission_color"], 4, minimum=0, maximum=1), float(op["emission_strength"]))
                                if "emission_color" in op else None)
                    material = _material(bpy, obj.name + " Material", _vector(op["color"], 4, minimum=0, maximum=1),
                                         roughness=float(op.get("roughness", 0.6)), metallic=float(op.get("metallic", 0)), emission=emission)
                    materials.append(material)
                    obj.data.materials.clear()
                    obj.data.materials.append(material)
            deleted_names = [obj.name for obj in doomed]
            for obj in doomed:
                pointer, mesh = obj.as_pointer(), obj.data
                bpy.data.objects.remove(obj, do_unlink=True)
                removed.add(pointer)
                if mesh.users == 0:
                    bpy.data.meshes.remove(mesh)
        else:
            target = _object(bpy, args["object_name"]) if "object_name" in args else None
            asset_path = f"{ROOT}/assets/{args['asset_key']}.png"
            with open(asset_path, "rb") as handle:
                raw = handle.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024 or not raw.startswith(b"\x89PNG\r\n\x1a\n") or hashlib.sha256(raw).hexdigest() != args["sha256"]:
                raise ValueError("Staged PNG does not match the approved asset")
            imported = bpy.data.images.load(asset_path, check_existing=False)
            imported.name = args["name"]
            imported.pack()
            if target is not None:
                backups.append(_snapshot(target))
                material = _material(bpy, args["name"] + " Material", (1, 1, 1, 1), imported)
                materials.append(material)
                target.data.materials.clear()
                target.data.materials.append(material)
        bpy.context.view_layer.update()
        # Direct bpy data edits do not mark Main dirty. A fixed editor undo
        # boundary records the user's recoverable change and triggers Blender's
        # native dirty state, which the existing autosave adapter observes.
        if "FINISHED" not in bpy.ops.ed.undo_push(message="Bosonoo AI edit"):
            raise RuntimeError("Blender could not record this edit for saving")
        _revision += 1
        return {"scene_revision": _revision, "changed": True, "created_objects": [obj.name for obj in created_objects],
                "deleted_objects": deleted_names, "image": imported.name if imported is not None else None,
                "persistence": "pending_native_save"}
    except Exception:
        for state in reversed(backups):
            if state["pointer"] not in removed:
                _restore(state)
        for obj in reversed(created_objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        for mesh in reversed(created_meshes):
            bpy.data.meshes.remove(mesh)
        for material in reversed(materials):
            bpy.data.materials.remove(material)
        if imported is not None:
            bpy.data.images.remove(imported)
        _revision += 1
        raise
    finally:
        _busy = False


def _write(value, live_seq=None):
    raw = json.dumps(value, separators=(",", ":"), allow_nan=False)
    if len(raw.encode()) > MAX_REQUEST_BYTES:
        raw = json.dumps({"command_id": value.get("command_id"), "ok": False, "error": "RESULT_LIMIT"})
    with open(f"{ROOT}/outbox.tmp", "w", encoding="utf-8") as handle:
        handle.write(raw)
    os.replace(f"{ROOT}/outbox.tmp", f"{ROOT}/outbox.json")
    if live_seq is not None:
        with open(f"{LIVE_ROOT}/out-{live_seq}.tmp", "w", encoding="utf-8") as handle:
            handle.write(raw)
        os.replace(f"{LIVE_ROOT}/out-{live_seq}.tmp", f"{LIVE_ROOT}/out-{live_seq}.json")


def start():
    import bpy
    from bpy.app.handlers import persistent

    @persistent
    def changed(*_args):
        global _revision
        if not _busy:
            _revision += 1

    def poll():
        global _last_input, _live_seq
        seq = None
        try:
            live = f"{LIVE_ROOT}/in-{_live_seq}.json"
            if os.path.isfile(live):
                # Each browser request path is read exactly once, even if it is malformed.
                seq, path = _live_seq, live
                _live_seq += 1
            elif os.path.isdir(LIVE_ROOT):
                return 0.25
            else:
                path = f"{ROOT}/inbox.json"
            with open(path, "rb") as handle:
                raw = handle.read(MAX_REQUEST_BYTES + 1)
            if seq is None:
                if raw == _last_input:
                    return 0.25
                _last_input = raw
            if len(raw) > MAX_REQUEST_BYTES:
                return 0.25
            request = json.loads(raw)
            _fields(request, ("command_id", "operation", "args"), ("command_id", "operation", "args"))
            key = request["command_id"]
            if not isinstance(key, str) or not _KEY.fullmatch(key):
                return 0.25
            digest = hashlib.sha256(raw).hexdigest()
            if key in _completed:
                prior_hash, result = _completed[key]
                if prior_hash != digest:
                    _write({"command_id": key, "ok": False, "error": "COMMAND_IDENTITY_CONFLICT"}, seq)
                else:
                    _write(result, seq)
                return 0.25
            if len(_completed) >= 500:
                _write({"command_id": key, "ok": False, "error": "SESSION_COMMAND_LIMIT"}, seq)
                return 0.25
            try:
                result = {"command_id": key, "ok": True, "data": execute(bpy, request["operation"], request["args"], key)}
            except (ValueError, RuntimeError) as error:
                result = {"command_id": key, "ok": False, "error": str(error)[:240], "scene_revision": _revision}
            except Exception:
                result = {"command_id": key, "ok": False, "error": "BLENDER_OPERATION_FAILED", "scene_revision": _revision}
            _completed[key] = (digest, result)
            _write(result, seq)
        except (OSError, ValueError, TypeError):
            pass
        return 0.25

    bpy.app.handlers.depsgraph_update_post.append(changed)
    bpy.app.handlers.undo_post.append(changed)
    bpy.app.handlers.redo_post.append(changed)
    bpy.app.timers.register(poll, first_interval=0.25, persistent=False)
    _write({"ready": True, "protocol": 1, "scene_revision": _revision})


if __name__ == "__main__":
    start()
