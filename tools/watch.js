// node tools/watch.js [--force]   (runs on the Oracle box every 15 minutes, see tools/oracle/)
// Polls jp/kr bundle_hash.txt. When either changes, keeps the build's manifests and every language
// bundle it lists in the archive, logs the build to builds.jsonl and queues a job for the home PC
// (tools/worker.sh), which does the CPU-heavy part. Bundle names carry content hashes, so archived
// files are never overwritten; each build only adds the bundles that changed.
//
// $MJSKR_ARCHIVE (default ~/mjskr-archive):
//   state.json                      last build pair seen
//   builds.jsonl                    one line per build pair change
//   manifests/<lang>/<hash>.majset  bundle_info_so.majset of each build
//   ab/<lang>/<bundle>              language bundles (same layout as the home .cache/archive/ab)
//   queue/<jp8>_<kr8>.json          builds the home PC hasn't processed yet
const fs = require('fs');
const os = require('os');
const path = require('path');
const MjsKr = require('../src/core.js');

const CDN = 'https://appstatic.mahjongsoul.com/v4';
const AB = '/resources/ab/WebGL/ASTC/';
const ARCHIVE = process.env.MJSKR_ARCHIVE || path.join(os.homedir(), 'mjskr-archive');
const LANGS = ['jp', 'kr'];
const CONCURRENCY = 4;
// Bundles worth keeping: language folders, plus the Lua the text patch hooks into.
const KEEP = /(?<![A-Za-z0-9])(jp|kr)(?![A-Za-z0-9])|\/GameMgr\.lua|\/LangMgr\.lua|localizedImg_/i;

const readJson = (p, dflt) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : dflt;

async function get(url, as = 'bytes') {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status + ' ' + url);
      return as === 'text' ? (await r.text()).trim() : new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (i >= 2) throw e;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

// UnityFS header: signature, u32 format, version, revision (NUL-terminated), then i64 total size (big-endian).
function truncated(data) {
  const dec = new TextDecoder();
  let p = 0;
  const cstr = () => { const e = data.indexOf(0, p); const s = dec.decode(data.subarray(p, e)); p = e + 1; return s; };
  if (cstr() !== 'UnityFS') return 'not a UnityFS bundle';
  p += 4; cstr(); cstr();
  const size = Number(new DataView(data.buffer, data.byteOffset).getBigInt64(p));
  return size === data.length ? null : `${data.length} bytes, header says ${size}`;
}

// Writes via a temp file so an interrupted run never leaves a truncated bundle under its real name.
function writeOnce(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.part', bytes);
  fs.renameSync(file + '.part', file);
}

async function archiveBuild(lang, hash) {
  const mfile = path.join(ARCHIVE, 'manifests', lang, hash + '.majset');
  const raw = fs.existsSync(mfile) ? fs.readFileSync(mfile) : await get(`${CDN}/${lang}${AB}bundle_info_so.majset`);
  const m = MjsKr.readManifest(new Uint8Array(raw));
  if (!m) throw new Error(`${lang}: manifest not readable`);
  const want = [...new Set(m.assets.filter(a => KEEP.test(a.path)).map(a => m.bundles[a.owner]))];
  const missing = want.filter(b => !fs.existsSync(path.join(ARCHIVE, 'ab', lang, b.name)));
  let next = 0, bytes = 0;
  async function worker() {
    while (next < missing.length) {
      const b = missing[next++];
      const data = await get(`${CDN}/${lang}${AB}${b.name}`);
      // fileSize in the manifest doesn't always match the file, so check against the bundle's own header.
      const why = truncated(data);
      if (why) throw new Error(`${lang}/${b.name}: ${why}`);
      writeOnce(path.join(ARCHIVE, 'ab', lang, b.name), data);
      bytes += data.length;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  // The manifest goes in last: its presence marks the build as fully archived.
  if (!fs.existsSync(mfile)) writeOnce(mfile, raw);
  return { bundles: m.bundles.length, language: want.length, fetched: missing.length, bytes };
}

async function main() {
  const force = process.argv.includes('--force');
  const hashes = Object.fromEntries(await Promise.all(LANGS.map(async l => [l, await get(`${CDN}/${l}${AB}bundle_hash.txt`, 'text')])));
  for (const [l, h] of Object.entries(hashes)) if (!/^[0-9a-f]{40}$/.test(h)) throw new Error(`${l}: odd bundle_hash ${JSON.stringify(h.slice(0, 60))}`);
  const statePath = path.join(ARCHIVE, 'state.json');
  const state = readJson(statePath, {});
  if (!force && LANGS.every(l => state[l] === hashes[l])) return;

  // The manifest can lag bundle_hash.txt on the CDN for a moment; archive what it says and let
  // the next run catch up if the hash moves again.
  const stats = {};
  for (const l of LANGS) stats[l] = await archiveBuild(l, hashes[l]);
  const at = new Date().toISOString();
  const entry = { at, ...hashes, prev: { jp: state.jp || null, kr: state.kr || null }, stats };
  fs.appendFileSync(path.join(ARCHIVE, 'builds.jsonl'), JSON.stringify(entry) + '\n');
  const job = `${hashes.jp.slice(0, 8)}_${hashes.kr.slice(0, 8)}.json`;
  writeOnce(path.join(ARCHIVE, 'queue', job), JSON.stringify(entry, null, 1) + '\n');
  writeOnce(statePath, JSON.stringify({ ...hashes, at }, null, 1) + '\n');
  console.log(`build jp ${hashes.jp.slice(0, 8)} kr ${hashes.kr.slice(0, 8)}:`, JSON.stringify(stats), '-> queue/' + job);
}

main().catch(e => { console.error(e); process.exit(1); });
