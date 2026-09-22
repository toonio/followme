#!/usr/bin/env python3
"""Stamp a version onto every local script/stylesheet URL in index.html.

Why this exists: GitHub Pages serves everything with `Cache-Control: max-age=600`,
and a browser is free to re-fetch index.html while keeping a cached js/*.js. That
leaves new markup driving old code — which fails *silently*, because the old code
writes to element ids the new markup no longer has. It shipped a locked screen with
no readouts on it once; that is the bug this prevents from recurring.

A query string makes each deploy's URLs unique, so new HTML can only ever pull the
JS and CSS it was built against.

Run before committing a deploy:

    python tools/bump-assets.py
"""

import datetime
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX = ROOT / 'index.html'

# Local assets only — an external URL (the Deezer widget) must not be touched.
PATTERN = re.compile(r'(?P<attr>src|href)="(?P<path>(?:js|css)/[^"?]+)(?:\?v=[^"]*)?"')


def main() -> int:
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')
    html = INDEX.read_text(encoding='utf-8')

    count = 0

    def stamp_one(match: re.Match) -> str:
        nonlocal count
        count += 1
        return '{attr}="{path}?v={stamp}"'.format(
            attr=match.group('attr'), path=match.group('path'), stamp=stamp)

    updated = PATTERN.sub(stamp_one, html)
    if updated == html:
        print('nothing to stamp — check the pattern still matches index.html')
        return 1

    INDEX.write_text(updated, encoding='utf-8', newline='')
    print('stamped {n} asset URLs with ?v={stamp}'.format(n=count, stamp=stamp))
    return 0


if __name__ == '__main__':
    sys.exit(main())
