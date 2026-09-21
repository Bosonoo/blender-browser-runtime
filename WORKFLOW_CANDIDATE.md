# Unreleased typed workflow adapter

This branch adds fixed Blender-side scene inspection, bounded primitive/object
edits, packed PNG application, native save, and GLB export. The bridge accepts
only claimed, window-bound commands from the separately implemented host.
It has no caller-supplied Python, operator names, RNA paths, or generic eval.
Uploaded scripts remain disabled. The new automation.py is GPL-3.0-or-later.

The native WebAssembly binary and complete corresponding native source are
unchanged from blender-5.3.0-alpha-20260921. Both the existing native archive and
this branch's adapter sources are required to reproduce the new candidate.
The standalone reproduce_adapter.py now also emits bosonoo/automation.py.

workflow-candidate-source.json records exact candidate source hashes.
release-source.json continues to describe the existing published release,
not these unshipped changes. No browser qualification or live deployment is
claimed here. The final release must bind generated output hashes and its
explicit broker configuration after qualification.

Only Blender-side protocol/adapter source is included. Host application,
accounts, save ledger, provider credentials and user files are excluded.
