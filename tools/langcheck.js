// node tools/langcheck.js [--hash JP_BUNDLE_HASH]   (default: the latest snapshot)
// Checks swap.js's idea of "language bundle" against the game's own: MyAssets/docs/localizedImg_jp.json
// lists the images the loader localizes, `filepath` "a/b/c.png" with fileType 1 meaning it loads
// a/b/jp/c.png (or a sprite of an atlas in a/b/jp/). Those are the JP assets a Korean build could
// replace. This resolves each entry in the JP manifest and reports
//   - how many resolve at all: a sharp drop means the folder convention changed (jp/ -> ja/ …),
//     which JP_TOKEN in swap.js would silently miss
//   - how many sit in bundles that swap.json pairs, and for the rest why not.
// Reads the archive only (tools/watch.js keeps the docs bundles of every build).
const fs = require('fs');
const path = require('path');
const MjsKr = require('../src/core.js');

const ROOT = path.join(__dirname, '..');
const ARCHIVE = path.join(ROOT, '.cache/archive');
const dec = new TextDecoder();
const toKr = p => p.replace(/(?<![A-Za-z0-9])jp(?![A-Za-z0-9])/gi, t => t === 'JP' ? 'KR' : t === 'Jp' ? 'Kr' : 'kr');

function readManifest(archive, lang, hash) {
  const file = path.join(archive, 'manifests', lang, hash + '.majset');
  return fs.existsSync(file) ? MjsKr.readManifest(new Uint8Array(fs.readFileSync(file))) : null;
}

// The `items` of MyAssets/docs/localizedImg_<lang>.json in a build, or null.
function localizedImg(archive, lang, m) {
  const a = m.assets.find(x => x.path.toLowerCase() === `myassets/docs/localizedimg_${lang}.json`);
  if (!a) return null;
  const file = path.join(archive, 'ab', lang, m.bundles[a.owner].name);
  if (!fs.existsSync(file)) return null;
  const text = MjsKr.extractLua(new Uint8Array(fs.readFileSync(file)), `localizedImg_${lang}`);
  return text ? JSON.parse(dec.decode(text)).items : null;
}

// snap: a swapdb/builds snapshot. Returns null when the build's files aren't archived.
function check(snap, archive = ARCHIVE) {
  const jp = readManifest(archive, 'jp', snap.jp), kr = readManifest(archive, 'kr', snap.kr);
  if (!jp || !kr) return null;
  const items = localizedImg(archive, 'jp', jp);
  if (!items) return { missing: true };

  const byPath = new Map(jp.assets.map(a => [a.path.toLowerCase(), a]));
  const byDir = new Map();
  for (const a of jp.assets) {
    const d = a.path.toLowerCase().replace(/\/[^/]*$/, '');
    if (!byDir.has(d)) byDir.set(d, new Set());
    byDir.get(d).add(jp.bundles[a.owner].name);
  }
  const krPaths = new Set(kr.assets.map(a => a.path.toLowerCase()));

  const lang = items.filter(it => it.fileType === 1);
  let resolved = 0, covered = 0;
  const bundles = new Map(); // jp bundle -> entries
  for (const it of lang) {
    const p = it.filepath.replace(/\\/g, '/').toLowerCase(), i = p.lastIndexOf('/');
    const dir = `myassets/${p.slice(0, i)}/jp`;
    const file = byPath.get(dir + p.slice(i));
    const owners = file ? [jp.bundles[file.owner].name] : [...(byDir.get(dir) || [])];
    if (!owners.length) continue;
    resolved++;
    if (owners.every(n => snap.pairs[n])) covered++;
    for (const n of owners) bundles.set(n, (bundles.get(n) || 0) + 1);
  }

  // Why the JP bundles the loader localizes aren't paired.
  const paths = new Map();
  for (const a of jp.assets) {
    const n = jp.bundles[a.owner].name;
    if (!paths.has(n)) paths.set(n, []);
    paths.get(n).push(a.path);
  }
  const unpaired = [];
  for (const [n, entries] of bundles) {
    if (snap.pairs[n]) continue;
    const ps = paths.get(n);
    const lp = ps.filter(p => toKr(p) !== p);
    let why;
    if (snap.rejected[n]) why = '검증 탈락: ' + snap.rejected[n][1];
    else if (!lp.length) why = '경로에 jp 표시가 없음 (swap.js가 못 봄)';
    else if (!lp.some(p => krPaths.has(toKr(p).toLowerCase()))) why = 'KR 빌드에 kr 버전 없음';
    else why = 'KR 쪽 번들 구성이 다름';
    unpaired.push({ name: n, paths: ps, entries, why });
  }
  unpaired.sort((a, b) => b.entries - a.entries);
  return { entries: lang.length, resolved, covered, bundles: bundles.size, paired: bundles.size - unpaired.length, unpaired };
}

module.exports = { check };

if (require.main === module) {
  const builds = path.join(ROOT, 'swapdb/builds');
  const files = fs.readdirSync(builds).filter(f => f.endsWith('.json')).sort();
  const i = process.argv.indexOf('--hash');
  const snaps = files.map(f => JSON.parse(fs.readFileSync(path.join(builds, f), 'utf8')));
  const snap = i > 0 ? snaps.find(s => s.jp.startsWith(process.argv[i + 1])) : snaps[snaps.length - 1];
  const r = snap && check(snap);
  if (!r) { console.log('이 빌드는 보관소에 없음'); process.exit(1); }
  if (r.missing) { console.log('localizedImg_jp.json을 못 찾음'); process.exit(1); }
  console.log(`localizedImg_jp 언어 항목 ${r.entries}개 중 jp 폴더로 풀린 것 ${r.resolved}, 그중 짝 있는 번들에 든 것 ${r.covered}`);
  console.log(`해당 JP 번들 ${r.bundles}개 중 짝 ${r.paired}개`);
  const why = {};
  for (const u of r.unpaired) why[u.why.replace(/:.*/, '')] = (why[u.why.replace(/:.*/, '')] || 0) + 1;
  console.log(why);
  for (const u of r.unpaired.slice(0, 40)) console.log(`  ${u.entries}\t${u.paths[0]}${u.paths.length > 1 ? ` (+${u.paths.length - 1})` : ''}\t${u.why}`);
}
