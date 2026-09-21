# Bounded browser adapter

`apply_browser_adapter.py` applies to a **new candidate build tree** from Blender
`6b031d3d41c392883e3c495aa72343e10d15b43d` and browser builder
`60315a3001911bb947014e5e510d6bfcd0143bdb`. It validates all three original source
hashes and patch anchors before writing anything. Do not run it on a published
pack or rewrite previously retained source/distribution evidence.

The adapter is compiled into `wm_files.cc`. Its three exports admit only:

* `blender_bosonoo_autosave_enable(path)`: one immutable path under
  `/bosonoo/workspace/`, ending in `.blend`; accepted once per runtime.
* `blender_bosonoo_autosave_status()`: native loading/clean/dirty/busy/requested/
  failed/document-changed state. Native clean **does not** mean the Library save
  is committed. A changed document after the first valid anchor stops automatic
  saving, removes its capability hint, and preserves the unsaved-work close guard.
* `blender_bosonoo_save_current()`: a request to serialize the already opened
  project, without accepting code, an operator name, or another destination.

Requests execute in Blender's existing event loop. Loading a different path,
missing windows, and native modal operations defer serialization. Dirty state
comes from Blender, rather than from mouse events or guessed file bytes. The
native writer flushes edits and internal image autosaves, writes current scene
state to the fixed provider mount, and only marks the native file clean after
success. It does not invoke Python save handlers. External assets that the
single `.blend` does not embed are outside this adapter's save contract.

The bridge waits five seconds after observing dirty state and requests at most
one native save every fifteen seconds. Native write failures stay visible and
retry after thirty seconds. Provider writes/renames feed the existing bounded
snapshot/receipt protocol; the server's original/browser-copy rules remain
unchanged. Unconfirmed cloud saves retain their close guard and recovery bytes.
Ctrl+S can retry a cloud save even when Blender is already native-clean. Unknown
outcomes are reconciled by snapshot ID before proposing another commit.

The canvas patch gives resizing to its owning render thread after launch. The
frontend stops assigning the transferred HTML canvas's width/height; GHOST's
existing resize callback reads CSS geometry, resizes the OffscreenCanvas, then
updates Blender's window/backbuffer size. The patch does not suppress a thrown
exception while leaving the render surface at its old dimensions.

Tests under `engine-runtime/tests/test_blender_autosave.mjs`,
`test_blender_bridge_flow.mjs`, and `test_blender_browser_adapter.py` cover the
scheduler, protocol flow, and fail-closed source transformations. Those tests
alone do **not** qualify a compiled native build. Before enabling a candidate,
compile/link it with the pinned recipe and verify actual edit → automatic save →
reopen, simultaneous project isolation, modal deferral, resizing, and disconnected
recovery in the browser. Retain the changed source, notices, and build hashes in
the new pack's complete source distribution.
