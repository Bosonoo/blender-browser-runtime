# Blender browser runtime and adapter

Source for the Blender-side browser runtime distributed as
`blender-5.3.0-alpha-20260921`. It includes the browser bridge, loader template,
workspace storage helper, native autosave adapter and source patches.

This is an experimental Blender 5.3 alpha WebAssembly/WebGPU build. It is not a
desktop Blender add-on. Browser-produced files are not compatible with desktop
Blender 5.2; the integration preserves the original and saves a separate browser
copy. External assets not embedded in the `.blend` are outside this adapter's
single-file save contract.

## Obtain the corresponding source

- [Versioned release and downloads](https://github.com/Bosonoo/blender-browser-runtime/releases/tag/blender-5.3.0-alpha-20260921)
- [Complete native/browser/dependency source archive](https://github.com/Bosonoo/blender-browser-runtime/releases/download/blender-5.3.0-alpha-20260921/source.tar.gz)
- [Source archive alongside the distributed runtime](https://engines-alpha.bosonoo.com/engine-packs/blender/blender-5.3.0-alpha-20260921/source.tar.gz)

The complete source is **822,802,908 bytes**, SHA-256:

```text
78de34c8a2cb17bda5b5ec601bfb2e452b0ca636b776c375f6ef013668e68f7c
```

The native archive contains the modified Blender tree, browser frontend,
dependency sources, relevant Emscripten sources, build scripts and source
inventories. It retains the exact published bytes, including historical Blender
build records. The smaller `bosonoo-integration-source.tar.gz` release attachment
contains this repository's editable adapter source and standalone generator.
Both archives are needed for the full native-plus-adapter source distribution.

[BUILDING.md](BUILDING.md) describes rebuilding. [release-source.json](release-source.json)
binds pinned upstream revisions, extracted source files and selected distributed
assets to their SHA-256 hashes. A fresh independent build from the complete
archive has not yet been qualified for byte-identical output.

## Scope

This repository has a fresh history containing only this Blender component and
its source-distribution documentation. The host application, server, account
system, save ledger, deployment configuration and user files are not included.
The bridge's public protocol names and `bosonoo` paths remain intact because
they form part of the distributed engine interface.

The engine runs in an isolated browser origin and exchanges bounded project
bytes and save receipts with a separately implemented WebSocket host. This
repository does not grant access to a running host or include host credentials.
The adapter expects an explicit host endpoint; it is not a standalone replacement
for that service. The underlying Blender/browser source can be modified and
rebuilt independently.

## License and attribution

The [unreleased guest candidate](GUEST_CANDIDATE.md) supplies a separate,
browser-local MessagePort adapter. It uses the same native source archive and
has its own standalone reproduction script; it is not a hosted release.

The Blender integration contributions in this repository are available under
**GPL-3.0-or-later**. Upstream files retain their individual license and copyright
notices. See [LICENSING.md](LICENSING.md), [COPYING](COPYING) and [NOTICE.txt](NOTICE.txt).
The program is provided without warranty. Blender Foundation and the Blender
Authors retain their original copyrights; this repository does not imply their
endorsement.

Keeping source in a separate repository does not, by itself, decide the legal
boundary between independent programs and a combined work. This repository
documents the distributed component and supplies its source; it is not a legal
certification of other software.
