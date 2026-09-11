#!/usr/bin/env python3
"""Turn a folder of camera photos into VJay's album.

    python3 tools/import-photos.py ~/Pictures/some-album

Applies EXIF rotation (phones store it rather than rotating the pixels, so
without this a third of any album is sideways), resizes to something a projector
can actually use, and writes the manifest the app reads. HEIC goes through
ffmpeg, since Pillow cannot open it without an extra package.
"""
import json
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageOps

MAXW = 1600
DST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'media', 'photos')
MANIFEST = os.path.join(os.path.dirname(DST), 'photos.json')


def classify(im):
    """'cutout' for a figure already lifted onto black, else 'scene'.

    A cut-out has a dark BORDER while its middle is not dark - that is what
    being lifted onto black means, and it is the signal that the picture was
    made to be composited rather than looked at whole. The threshold is loose
    because several carry a glow or sticker outline that lifts the border.

    Nothing here can spot a screenshot or a blurred frame; mark those `skip`
    in the manifest by hand after looking at them.
    """
    g = im.convert('L')
    w, h = g.size
    px = g.load()
    edge = n = 0
    for x in range(0, w, max(1, w // 60)):
        for y in (0, 1, h - 2, h - 1):
            edge += px[x, y]
            n += 1
    for y in range(0, h, max(1, h // 60)):
        for x in (0, 1, w - 2, w - 1):
            edge += px[x, y]
            n += 1
    border = edge / max(n, 1)
    mid = g.crop((w // 4, h // 4, 3 * w // 4, 3 * h // 4)).resize((24, 24))
    inner = sum(list(mid.getdata())) / 576.0
    return 'cutout' if (border < 48 and inner > border + 25) else 'scene'


def convert(src_dir):
    os.makedirs(DST, exist_ok=True)
    out, skipped = [], []
    names = sorted(f for f in os.listdir(src_dir)
                   if os.path.isfile(os.path.join(src_dir, f)))
    for i, name in enumerate(names):
        path = os.path.join(src_dir, name)
        stem = os.path.splitext(name)[0]
        try:
            try:
                im = Image.open(path)
            except Exception:
                tmp = tempfile.mktemp(suffix='.png')
                subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', path, tmp],
                               check=True, timeout=120)
                im = Image.open(tmp)
            im = ImageOps.exif_transpose(im).convert('RGB')
            w, h = im.size
            if max(w, h) > MAXW:
                s = MAXW / max(w, h)
                im = im.resize((round(w * s), round(h * s)), Image.LANCZOS)
            fn = '%02d-%s.jpg' % (i, stem)
            im.save(os.path.join(DST, fn), 'JPEG', quality=88, optimize=True)
            out.append({'file': fn, 'w': im.size[0], 'h': im.size[1],
                        'kind': classify(im)})
        except Exception as e:
            skipped.append('%s: %s' % (name, type(e).__name__))
    with open(MANIFEST, 'w') as f:
        json.dump({'photos': out}, f, indent=1)
    return out, skipped


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    got, missed = convert(sys.argv[1])
    print('converted %d into %s' % (len(got), DST))
    for m in missed:
        print('  skipped', m)
