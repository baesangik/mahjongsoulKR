// node swap.js [--force] -> swapdb/builds/<date>_<jp>_<kr>.json + public/swap.json
// Pairs JP-build language bundles with their KR-build twins by asset path, renames each KR bundle
// the way the userscript will, and keeps only pairs whose result matches the JP bundle's layout.
// Each build pair (bundle_hash.txt) gets one snapshot in swapdb/builds; when it exists already, only
// the filtering below reruns. public/swap.json is the snapshot minus pairs that
// swapdb/verdicts.json (tools/audit.py, optional) marks drop, pairs swapdb/overrides.json denies,
// and new pairs held for a look (swapdb/hold.json).
// Rule: a JP bundle shows either exactly as on the KR server or as the JP original, nothing between.
const fs = require('fs');
const path = require('path');
const MjsKr = require('./src/core.js');
const overrides = require('./tools/overrides.js');

const CDN = 'https://appstatic.mahjongsoul.com/v4';
const AB = '/resources/ab/WebGL/ASTC/';
const OUT = path.join(__dirname, 'public/swap.json');
const DB = path.join(__dirname, 'swapdb');
const AB_CACHE = path.join(__dirname, '.cache/archive/ab'); // mirror of the Oracle archive (tools/worker.sh)
const readJson = (p, dflt) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : dflt;
const CONCURRENCY = 8;
// swap.json format. Bump SWAP_FORMAT when entries change shape, and MIN_SCRIPT to the first
// userscript version that reads the new shape; older scripts (0.2.2+) then skip image swaps.
const SWAP_FORMAT = 1; // pairs: { jpName: [krName, size, pages?] }
const MIN_SCRIPT = '0.2.0';

const JP_TOKEN = /(?<![A-Za-z0-9])(jp|JP|Jp)(?![A-Za-z0-9])/g;
const toKr = p => p.replace(JP_TOKEN, t => ({ jp: 'kr', JP: 'KR', Jp: 'Kr' })[t]);

async function get(url, as = 'bytes') {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status + ' ' + url);
      return as === 'text' ? (await r.text()).trim() : new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (i >= 2) throw e;
    }
  }
}

