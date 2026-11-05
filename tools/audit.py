# .venv/bin/python tools/audit.py [--force] [--dump DIR]
# Looks at the images of every pair in the latest swapdb/builds snapshot (pixels, then OCR) and
# records a verdict per (jp bundle, kr bundle) in swapdb/verdicts.json:
#   drop  every image is pixel-identical, or KR has none under the names JP asks for, so swapping
#         only costs bandwidth
#   swap  images differ (translated text, which often changes size and shape wholesale)
#   flag  worth a look; `reasons` says why. Flagged pairs still ship until denied.
#         colors   an image's colors changed a lot (missing stamps, but also plain redesigns)
#         english  OCR reads confident English words in the KR image that the JP one lacks, and no
#                  Hangul or credit line (the KR build ships English placeholders for some images).
#                  Stylized lettering often reads as nothing, so a miss proves little.
# Each item keeps its size, dHash, diff numbers and OCR counts as a fingerprint for later stages.
# Bundle names carry content hashes, so a verdict is redone only when METHOD changes.
# OCR needs the tesseract binary; kor/jpn/eng models are fetched into .cache/tessdata.
import argparse, hashlib, io, json, os, re, subprocess, sys, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np
import UnityPy
from PIL import Image, ImageOps

UnityPy.config.FALLBACK_UNITY_VERSION = '2021.3.20f1'  # the version string is stripped from the bundles
import warnings; warnings.filterwarnings('ignore', module='UnityPy')

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / 'swapdb'
CACHE = ROOT / '.cache/archive/ab'  # shared with swap.js, mirrored from the Oracle archive
TESSDATA = ROOT / '.cache/tessdata'
TESSDATA_URL = 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/'
METHOD = 'pixel+ocr2'
CDN = 'https://appstatic.mahjongsoul.com/v4'
AB = '/resources/ab/WebGL/ASTC/'

PIXEL_DIFF = 32       # per-channel difference (premultiplied) that counts as a changed pixel
IDENTICAL = 0.0005    # changed-pixel fraction below which an image counts as unchanged
PALETTE = 0.5         # color-histogram overlap below which an item gets flagged
WORD_CONF = 80        # tesseract confidence for an OCR word to count

LANG = re.compile(r'(?<![A-Za-z0-9])(jp|kr)(?![A-Za-z0-9])', re.I)


def fetch(build, name):
    path = CACHE / build / name
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        data = urllib.request.urlopen(f'{CDN}/{build}{AB}{urllib.parse.quote(name)}', timeout=60).read()
        tmp = path.with_name(path.name + '.part')
        tmp.write_bytes(data)
        tmp.replace(path)
    return path


def images(path):
    """name -> RGBA image for every sprite, plus every texture no sprite cuts from."""
    env = UnityPy.load(str(path))
    out, atlases = {}, set()
    for o in env.objects:
        if o.type.name == 'Sprite':
            s = o.read()
            atlases.add(s.m_RD.texture.path_id)
            out['sprite:' + s.m_Name] = s.image.convert('RGBA')
    for o in env.objects:
        if o.type.name == 'Texture2D' and o.path_id not in atlases:
            t = o.read()
            out['texture:' + LANG.sub('LANG', t.m_Name)] = t.image.convert('RGBA')
    return out


