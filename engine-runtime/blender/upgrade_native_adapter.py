"""Upgrade only the exact first qualified autosave candidate's native adapter.

Fresh source uses apply_browser_adapter.py instead. This path is for the retained
incremental object cache and refuses any unexpected source or prior adapter.
"""
from pathlib import Path
import argparse
import hashlib
import json

FIRST_NATIVE_SHA = "07359ed380f126fff92e0a69d4b2fd2fa50926b595e4e77da925e0ee5eaf0b39"
FIRST_ADAPTER_SHA = "ade02d235c7f5c17837d00db2733d2b0c266de859023b2a1ab52f3c6856dd7ab"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def upgrade(root: Path, previous: Path):
    path = root / "blender/source/blender/windowmanager/intern/wm_files.cc"
    raw = path.read_bytes()
    old = previous.read_bytes()
    if sha(raw) != FIRST_NATIVE_SHA or sha(old) != FIRST_ADAPTER_SHA:
        raise ValueError("Native candidate/cache does not match the first compiled adapter")
    replacement = Path(__file__).with_name("bosonoo_autosave.inc").read_text(encoding="utf-8")
    text = raw.decode("utf-8")
    needle = old.decode("utf-8")
    if text.count(needle) != 1:
        raise ValueError("The first native adapter must occur exactly once")
    output = text.replace(needle, replacement, 1).encode("utf-8")
    path.write_bytes(output)
    return {"path": path.relative_to(root).as_posix(), "before": sha(raw), "after": sha(output)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("previous_adapter", type=Path)
    args = parser.parse_args()
    print(json.dumps(upgrade(args.root, args.previous_adapter), indent=2))
