# SPDX-License-Identifier: GPL-3.0-or-later
"""Reproduce the candidate Blender guest adapter without any host application.

Only Blender-side files are emitted. The browser-local host implements the
documented one-file MessagePort protocol independently; it is not included.
This does not produce or approve a production manifest.
"""
import argparse
import re
from pathlib import Path

from reproduce_adapter import BuildError, BLENDER_ENTRY_TAG, _one, _write_text, blender_dom_contract


def render_guest_shell(template: str, entry_name: str, entry_module: str) -> str:
    out = template.replace('\r\n', '\n')
    if len(BLENDER_ENTRY_TAG.findall(out)) != 1:
        raise BuildError('Guest shell must have exactly one vendor module tag')
    entry_tag = f'<script type="module" src="assets/{entry_name}"></script>'
    out = BLENDER_ENTRY_TAG.sub(lambda _match: entry_tag, out)
    ids, classes = blender_dom_contract(entry_module)
    missing = [f'#{name}' for name in ids if out.count(f'id="{name}"') != 1]
    missing += [f'.{name}' for name in classes if not re.search(
        r'class="(?:[^\"]*\s)?' + re.escape(name) + r'(?:\s[^\"]*)?"', out)]
    if missing:
        raise BuildError('Guest shell lacks vendor DOM elements: ' + ', '.join(missing))
    scripts = ('guest-primitives.js', 'guest-resource.js', 'guest.js')
    order = [out.find(f'<script src="bosonoo/{name}"></script>') for name in scripts] + [out.find(entry_tag)]
    if (-1 in order or order != sorted(order) or out.count('<script') != 4
            or re.search(r'<script(?![^>]*\ssrc=)[^>]*>', out, re.IGNORECASE)
            or 'http://' in out or 'https://' in out):
        raise BuildError('Guest shell has an unexpected script or remote reference')
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--blender-dist', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--release-shell', action='store_true',
                        help='Use the license wording of a hosted candidate; does not qualify or approve it')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    source = root / 'engine-runtime/pack/blender'
    entry = _one(args.blender_dist / 'assets', 'index-*.js')
    shell = render_guest_shell((source / 'guest.html').read_text(encoding='utf-8'),
                               entry.name, entry.read_text(encoding='utf-8'))
    if args.release_shell:
        label = 'GPL (see NOTICE.txt); development pack, not reviewed'
        if shell.count(label) != 1:
            raise BuildError('Guest shell license label changed shape')
        shell = shell.replace(label, 'GPL (see NOTICE.txt and COPYING)')
    args.out.mkdir(parents=True, exist_ok=False)
    _write_text(args.out / 'guest.html', shell)
    for name in ('guest-primitives.js', 'guest-resource.js', 'guest.js', 'session.py'):
        destination = args.out / 'bosonoo' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((source / name).read_bytes())
    print('Reproduced guest.html and bosonoo/{guest-primitives.js,guest-resource.js,guest.js,session.py}')


if __name__ == '__main__':
    main()