def premul(img):
    a = np.asarray(img, dtype=np.int16)
    return np.concatenate([a[..., :3] * a[..., 3:] // 255, a[..., 3:]], axis=-1)


def dhash(img):
    g = Image.alpha_composite(Image.new('RGBA', img.size, (128, 128, 128, 255)), img).convert('L')
    a = np.asarray(g.resize((9, 8), Image.LANCZOS), dtype=np.int16)
    bits = (a[:, 1:] > a[:, :-1]).flatten()
    return int(''.join('1' if b else '0' for b in bits), 2)


def palette(img):
    """Alpha-weighted 64-bin color histogram."""
    a = np.asarray(img, dtype=np.float32).reshape(-1, 4)
    q = (a[:, :3] // 64).astype(int)
    h = np.bincount(q[:, 0] * 16 + q[:, 1] * 4 + q[:, 2], weights=a[:, 3] / 255, minlength=64)
    return h / max(h.sum(), 1e-9)


def compare(jp, kr):
    m = {'jp': list(jp.size), 'kr': list(kr.size), 'dhash': [f'{dhash(jp):016x}', f'{dhash(kr):016x}']}
    m['look'] = bin(int(m['dhash'][0], 16) ^ int(m['dhash'][1], 16)).count('1')
    m['palette'] = round(float(np.minimum(palette(jp), palette(kr)).sum()), 3)
    if jp.size == kr.size:
        m['changed'] = round(float((np.abs(premul(jp) - premul(kr)).max(axis=-1) > PIXEL_DIFF).mean()), 4)
    if m.get('changed', 1) < IDENTICAL:
        m['class'] = 'same'
    elif m['palette'] < PALETTE:
        m['class'] = 'colors'
    else:
        m['class'] = 'changed'
    return m


def fetch_models():
    for lang in ('kor', 'jpn', 'eng'):
        path = TESSDATA / f'{lang}.traineddata'
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(urllib.request.urlopen(TESSDATA_URL + path.name, timeout=120).read())


def ocr_words(img, lang):
    """Confident words tesseract reads, trying light-on-dark and dark-on-light."""
    g = Image.alpha_composite(Image.new('RGBA', img.size, (0, 0, 0, 255)), img).convert('L')
    if max(g.size) < 600:
        g = g.resize((g.width * 2, g.height * 2), Image.LANCZOS)
    g = ImageOps.expand(g, 20, 0)
    best = []
    for im in (g, ImageOps.invert(g)):
        buf = io.BytesIO(); im.save(buf, 'PNG')
        tsv = subprocess.run(['tesseract', '-', '-', '-l', lang, '--psm', '11', '-c', 'tessedit_create_tsv=1'], input=buf.getvalue(), capture_output=True,
                             env={**os.environ, 'TESSDATA_PREFIX': str(TESSDATA), 'OMP_THREAD_LIMIT': '1'}, check=True).stdout.decode()
        words = [r[11] for r in (l.split('\t') for l in tsv.splitlines()[1:]) if len(r) == 12 and float(r[10]) >= WORD_CONF and r[11].strip()]
        if sum(map(len, words)) > sum(map(len, best)):
            best = words
    return best


HANGUL = re.compile('[가-힣]')
LATIN_WORD = re.compile('[A-Za-z]{3,}')
CREDITS = re.compile(r'©|\b(Inc|Ltd|LIMITED|CORPORATION|Yostar|Games|Project|Entertainment|Reserved)\b', re.I)


def read_text(jp, kr):
    kr_words = ocr_words(kr, 'kor+eng')
    jp_latin = {w.lower() for w in LATIN_WORD.findall(' '.join(ocr_words(jp, 'jpn+eng')))}
    return {'hangul': sum(len(HANGUL.findall(w)) for w in kr_words),
            'english': [w for w in LATIN_WORD.findall(' '.join(kr_words)) if w.lower() not in jp_latin],
            'credits': bool(CREDITS.search(' '.join(kr_words)))}  # copyright lines stay English in KR too


def audit(jp_name, kr_name, dump):
    jp, kr = images(fetch('jp', jp_name)), images(fetch('kr', kr_name))
    items = {k: compare(jp[k], kr[k]) for k in sorted(jp.keys() & kr.keys())}
    for k, m in items.items():
        if m['class'] != 'same':
            m['ocr'] = read_text(jp[k], kr[k])
            if not m['ocr']['hangul'] and not m['ocr']['credits'] and sum(map(len, m['ocr']['english'])) >= 6:
                m['class'] = 'english'
    classes = {m['class'] for m in items.values()}
    reasons = sorted(f"{m['class']} {k}" for k, m in items.items() if m['class'] in ('colors', 'english'))
    if not items:
        verdict = 'drop' if jp else 'flag'  # KR names nothing the JP client asks for / no images at all
    elif classes <= {'same'}:
        verdict = 'drop'
    elif reasons:
        verdict = 'flag'
    else:
        verdict = 'swap'
    if dump:
        for k, m in items.items():
            if m['class'] in ('colors', 'english'):
                stem = Path(dump) / f"{m['class']}_{hashlib.sha1(jp_name.encode()).hexdigest()[:8]}_{re.sub(r'[^A-Za-z0-9_-]', '_', k)}"
                jp[k].save(f'{stem}_jp.png'); kr[k].save(f'{stem}_kr.png')
    return {'kr': kr_name, 'verdict': verdict, 'reasons': reasons, 'method': METHOD, 'at': date.today().isoformat(),
            'jpOnly': len(jp.keys() - kr.keys()), 'items': items}



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true', help='redo pairs that already have a verdict')
    ap.add_argument('--dump', help='write jp/kr images of flagged items here')
    args = ap.parse_args()
    if args.dump:
        Path(args.dump).mkdir(parents=True, exist_ok=True)
    fetch_models()

    snap_path = max((DB / 'builds').glob('*.json'))
    pairs = json.loads(snap_path.read_text())['pairs']
    vpath = DB / 'verdicts.json'
    verdicts = json.loads(vpath.read_text()) if vpath.exists() else {}
    key = lambda jp, kr: f'{jp} {kr}'
    todo = [(jp, v[0]) for jp, v in pairs.items() if args.force or verdicts.get(key(jp, v[0]), {}).get('method') != METHOD]
    print(f'{snap_path.name}: {len(pairs)} pairs, {len(todo)} to audit')

    def run(pair):
        try:
            return pair, audit(*pair, args.dump)
        except Exception as e:
            return pair, {'kr': pair[1], 'verdict': 'flag', 'reasons': ['error'], 'method': 'error', 'at': date.today().isoformat(), 'error': repr(e)}
    with ThreadPoolExecutor(8) as ex:
        for i, ((jp, kr), v) in enumerate(ex.map(run, todo), 1):
            verdicts[key(jp, kr)] = v
            print(f'  [{i}/{len(todo)}] {v["verdict"]:4} {jp}', file=sys.stderr)

    vpath.write_text(json.dumps(dict(sorted(verdicts.items())), ensure_ascii=False, indent=1) + '\n')
    now = [verdicts[key(jp, v[0])] for jp, v in pairs.items()]
    counts = {k: sum(v['verdict'] == k for v in now) for k in ('swap', 'drop', 'flag')}
    print('verdicts for this build:', counts)
    for jp, v in pairs.items():
        for r in verdicts[key(jp, v[0])].get('reasons', []):
            print('  flag', r, jp)


if __name__ == '__main__':
    main()
