// node swap.js [--force] -> public/swap.json
// Pairs JP-build language bundles with their KR-build twins by asset path, renames each KR bundle
// the way the userscript will, and keeps only pairs whose result matches the JP bundle's layout.
// Exits early when neither build changed since the last run (bundle_hash.txt).
const fs = require('fs');
const path = require('path');
const MjsKr = require('./src/core.js');

const CDN = 'https://appstatic.mahjongsoul.com/v4';
const AB = '/resources/ab/WebGL/ASTC/';
const OUT = path.join(__dirname, 'public/swap.json');
const CONCURRENCY = 8;

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

async function main() {
  const force = process.argv.includes('--force');
  const [jpHash, krHash] = await Promise.all([get(`${CDN}/jp${AB}bundle_hash.txt`, 'text'), get(`${CDN}/kr${AB}bundle_hash.txt`, 'text')]);
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  if (!force && prev && prev.jp === jpHash && prev.kr === krHash) {
    console.log('builds unchanged, nothing to do');
    return;
  }
  const [jp, kr] = (await Promise.all([get(`${CDN}/jp${AB}bundle_info_so.majset`), get(`${CDN}/kr${AB}bundle_info_so.majset`)])).map(MjsKr.readManifest);
  const pairs = [...pairBundles(jp, kr)];
  console.log(`${pairs.length} candidate pairs`);
  const jpOwn = new Map();
  for (const a of jp.assets) {
    const name = jp.bundles[a.owner].name;
    if (!jpOwn.has(name)) jpOwn.set(name, []);
    jpOwn.get(name).push(a.path);
  }

  // Reuse last run's verdicts: bundle names carry content hashes, so an unchanged pair stays valid.
  const known = new Map(Object.entries((prev && prev.pairs) || {}));
  const result = {}, rejected = [];
  let next = 0;
  async function worker() {
    while (next < pairs.length) {
      const [jpName, krName] = pairs[next++];
      const old = known.get(jpName);
      if (old && old[0] === krName) { result[jpName] = old; continue; }
      try {
        const [jpBytes, krBytes] = await Promise.all([get(`${CDN}/jp${AB}${jpName}`), get(`${CDN}/kr${AB}${krName}`)]);
        const swapped = MjsKr.swapBundle(krBytes, krName, jpName);
        const merged = MjsKr.mergeJpSprites(swapped, jpBytes);
        const out = merged ? merged.bytes : swapped;
        const why = mismatch(jpBytes, out);
        if (why) throw new Error(why);
        result[jpName] = merged ? [krName, out.length, merged.pages.map(k => manifestPath(jpOwn.get(jpName), k))] : [krName, out.length];
      } catch (e) {
        rejected.push(`${jpName}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const sorted = Object.fromEntries(Object.keys(result).sort().map(k => [k, result[k]]));
  fs.writeFileSync(OUT, JSON.stringify({ jp: jpHash, kr: krHash, pairs: sorted }) + '\n');
  console.log(`wrote public/swap.json: ${Object.keys(sorted).length} pairs, ${rejected.length} rejected`);
  for (const r of rejected) console.log('  rejected', r);
}

main().catch(e => { console.error(e); process.exit(1); });
