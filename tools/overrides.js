// swapdb/overrides.json: what a person decided about pairs. Keys are asset paths from the JP manifest
// (a folder like "MyAssets/ui/entrance/pic/jp" or one file), so they survive the game renaming its
// bundles; a key covers every JP bundle holding an asset at or under it. Old keys that are a bundle
// stem (bundle name minus hash) still work; `migrate` rewrites them.
//   deny:   { key: reason }              keep these JP bundles as they are
//   accept: { key: { item: krDHash } }   audit flags someone looked at and found fine. An accepted
//                                        item counts only while the KR image keeps that look, so a
//                                        redrawn image gets flagged again.
//
// node tools/overrides.js                    list entries and what they match in the latest build
// node tools/overrides.js migrate            stem keys -> asset path keys
// node tools/overrides.js deny KEY REASON    KEY: asset path, folder or stem
// node tools/overrides.js accept KEY [ITEM…] accept the flagged items (or the given ones) as they look now
const fs = require('fs');
const path = require('path');
const MjsKr = require('../src/core.js');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'swapdb/overrides.json');
const ARCHIVE = path.join(ROOT, '.cache/archive');
const LOOK = 6; // dHash bits that may differ for an image to keep its look (same as tools/drift.js)
const readJson = (p, dflt) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : dflt;

const load = () => ({ deny: {}, accept: {}, ...readJson(FILE, {}) });
const save = o => fs.writeFileSync(FILE, JSON.stringify(o, null, 1) + '\n');

const isStem = key => !key.includes('/');

// Does `key` cover the JP bundle `name` holding `paths`?
function covers(key, name, paths) {
  if (isStem(key)) return MjsKr.bundleStem(name) === key;
  const k = key.toLowerCase().replace(/\/$/, '');
  return paths.some(p => { p = p.toLowerCase(); return p === k || p.startsWith(k + '/'); });
}

// The entries of one section that cover a bundle: [[key, value], …]
const lookup = (section, name, paths) => Object.entries(section || {}).filter(([k]) => covers(k, name, paths));

// The key a person would write for a bundle: the folder all its assets share (or its one asset).
function bundleKey(paths) {
  if (paths.length === 1) return paths[0];
  const split = paths.map(p => p.split('/'));
  const out = [];
  for (let i = 0; split.every(s => i < s.length - 1 && s[i] === split[0][i]); i++) out.push(split[0][i]);
  return out.join('/') || paths[0];
}

const hamming = (a, b) => { let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0; for (; x; x &= x - 1n) n++; return n; };

// The audit reasons ("english sprite:foo") of a verdict that `accept` doesn't settle.
function openReasons(verdict, accepted) {
  if (!verdict) return [];
  return (verdict.reasons || []).filter(r => {
    const item = r.slice(r.indexOf(' ') + 1), it = verdict.items && verdict.items[item];
    const ok = accepted.map(([, v]) => v[item]).filter(Boolean);
    return !(it && it.dhash && ok.some(h => hamming(h, it.dhash[1]) <= LOOK));
  });
}

module.exports = { load, covers, lookup, bundleKey, openReasons, isStem };

// --- CLI ---

function latest() {
  const dir = path.join(ROOT, 'swapdb/builds');
  const snap = readJson(path.join(dir, fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().pop()));
  const file = path.join(ARCHIVE, 'manifests/jp', snap.jp + '.majset');
  if (!fs.existsSync(file)) throw new Error('jp manifest of the latest build not archived: ' + file);
  const m = MjsKr.readManifest(new Uint8Array(fs.readFileSync(file)));
  const owner = new Map();
  for (const a of m.assets) {
    const n = m.bundles[a.owner].name;
    if (!owner.has(n)) owner.set(n, []);
    owner.get(n).push(a.path);
  }
  return { snap, owner };
}

// Bundles a key names: a stem, a path or folder.
function resolve(key, owner) {
  return [...owner].filter(([n, ps]) => covers(key, n, ps)).map(([n]) => n);
}

function main() {
  const [cmd, key, ...rest] = process.argv.slice(2);
  const o = load();
  const { snap, owner } = latest();
  if (!cmd) {
    for (const sec of ['deny', 'accept']) for (const [k, v] of Object.entries(o[sec])) {
      const hit = resolve(k, owner);
      console.log(`${sec} ${k}${isStem(k) ? ' (stem 키)' : ''}: ${hit.length ? hit.length + '개 번들' : '이번 빌드에 맞는 번들 없음'}  ${typeof v === 'string' ? v : Object.keys(v).join(', ')}`);
    }
    return;
  }
  if (cmd === 'migrate') {
    let n = 0;
    for (const sec of ['deny', 'accept']) {
      const out = {};
      for (const [k, v] of Object.entries(o[sec])) {
        const hit = isStem(k) ? resolve(k, owner) : [];
        const nk = hit.length === 1 ? bundleKey(owner.get(hit[0])) : k;
        if (nk !== k) { console.log(`${sec} ${k} -> ${nk}`); n++; }
        else if (isStem(k)) console.log(`${sec} ${k}: 이번 빌드에 없어 그대로 둠`);
        out[nk] = v;
      }
      o[sec] = out;
    }
    save(o);
    console.log(`${n}개 바꿈`);
    return;
  }
  if (!key) throw new Error('KEY가 필요함');
  const hit = resolve(key, owner);
  if (!hit.length) throw new Error(`${key}: 최신 빌드(jp ${snap.jp.slice(0, 8)})에 맞는 번들이 없음`);
  const k = isStem(key) && hit.length === 1 ? bundleKey(owner.get(hit[0])) : key;
  if (cmd === 'deny') {
    o.deny[k] = rest.join(' ') || '이유 없음';
  } else if (cmd === 'accept') {
    const verdicts = readJson(path.join(ROOT, 'swapdb/verdicts.json'), {});
    const items = {};
    for (const n of hit) {
      const pair = snap.pairs[n], v = pair && verdicts[`${n} ${pair[0]}`];
      if (!v) continue;
      const want = rest.length ? rest : v.reasons.map(r => r.slice(r.indexOf(' ') + 1));
      for (const it of want) if (v.items[it] && v.items[it].dhash) items[it] = v.items[it].dhash[1];
    }
    if (!Object.keys(items).length) throw new Error('받아들일 감사 항목이 없음 (플래그가 없거나 감사 전)');
    o.accept[k] = { ...(o.accept[k] || {}), ...items };
  } else {
    throw new Error('모르는 명령: ' + cmd);
  }
  save(o);
  console.log(`${cmd} ${k}: ${hit.length}개 번들`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
