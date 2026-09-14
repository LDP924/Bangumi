#!/usr/bin/env python3
"""Git merge driver for src/assets/json/advance.json.

advance.json is a single-line minified JSON object that both this fork and
upstream modify independently (upstream adds/updates paid-membership
entries; this fork only ever adds its own user id). Because the whole file
is one line, git's default line-based merge flags a conflict on almost
every upstream sync even though the underlying JSON changes rarely
overlap. This driver does a real key-level 3-way merge instead:

  - any key present in "ours" (fork) but absent from "base" (merge-base) is
    a fork-local addition -> always kept
  - every other key defers to "theirs" (upstream), since upstream owns the
    live membership data in this file

Git merge-driver invocation: <driver> %O %A %B
  %O = common ancestor (base)
  %A = current branch's version (ours) -- this file is OVERWRITTEN with the result
  %B = other branch's version (theirs)
"""
import json
import sys


def load(path):
    with open(path, encoding='utf-8') as f:
        text = f.read().strip()
    # Older revisions of advance.json (pre-fork-divergence, i.e. still the
    # historical merge-base version) wrap the object in single quotes as a
    # JS string literal: '{"key":"value",...}'. Strip that wrapper if
    # present so both the old and new on-disk formats parse the same way.
    if len(text) >= 2 and text[0] == "'" and text[-1] == "'":
        text = text[1:-1]
    return json.loads(text)


def main():
    if len(sys.argv) != 4:
        print('usage: merge-advance-json.py <base> <ours> <theirs>', file=sys.stderr)
        return 1

    base_path, ours_path, theirs_path = sys.argv[1:4]

    try:
        base = load(base_path)
        ours = load(ours_path)
        theirs = load(theirs_path)
    except (json.JSONDecodeError, OSError) as e:
        print(f'advance.json merge driver: cannot parse an input as JSON ({e}); falling back to manual merge', file=sys.stderr)
        return 1

    fork_only_keys = set(ours) - set(base)

    merged = dict(theirs)
    for k in fork_only_keys:
        merged[k] = ours[k]

    with open(ours_path, 'w', encoding='utf-8') as f:
        json.dump(merged, f, ensure_ascii=False, separators=(',', ':'))

    added = sorted(set(theirs) - set(base))
    kept = sorted(fork_only_keys)
    print(f'advance.json auto-merged: kept {len(kept)} fork-only key(s) {kept}, took {len(added)} new/changed upstream key(s)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
