# Unreleased typed workflow adapter

This branch adds fixed Blender-side scene inspection, bounded primitive/object
edits (including delete, parent, smooth/flat shading and roughness/metallic/emission
materials), packed PNG application, native save, and whole-scene or per-object GLB export.
GLB export falls back to a bounded pure-Python writer (mesh objects, hierarchy, PBR/emission,
packed Base Color images) when Blender's own glTF exporter cannot load, as in the browser
build whose Python has neither numpy nor _ctypes. Each command now reaches Blender through a
one-use in-memory request/result file pair, because the browser file layer can return stale
bytes for a rewritten path. The bridge accepts
only claimed, window-bound commands from the separately implemented host.
It has no caller-supplied Python, operator names, RNA paths, or generic eval.
Uploaded scripts remain disabled. The new automation.py is GPL-3.0-or-later.

The native WebAssembly binary and complete corresponding native source are
unchanged from blender-5.3.0-alpha-20260921. Both the existing native archive and
this branch's adapter sources are required to reproduce the new candidate.
The standalone reproduce_adapter.py now also emits bosonoo/automation.py and
bosonoo/session.py. The latter runs in both human and AI sessions and supplies
bounded swatch previews so opening the Material properties does not enter the
browser build's synchronous preview-render deadlock. Live preview panels show
an explanation instead. This is an adapter guard; the native build is unchanged.

Alongside the existing save path, the bridge admits the host's two bounded
human actions (image import and GLB export) using the claimed command transport.
It checks the action, actor and parameter shape before native execution; it
does not accept an arbitrary script or privileged host command. The host's
Library UI and authorization implementation are deliberately separate.

workflow-candidate-source.json records exact candidate source hashes.
release-source.json continues to describe the existing published release,
not these unshipped changes. No browser qualification or live deployment is
claimed here. The final release must bind generated output hashes and its
explicit broker configuration after qualification.

Only Blender-side protocol/adapter source is included. Host application,
accounts, save ledger, provider credentials and user files are excluded.