// Bundle names carry content hashes, so a cached copy never goes stale.
async function bundle(lang, name) {
  const file = path.join(AB_CACHE, lang, name);
  if (fs.existsSync(file)) return new Uint8Array(fs.readFileSync(file));
  const bytes = await get(`${CDN}/${lang}${AB}${name}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.part', bytes);
  fs.renameSync(file + '.part', file);
  return bytes;
}

// jp bundle name -> kr bundle name, for JP bundles whose language assets all live in one KR bundle
// holding exactly the same (renamed) assets.
function pairBundles(jp, kr) {
  const byBundle = m => {
    const out = new Map();
    for (const a of m.assets) {
      const name = m.bundles[a.owner].name;
      if (!out.has(name)) out.set(name, []);
      out.get(name).push(a.path);
    }
    return out;
  };
  const jpBundles = byBundle(jp), krBundles = byBundle(kr);
  const krOwner = new Map(kr.assets.map(a => [a.path, kr.bundles[a.owner].name]));
  const jpOwner = new Map(jp.assets.map(a => [a.path, jp.bundles[a.owner].name]));
  const pairs = new Map();
  for (const [name, paths] of jpBundles) {
    if (!paths.some(p => p.match(JP_TOKEN))) continue;
    const want = paths.map(toKr);
    if (want.some((p, i) => p !== paths[i] && jpOwner.has(p))) continue; // Korean already ships in the JP build
    const owners = new Set(want.map(p => krOwner.get(p)));
    if (owners.size !== 1 || owners.has(undefined)) continue;
    const [krName] = owners;
    const have = krBundles.get(krName);
    if (have.length !== want.length || !want.every(p => have.includes(p))) continue;
    pairs.set(name, krName);
  }
  return pairs;
}

// What the JP client can reach in a bundle: asset paths, sprite and GameObject names (Lua finds
// nodes by name), object classes, and the bundles it depends on. (WebGL bundles are little-endian.)
function describe(bytes) {
  const dec = new TextDecoder();
  const objs = MjsKr.listObjects(bytes);
  const str = (d, p) => { const n = new DataView(d.buffer, d.byteOffset).getInt32(p, true); return [dec.decode(d.subarray(p + 4, p + 4 + n)), p + 4 + ((n + 3) & ~3)]; };
  const ab = MjsKr.readAssetBundle(objs.find(o => o.classId === 142).data, true);
  let [, p] = str(ab.rest, 24); // m_MainAsset (20 bytes), m_RuntimeCompatibility, m_AssetBundleName
  const deps = [];
  for (let n = new DataView(ab.rest.buffer, ab.rest.byteOffset).getInt32(p, true), i = (p += 4, 0); i < n; i++) { const [s, q] = str(ab.rest, p); deps.push(s); p = q; }
  const goName = d => str(d, 4 + new DataView(d.buffer, d.byteOffset).getInt32(0, true) * 12 + 4)[0];
  return {
    paths: new Set(ab.container.map(c => c.key)),
    sprites: new Set(objs.filter(o => o.classId === 213).map(o => str(o.data, 0)[0])),
    nodes: new Set(objs.filter(o => o.classId === 1).map(o => goName(o.data))),
    classes: new Set(objs.map(o => o.classId)),
    deps: new Set(deps),
  };
}

// Returns why `out` can't stand in for the JP bundle, or null if it can.
function mismatch(jpBytes, outBytes) {
  const jp = describe(jpBytes), out = describe(outBytes);
  for (const k of ['paths', 'sprites', 'nodes', 'classes']) {
    const lost = [...jp[k]].filter(x => !out[k].has(x));
    if (lost.length) return `${k} missing: ${lost.slice(0, 3).join(', ')}`;
  }
  const extra = [...out.deps].filter(x => !jp.deps.has(x));
  return extra.length ? `depends on KR-only bundles: ${extra.slice(0, 2).join(', ')}` : null;
}

// Container keys are lowercased; the manifest wants the original spelling of a sibling page.
function manifestPath(paths, key) {
  const stem = k => k.toLowerCase().replace(/_\d+\.png$/, '');
  const sibling = paths.find(p => /_\d+\.png$/.test(p) && stem(p) === stem(key));
  if (!sibling) throw new Error('no manifest path for ' + key);
  return sibling.replace(/_\d+\.png$/, key.match(/_\d+\.png$/)[0]);
}

// A build's manifest, from the archive when it is there (tools/worker.sh mirrors it).
async function manifest(lang, hash) {
  const file = path.join(__dirname, '.cache/archive/manifests', lang, hash + '.majset');
  return MjsKr.readManifest(fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : await get(`${CDN}/${lang}${AB}bundle_info_so.majset`));
}

// jp bundle name -> the asset paths it holds
function assetPaths(m) {
  const own = new Map();
  for (const a of m.assets) {
    const name = m.bundles[a.owner].name;
    if (!own.has(name)) own.set(name, []);
    own.get(name).push(a.path);
  }
  return own;
}

// The swap.json entry for one pair: [krName, size, pages?]. Throws when the result can't stand in
// for the JP bundle.
async function buildPair(jpName, krName, paths) {
  const [jpBytes, krBytes] = await Promise.all([bundle('jp', jpName), bundle('kr', krName)]);
  const swapped = MjsKr.swapBundle(krBytes, krName, jpName);
  const merged = MjsKr.mergeJpSprites(swapped, jpBytes);
  const out = merged ? merged.bytes : swapped;
  const why = mismatch(jpBytes, out);
  if (why) throw new Error(why);
  if (!merged) return [krName, out.length];
  return [krName, out.length, merged.pages.map(k => manifestPath(paths, k))];
}

// Validates the candidate pairs of this build pair, reusing the results of `prev` (an earlier
// snapshot): bundle names carry content hashes, so a pair seen before keeps its outcome.
async function validate(prev, jpHash, krHash) {
  const [jp, kr] = await Promise.all([manifest('jp', jpHash), manifest('kr', krHash)]);
  const pairs = [...pairBundles(jp, kr)];
  console.log(`${pairs.length} candidate pairs`);
  const jpOwn = assetPaths(jp);

  const result = {}, rejected = {};
  let next = 0;
  async function worker() {
    while (next < pairs.length) {
      const [jpName, krName] = pairs[next++];
      const old = prev.pairs[jpName];
      if (old && old[0] === krName) { result[jpName] = old; continue; }
      if (prev.rejected[jpName] && prev.rejected[jpName][0] === krName) { rejected[jpName] = prev.rejected[jpName]; continue; }
      try {
        result[jpName] = await buildPair(jpName, krName, jpOwn.get(jpName));
      } catch (e) {
        rejected[jpName] = [krName, e.message];
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const sort = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
  return { pairs: sort(result), rejected: sort(rejected) };
}

async function main() {
  const force = process.argv.includes('--force');
  const [jpHash, krHash] = await Promise.all([get(`${CDN}/jp${AB}bundle_hash.txt`, 'text'), get(`${CDN}/kr${AB}bundle_hash.txt`, 'text')]);
  const buildsDir = path.join(DB, 'builds');
  fs.mkdirSync(buildsDir, { recursive: true });
  const tag = `_${jpHash.slice(0, 8)}_${krHash.slice(0, 8)}.json`;
  const names = fs.readdirSync(buildsDir).filter(f => f.endsWith('.json')).sort();
  let snapName = names.find(f => f.endsWith(tag));
  let snap = snapName && readJson(path.join(buildsDir, snapName));
  if (!snap || force) {
    const last = names.length ? readJson(path.join(buildsDir, names[names.length - 1])) : { pairs: {}, rejected: {} };
    snap = { jp: jpHash, kr: krHash, date: new Date().toISOString().slice(0, 10), ...(await validate(force ? { pairs: {}, rejected: {} } : last, jpHash, krHash)) };
    snapName = snapName || snap.date + tag;
    fs.writeFileSync(path.join(buildsDir, snapName), JSON.stringify(snap, null, 1) + '\n');
    console.log(`wrote swapdb/builds/${snapName}: ${Object.keys(snap.pairs).length} pairs, ${Object.keys(snap.rejected).length} rejected`);
  } else {
    console.log(`builds unchanged (swapdb/builds/${snapName})`);
  }

  // Decisions: deny and drop take a pair out; a new pair whose KR image reads as English where the
  // JP one had none is held (kept JP) until someone accepts it, since that is a known way for a KR
  // asset to look wrong. Held pairs stay held across builds (swapdb/hold.json, regenerated here).
  const verdicts = readJson(path.join(DB, 'verdicts.json'), {});
  const { deny, accept } = overrides.load();
  const prevSnap = names.filter(f => f < snapName).pop();
  const before = new Set(Object.keys(prevSnap ? readJson(path.join(buildsDir, prevSnap)).pairs : snap.pairs).map(MjsKr.bundleStem));
  const wasHeld = readJson(path.join(DB, 'hold.json'), {});
  const jpOwn = assetPaths(await manifest('jp', jpHash));
  const pairs = {}, hold = {}, count = { swap: 0, drop: 0, flag: 0, unaudited: 0, denied: 0, held: 0 };
  for (const [jpName, v] of Object.entries(snap.pairs)) {
    const paths = jpOwn.get(jpName) || [];
    if (overrides.lookup(deny, jpName, paths).length) { count.denied++; continue; }
    const verdict = verdicts[`${jpName} ${v[0]}`] || { verdict: 'unaudited' };
    const key = overrides.bundleKey(paths);
    const english = overrides.openReasons(verdict, overrides.lookup(accept, jpName, paths)).filter(r => r.startsWith('english'));
    if (english.length && (!before.has(MjsKr.bundleStem(jpName)) || key in wasHeld)) {
      hold[key] = { jp: jpName, kr: v[0], reasons: english, since: (wasHeld[key] || {}).since || snap.date };
      count.held++;
      continue;
    }
    count[verdict.verdict]++;
    if (verdict.verdict !== 'drop') pairs[jpName] = v;
  }
  fs.writeFileSync(path.join(DB, 'hold.json'), JSON.stringify(hold, null, 1) + '\n');
  fs.writeFileSync(OUT, JSON.stringify({ v: SWAP_FORMAT, min: MIN_SCRIPT, jp: jpHash, kr: krHash, pairs }) + '\n');
  console.log(`wrote public/swap.json: ${Object.keys(pairs).length} pairs`, count);
  if (count.held) console.log(`  ${count.held} held (swapdb/hold.json); \`node tools/overrides.js accept KEY\` releases one`);
  if (count.unaudited) console.log('  (optional) tools/audit.py drops pairs that change nothing on screen');
}

main().catch(e => { console.error(e); process.exit(1); });
