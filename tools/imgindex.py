# .venv/bin/python -I tools/imgindex.py [--force]
# Indexes every archived bundle (.cache/archive/ab/<lang>/<bundle>) that has no index yet:
#   index/<lang>/<bundle>.json  asset paths in the bundle and, per image, size, dHash and sha1
#   img/<sha[:2]>/<sha>.png     each distinct image once, whatever bundle or build it came from
# tools/drift.js uses these to trace images back across builds: a bundle that moved to a new path or
# a sprite that got renamed keeps its pixels (sha1) or at least its look (dHash).
# Images are what tools/audit.py compares: sprites, plus textures no sprite cuts from.
import argparse, hashlib, json, os, sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from audit import ROOT, images, dhash  # noqa: E402
import UnityPy  # noqa: E402

ARCHIVE = ROOT / '.cache/archive'
METHOD = 'idx1'


def sha(img):
    return hashlib.sha1(f'{img.width}x{img.height}'.encode() + img.tobytes()).hexdigest()


def index(lang, path):
    out = {'method': METHOD, 'paths': [], 'items': {}}
    try:
        out['paths'] = sorted(UnityPy.load(str(path)).container.keys())
        for k, img in images(path).items():
            h = sha(img)
            png = ARCHIVE / 'img' / h[:2] / f'{h}.png'
            if not png.exists():
                png.parent.mkdir(parents=True, exist_ok=True)
                tmp = png.with_name(png.name + f'.{os.getpid()}.part')
                img.save(tmp, 'PNG')
                tmp.replace(png)
            out['items'][k] = {'size': list(img.size), 'dhash': f'{dhash(img):016x}', 'sha': h}
    except Exception as e:  # not an image bundle UnityPy can read; keep the error so it isn't retried
        out['error'] = repr(e)
    dst = ARCHIVE / 'index' / lang / f'{path.name}.json'
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + '.part')
    tmp.write_text(json.dumps(out, ensure_ascii=False) + '\n')
    tmp.replace(dst)
    return len(out['items']), 'error' in out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true', help='reindex bundles that already have an index')
    args = ap.parse_args()
    todo = []
    for lang_dir in sorted((ARCHIVE / 'ab').iterdir()):
        for p in sorted(lang_dir.iterdir()):
            if p.name.endswith('.part'):
                continue
            idx = ARCHIVE / 'index' / lang_dir.name / f'{p.name}.json'
            if args.force or not idx.exists() or json.loads(idx.read_text()).get('method') != METHOD:
                todo.append((lang_dir.name, p))
    print(f'{len(todo)} bundles to index')
    n_img = n_err = 0
    with ProcessPoolExecutor(os.cpu_count()) as ex:
        for i, (n, err) in enumerate(ex.map(index, *zip(*todo)) if todo else [], 1):
            n_img += n; n_err += err
            if i % 50 == 0 or i == len(todo):
                print(f'  [{i}/{len(todo)}] {n_img} images', file=sys.stderr)
    print(f'indexed {len(todo)} bundles, {n_img} images, {n_err} unreadable')


if __name__ == '__main__':
    main()
