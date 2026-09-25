# Unreleased browser-local Blender adapter

This candidate adds a distinct guest entrypoint. It opens a single browser-owned
`.blend` through a narrowly scoped MessagePort and uses the existing Blender
memory-file provider and fixed native autosave exports. It loads the same pinned
native runtime and `session.py` guard as the current workflow candidate. It does
not load the authenticated bridge, account-storage cleanup, AI command adapter,
WebSocket configuration or a Library launch grant.

The original native source archive remains required and unchanged. These adapter
sources supplement it; there is no new native Blender build in this candidate.
Browser Blender 5.3 output still cannot be opened with desktop Blender 5.2.
The host retains imported originals independently of editable browser copies.

## Reproduce the adapter

With Python 3.10 or later and the retained/rebuilt frontend distribution:

```sh
python reproduce_guest_adapter.py --blender-dist /path/to/dist --out /path/to/new-guest-adapter
node --test engine-runtime/tests/test_blender_guest.mjs
```

The output is `guest.html`, `bosonoo/guest-primitives.js`,
`bosonoo/guest-resource.js`, `bosonoo/guest.js` and `bosonoo/session.py`. Place them
beside the matching vendor assets. The generator validates vendor DOM lookups
and script order; it does not generate a host configuration or release approval.
The development notice stays intact for exact candidate-byte reproduction.
Pass `--release-shell` to reproduce the hosted-candidate license wording instead.
That option changes only the notice, requires the accompanying `COPYING` license
asset, and does not provide qualification evidence or approve a release.

## Public transport and isolation contract

The guest frame requires its own cookieless origin, a credentialless iframe,
cross-origin isolation in parent and child, hardware WebGPU and the same-origin
WASM/runtime assets. It must not share an origin with account-bearing pages.
Its CSP admits its own assets and the vendor's `data:` WASM decoder, with no
account broker connection. The runtime does not choose file IDs or server URLs.

The launch fragment contains exact `parent`, `instance` and `nonce` values. The
runtime strips that fragment before vendor startup. It accepts one initialization
message from the exact parent window and origin, matching both opaque values:

```text
{type: "bosonoo:guest-blender:init", version: 1, instanceId, nonce}
```

That message transfers two ports: a content-free UI port, then a one-file
`bosonoo.local-resource-session` version 2 port. The independently implemented
host binds that resource port to a specific browser-owned file and editor
generation. No host source or credentials are part of this repository.

The file port supplies `open`, `stat`, `read`, revision-checked/idempotent
`replace`, and `checkpoint`. A confirmed save requires the checkpoint to match
the replacement's resource identity, revision, byte length and SHA-256. An
uncertain save retains its immutable bytes, base revision and idempotency key;
later native edits stay separate until it is reconciled. Files are bounded to
64 MiB for this browser-local adapter. Larger serialized work remains available
for a native recovery download rather than being silently truncated.

UI requests use strictly increasing sequences, opaque request IDs and only
`save`, `prepareClose`, `prepareExport`, `export`, `prepareDiscard` or
`resumeAfterDiscardFailure`. The `export` action downloads a
native recovery copy and does not claim a browser-storage save. Starting a
download is not proof that the browser or person retained that file. Close and
normal export require current checkpoint receipts; unresolved native edits
remain open. The original download uses a separate bounded read and verifies
the original's advertised size and hash without changing the write revision.

Explicit discard pauses native input, autosave requests and file-saving hooks.
An already dispatched save must be reconciled before the file broker confirms a
quiesced revision. New unsaved edits are retained in native memory without being
implicitly committed. The host may delete only that exact browser revision.
Deletion failure retains the frame and its memory; saving resumes only after
the broker acknowledges resume. A lost UI resume acknowledgement can be replayed
for the same discard barrier without repeating the broker mutation. Recovery
export can still serialize to frame memory while the storage barrier is held;
it neither resumes storage writes nor grants permission to close.

## Qualification state

The standalone adapter tests currently cover the scoped initialization, strict
UI/file envelopes, immutable lost-response retry, pending edits, checkpoint
mismatch, size refusal, native file-provider behavior, locked startup hooks,
and unchanged-source closing before native launch. The adapter outputs were
compared byte-for-byte with the retained local guest candidate.

Real WebGPU startup, native edit/save/reopen, concurrent files and storage failure
acceptance are still required before publishing a hosted release. This document
does not claim that the guest feature is live or fully qualified.
`guest-candidate-source.json` records this candidate's source/output hashes.
The published `release-source.json` remains unchanged.
