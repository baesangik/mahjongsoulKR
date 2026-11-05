// node tools/canary.js [--hash JP_BUNDLE_HASH]   (default: the jp build of the latest snapshot)
// Checks a JP build for what the text patch relies on, before anyone runs it in a browser:
// the manifest parses, GameMgr.lua can be found, decrypted and patched with src/inject.lua, the
// functions inject.lua wraps still exist, and the Korean font group ships. Runs on the archive
// (tools/watch.js on Oracle calls it right after archiving; tools/worker.sh runs it again at home).
// Writes canary/<hash>.json and keeps the decrypted Lua it looked at under lua/<Module>/<sha8>.lua,
// so a change to LangMgr.lua & co. can be diffed later (tools/drift.js). Exit 1 when a check fails.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const MjsKr = require('../src/core.js');

const dec = new TextDecoder();
const sha8 = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);

// What src/inject.lua touches, per module. `wrap` accepts both Mod.Init and Mod:Init.
const MODULES = {
  GameMgr: [/function\s+GameMgr[.:]Init\s*\(/, /prefer_language/, /client_language/, /LoadGroup/],
  LangMgr: [/function\s+LangMgr[.:]Init\s*\(/, /prefer_language/, /is_cn_lang/, /is_alphabet_lang/],
  UIMgr: [/function\s+UIMgr[.:]Init\s*\(/],
};
const FONT = 'MyAssets/fonts/kr/kr.ttf'; // inject.lua: LoadGroup('fonts/kr'), LoadFont('kr/kr.ttf')

function decrypt(script, mod) {
  const tail = new RegExp(`return\\s+${mod}\\s*$`);
  const key = MjsKr.findKey(script, d => tail.test(dec.decode(d.subarray(Math.max(0, d.length - 64)))));
  return key ? dec.decode(MjsKr.xor(script, key)) : null;
}

// manifestBytes: bundle_info_so.majset. bundle(name) -> bytes of an archived bundle.
// Returns { ok, problems, lua: { Module: { sha, bundle } }, sources: { Module: text } }.
function check(manifestBytes, bundle, injectLua) {
  const problems = [], lua = {}, sources = {};
  let m;
  try { m = MjsKr.readManifest(manifestBytes); } catch (e) { m = null; }
  if (!m) return { ok: false, problems: ['manifest not readable (format changed?)'], lua, sources };
  if (m.bundles.length < 1000 || m.assets.length < 1000) problems.push(`manifest looks thin: ${m.bundles.length} bundles, ${m.assets.length} assets`);
  if (!m.assets.some(a => a.path === FONT)) problems.push(`${FONT} not in manifest`);
  for (const [mod, needs] of Object.entries(MODULES)) {
    const hit = m.assets.find(a => a.path.toLowerCase().endsWith(`/${mod}.lua.bytes`.toLowerCase()));
    if (!hit) { problems.push(`${mod}.lua not in manifest`); continue; }
    const name = m.bundles[hit.owner].name;
    let bytes;
    try { bytes = bundle(name); } catch (e) { problems.push(`${mod}.lua: bundle ${name} not archived`); continue; }
    const script = MjsKr.extractLua(bytes, `${mod}.lua`);
    const src = script && decrypt(script, mod);
    if (!src) { problems.push(`${mod}.lua: ${script ? 'XOR key not found' : 'TextAsset not found'} in ${name}`); continue; }
    sources[mod] = src;
    lua[mod] = { sha: sha8(src), bundle: name };
    for (const re of needs) if (!re.test(src)) problems.push(`${mod}.lua: no ${re.source}`);
    if (mod === 'GameMgr') {
      // Exactly what the userscript does to this bundle.
      try {
        const patched = MjsKr.patchLuaBundle(bytes, 'GameMgr.lua', injectLua);
        const back = patched && decrypt(MjsKr.extractLua(patched, 'GameMgr.lua'), mod);
        if (!back || !back.includes(injectLua.trim().split('\n')[0])) problems.push('GameMgr.lua: patch did not round-trip');
      } catch (e) {
        problems.push('GameMgr.lua: patch failed: ' + e.message);
      }
    }
  }
  return { ok: !problems.length, problems, lua, sources };
}

// Runs check() on an archived build and records it there.
function run(archive, hash, injectLua) {
  const mfile = path.join(archive, 'manifests/jp', hash + '.majset');
  if (!fs.existsSync(mfile)) throw new Error('manifest not archived: ' + mfile);
  const r = check(new Uint8Array(fs.readFileSync(mfile)), name => new Uint8Array(fs.readFileSync(path.join(archive, 'ab/jp', name))), injectLua);
  for (const [mod, src] of Object.entries(r.sources)) {
    const file = path.join(archive, 'lua', mod, r.lua[mod].sha + '.lua');
    if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, src); }
  }
  const out = { hash, at: new Date().toISOString(), ok: r.ok, problems: r.problems, lua: r.lua };
  fs.mkdirSync(path.join(archive, 'canary'), { recursive: true });
  fs.writeFileSync(path.join(archive, 'canary', hash + '.json'), JSON.stringify(out, null, 1) + '\n');
  return out;
}

module.exports = { check, run };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const archive = process.env.MJSKR_ARCHIVE || path.join(root, '.cache/archive');
  const i = process.argv.indexOf('--hash');
  let hash = i > 0 ? process.argv[i + 1] : null;
  if (!hash) {
    const builds = path.join(root, 'swapdb/builds');
    hash = JSON.parse(fs.readFileSync(path.join(builds, fs.readdirSync(builds).filter(f => f.endsWith('.json')).sort().pop()), 'utf8')).jp;
  }
  const out = run(archive, hash, fs.readFileSync(path.join(root, 'src/inject.lua'), 'utf8'));
  console.log(`canary jp ${hash.slice(0, 8)}: ${out.ok ? 'ok' : 'FAIL'}`, JSON.stringify(out.lua));
  for (const p of out.problems) console.log('  ' + p);
  process.exit(out.ok ? 0 : 1);
}
