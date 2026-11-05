// node tools/gate.js [--drift FILE]   -> exit 0 publishable, 2 not
// Decides whether public/swap.json may go out without a human looking first:
//   - it is for the build the CDN serves right now, and every KR bundle it names is there
//   - tools/drift.js (--json) found no sign of a restructure, and the canary passed
//   - the userscript sources are committed, so a deploy ships nothing half-edited
// Anything only worth a look (flags, new rejects, orphan deny entries) doesn't block.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CDN = 'https://appstatic.mahjongsoul.com/v4';
const AB = '/resources/ab/WebGL/ASTC/';
const ARCHIVE = path.join(ROOT, '.cache/archive');
const readJson = (p, dflt) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : dflt;

async function exists(url) {
  for (let i = 0; i < 3; i++) {
    try { return (await fetch(url, { method: 'HEAD' })).status; } catch (e) { if (i === 2) return 'error ' + e.message; }
  }
}

async function main() {
  const block = [];
  const swap = readJson(path.join(ROOT, 'public/swap.json'), null);
  if (!swap) block.push('public/swap.json 없음');
  else {
    if (swap.v === undefined) block.push('swap.json에 v(형식 버전)가 없음');
    if (!Object.keys(swap.pairs || {}).length) block.push('swap.json에 짝이 없음');
    const now = Object.fromEntries(await Promise.all(['jp', 'kr'].map(async l => [l, (await (await fetch(`${CDN}/${l}${AB}bundle_hash.txt`, { cache: 'no-store' })).text()).trim()])));
    for (const l of ['jp', 'kr']) if (swap[l] !== now[l]) block.push(`swap.json은 ${l} ${String(swap[l]).slice(0, 8)}용인데 CDN은 이미 ${now[l].slice(0, 8)}`);
    const kr = Object.values(swap.pairs || {}).map(v => v[0]);
    const missing = [];
    for (let i = 0; i < kr.length; i += 16) {
      const st = await Promise.all(kr.slice(i, i + 16).map(n => exists(`${CDN}/kr${AB}${encodeURIComponent(n)}`)));
      st.forEach((s, j) => { if (s !== 200) missing.push(`${kr[i + j]} (${s})`); });
    }
    if (missing.length) block.push(`CDN에 없는 KR 번들 ${missing.length}개: ${missing.slice(0, 3).join(', ')}`);
    const canary = readJson(path.join(ARCHIVE, 'canary', swap.jp + '.json'), null);
    if (!canary) block.push('이 빌드의 canary 결과 없음');
    else if (!canary.ok) block.push('canary 실패');
  }
  const i = process.argv.indexOf('--drift');
  if (i > 0) {
    const d = readJson(process.argv[i + 1], null);
    if (!d) block.push('drift 결과 없음');
    else for (const b of d.block) if (!b.startsWith('canary')) block.push(b);
  }
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'build.js', 'public', 'package.json', 'wrangler.jsonc'], { cwd: ROOT }).toString().split('\n').filter(Boolean).map(l => l.slice(3));
  if (dirty.length) block.push('커밋 안 된 변경이 있음: ' + dirty.join(', '));

  if (block.length) {
    console.log('게시 안 함:');
    for (const b of block) console.log('- ' + b);
    process.exit(2);
  }
  console.log(`게시 가능: ${Object.keys(swap.pairs).length}개 짝, jp ${swap.jp.slice(0, 8)} kr ${swap.kr.slice(0, 8)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
