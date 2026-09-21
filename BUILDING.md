# Rebuilding the distributed component

## Complete Blender/browser source

Download `source.tar.gz` from this repository's versioned release. Verify its
SHA-256 against [release-source.json](release-source.json) before extracting it
into a fresh directory. For example, use `sha256sum source.tar.gz` on Linux or
`Get-FileHash source.tar.gz -Algorithm SHA256` in PowerShell.

The archive contains these roots:

- `source/`: the actual patched Blender, dependencies, frontend and build scripts.
- `toolchain/emscripten/`: the Emscripten sources and source packages used by the build.
- `recipe/`: build, dependency-fetch, patch and packaging scripts, including
  `REBUILD.md` and the dated `seamless/` patch/build history.
- `record/`: source-file and dependency inventories used for verification.

Run `python3 recipe/verify_source.py /absolute/path/to/extracted-archive` and
follow the archive's `recipe/REBUILD.md`. The retained source-tree rebuild
procedure uses the retained Dockerfile with Emscripten 6.0.1, `source/` mounted at
`/work/blender-rebuild`, `recipe/` at `/inputs`, and a fresh output directory at
`/output`. The retained build recipe documents port sources and the npm cache.
The recorded build used 8 CPUs and 24 GiB memory. A fresh image can acquire
different operating-system package revisions; byte-identical output is not
promised.

The native source tree already contains the final patches. Do not blindly
reapply the patch scripts to it. The scripts under `engine-runtime/blender/`
are provided for inspection and for applying the changes to the pinned
unmodified source inputs. They check input hashes and refuse incompatible
trees. The archive retains both patch attempts and their exact receipts.

Pinned upstream repositories:

| Component | Revision |
| --- | --- |
| [Blender browser fork](https://github.com/HeyPuter/blender) | `6b031d3d41c392883e3c495aa72343e10d15b43d` |
| [Browser builder](https://github.com/HeyPuter/blender-wasm) | `60315a3001911bb947014e5e510d6bfcd0143bdb` |

## Browser adapter files

Use Python 3.10 or later; the standalone generator has no third-party Python
dependencies and does not import the host application. Given the rebuilt
frontend distribution directory containing `assets/index-*.js`:

```sh
python reproduce_adapter.py --blender-dist /path/to/dist --out /path/to/new-adapter-output --broker-ws wss://your-host.example/v1/engine/runtime/ws
```

The output directory must not exist. The generator creates `bosonoo.html` and
`bosonoo/{config,storage,bridge}.js`. It validates the frontend DOM contract and
script order before writing. Copy these beside the rebuilt vendor assets and
retain the license/source links when distributing the resulting runtime.

For comparison with the published 2026-09-21 artifact, use the explicit endpoint
`wss://public-api.bosonoo.com/v1/engine/runtime/ws` and the exact retained frontend
bundle. This merely reproduces its public configuration; it provides no session
or access rights. Compare output hashes against `shippedAssets` in
`release-source.json`.

This source-only release verified all four generated files against the deployed
pack. It did not perform another native Blender rebuild. Existing Blender adapter
tests are retained in the complete archive under
`recipe/seamless/integration/engine-runtime/tests/`.

## Updating Blender

Treat each upstream upgrade as a new source/build version. Review changed patch
anchors and native API/DOM contracts, rebuild using pinned inputs, and test real
open/edit/save/reopen, simultaneous projects and disconnect recovery. Publish
the new corresponding source, notices and output hashes with that version.
Retain older source releases while their corresponding binaries remain available.
