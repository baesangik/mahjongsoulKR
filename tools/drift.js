// node tools/drift.js [--out FILE] [--json FILE]
// Compares the latest swapdb/builds snapshot with the one before and writes a Markdown report:
// which pairs stayed, changed, appeared, went away or newly failed validation, what the audit
// flagged among the new ones, and where things moved. Moves are traced through the image archive
// (tools/imgindex.py): a JP language bundle that vanished and one that appeared holding the same
// pixels are the same asset under a new path, and a deny entry that no longer matches anything
// is looked up the same way. Nothing is changed; the report only suggests.
// It also checks the pairing rule against the game's own list of localized images (tools/langcheck.js).
// --json writes { block, attention }: `block` lists signs that the game was restructured (the
// canary failed, most pairs or JP language bundles vanished, localizedImg stopped resolving to jp/
// folders); tools/gate.js won't publish then.
const fs = require('fs');
const path = require('path');
const MjsKr = require('../src/core.js');
const ov = require('./overrides.js');
const langcheck = require('./langcheck.js');

const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'swapdb');
const ARCHIVE = path.join(ROOT, '.cache/archive');
const LANG = /(?<![A-Za-z0-9])jp(?![A-Za-z0-9])/i;
const LOOK = 6; // dHash bits that may differ for two images to count as the same look
const readJson = (p, dflt) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : dflt;
const stem = MjsKr.bundleStem;
const { execFileSync } = require('child_process');

// --- archive access ---

const manifests = new Map(); // `${lang}/${hash}` -> { owner: Map(bundle -> paths) } | null
function manifest(lang, hash) {
  const key = `${lang}/${hash}`;
  if (!manifests.has(key)) {
    const file = path.join(ARCHIVE, 'manifests', lang, hash + '.majset');
    let m = null;
    if (fs.existsSync(file)) {
      const raw = MjsKr.readManifest(new Uint8Array(fs.readFileSync(file)));
      const owner = new Map();
      for (const a of raw.assets) {
        const name = raw.bundles[a.owner].name;
        if (!owner.has(name)) owner.set(name, []);
        owner.get(name).push(a.path);
      }
      m = { owner };
    }
    manifests.set(key, m);
  }
  return manifests.get(key);
}

// Every archived jp manifest, for finding which old bundle had a given stem.
function allJpManifests() {
  const dir = path.join(ARCHIVE, 'manifests/jp');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.majset')).map(f => manifest('jp', f.slice(0, -7))) : [];
}

const indexes = new Map(); // `${lang}/${bundle}` -> index | null
function index(lang, name) {
  const key = `${lang}/${name}`;
  if (!indexes.has(key)) indexes.set(key, readJson(path.join(ARCHIVE, 'index', lang, name + '.json'), null));
  return indexes.get(key);
}

// sha -> [{ lang, name, key }] over the whole archive
let shaMap = null;
function bySha() {
  if (shaMap) return shaMap;
  shaMap = new Map();
  for (const lang of ['jp', 'kr']) {
    const dir = path.join(ARCHIVE, 'index', lang);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const name = f.slice(0, -5), idx = index(lang, name);
      for (const [key, it] of Object.entries(idx.items || {})) {
        if (!shaMap.has(it.sha)) shaMap.set(it.sha, []);
        shaMap.get(it.sha).push({ lang, name, key });
      }
    }
  }
  return shaMap;
}

const hamming = (a, b) => { let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0; for (; x; x &= x - 1n) n++; return n; };

// How much of `a`'s images `b` holds: exact pixels first, then same look.
function overlap(a, b) {
  const ia = Object.values(a.items || {}), ib = Object.values(b.items || {});
  if (!ia.length || !ib.length) return { exact: 0, look: 0, of: ia.length };
  const shas = new Set(ib.map(x => x.sha));
  let exact = 0, look = 0;
  for (const x of ia) {
    if (shas.has(x.sha)) exact++;
    else if (ib.some(y => hamming(x.dhash, y.dhash) <= LOOK)) look++;
  }
  return { exact, look, of: ia.length };
}

// --- formatting ---

function commonDir(paths) {
  if (!paths || !paths.length) return '?';
  const split = paths.map(p => p.split('/'));
  const out = [];
  for (let i = 0; split.every(s => i < s.length - 1 && s[i] === split[0][i]); i++) out.push(split[0][i]);
  return out.length ? out.join('/') + (paths.length > 1 ? `/ (${paths.length})` : '/' + split[0][split[0].length - 1]) : paths[0];
}
const where = (m, name) => '`' + commonDir(m && m.owner.get(name)) + '`';

// --- report ---

function main() {
  const names = fs.readdirSync(path.join(DB, 'builds')).filter(f => f.endsWith('.json')).sort();
  if (!names.length) throw new Error('no snapshots in swapdb/builds');
  const cur = readJson(path.join(DB, 'builds', names[names.length - 1]));
  const prev = names.length > 1 ? readJson(path.join(DB, 'builds', names[names.length - 2])) : null;
  const verdicts = readJson(path.join(DB, 'verdicts.json'), {});
  const overrides = readJson(path.join(DB, 'overrides.json'), {});
  const curJp = manifest('jp', cur.jp), prevJp = prev && manifest('jp', prev.jp);

  const lines = [], attention = [], block = [];
  const say = (...l) => lines.push(...l);
  say(`# 드리프트 리포트: ${names[names.length - 1].replace(/\.json$/, '')}`, '');
  say(`- jp \`${prev ? prev.jp.slice(0, 8) : '-'}\` → \`${cur.jp.slice(0, 8)}\`, kr \`${prev ? prev.kr.slice(0, 8) : '-'}\` → \`${cur.kr.slice(0, 8)}\``);
  if (!prev) say('- 이전 스냅샷이 없어 이 빌드를 기준으로만 기록함');
  if (!curJp) say('- 이 빌드의 jp 매니페스트가 보관소에 없어 경로·역추적 일부를 건너뜀');
  const headLen = lines.length;

  // Pairs: kept, updated, new, gone, newly rejected
  const pp = prev ? prev.pairs : {}, pr = prev ? prev.rejected : {};
  const prevByStem = new Map(Object.keys(pp).map(n => [stem(n), n]));
  const curStems = new Set(Object.keys(cur.pairs).map(stem));
  const kept = [], updated = [], added = [];
  for (const [jp, v] of Object.entries(cur.pairs)) {
    const old = prevByStem.get(stem(jp));
    if (!old) added.push(jp);
    else if (old === jp && pp[old][0] === v[0]) kept.push(jp);
    else updated.push(jp);
  }
  const gone = [...prevByStem.entries()].filter(([s]) => !curStems.has(s)).map(([, n]) => n);
  const prevRejStems = new Map(Object.entries(pr).map(([n, v]) => [stem(n), v[1]]));
  const newRej = !prev ? [] : Object.entries(cur.rejected).filter(([n, v]) => prevRejStems.get(stem(n)) !== v[1]);
  say('', '## 짝', '', `유지 ${kept.length} · 갱신 ${updated.length} · 신규 ${added.length} · 사라짐 ${gone.length} · 새 거부 ${newRej.length} (전체 ${Object.keys(cur.pairs).length}, 거부 ${Object.keys(cur.rejected).length})`);
  if (prev && Object.keys(pp).length && Object.keys(cur.pairs).length < Object.keys(pp).length * 0.5)
    block.push(`짝 수가 절반 아래로 줄었음 (${Object.keys(pp).length} → ${Object.keys(cur.pairs).length}): 언어 폴더 규칙이 바뀌었을 수 있다`);
  const list = (title, items, fmt) => { if (items.length) say('', `### ${title}`, '', ...items.slice(0, 60).map(fmt), ...(items.length > 60 ? [`- … 외 ${items.length - 60}`] : [])); };
  if (prev) {
    list('신규', added, n => `- ${where(curJp, n)} \`${stem(n)}\``);
    list('사라짐', gone, n => `- ${where(prevJp, n)} \`${stem(n)}\``);
    list('갱신', updated, n => `- ${where(curJp, n)}`);
  }
  list('새 거부', newRej, ([n, v]) => `- ${where(curJp, n)}: ${v[1]}`);
  if (newRej.length) attention.push(`검증에서 새로 떨어진 짝 ${newRej.length}개`);

  // Audit results for what is new to this build
  const fresh = prev ? [...added, ...updated] : Object.keys(cur.pairs);
  const flagged = fresh.map(n => [n, verdicts[`${n} ${cur.pairs[n][0]}`]]).filter(([, v]) => !v || v.verdict === 'flag');
  say('', '## 감사 (이번에 새로 들어오거나 바뀐 짝)', '');
  if (!flagged.length) say('플래그 없음');
  const pathsOf = n => (curJp && curJp.owner.get(n)) || [];
  const hold = readJson(path.join(DB, 'hold.json'), {});
  const held = new Set(Object.values(hold).map(h => h.jp));
  const decided = n => ov.lookup(overrides.deny, n, pathsOf(n)).length > 0 || (verdicts[`${n} ${cur.pairs[n][0]}`] && !ov.openReasons(verdicts[`${n} ${cur.pairs[n][0]}`], ov.lookup(overrides.accept, n, pathsOf(n))).length);
  for (const [n, v] of flagged) say(`- ${where(curJp, n)} \`${stem(n)}\`: ${v ? v.reasons.join(', ') : '감사 안 됨'}${decided(n) ? ' (overrides에서 처리함)' : held.has(n) ? ' (보류 중)' : ''}`);
  const open = flagged.filter(([n]) => !decided(n) && !held.has(n)).length;
  if (open) attention.push(`처리 안 된 플래그·미감사 ${open}개`);
  const holds = Object.entries(hold);
  if (holds.length) {
    say('', `### 보류 (JP로 둠, swapdb/hold.json)`, '', ...holds.map(([k, h]) => `- \`${k}\` (${h.since}부터): ${h.reasons.join(', ')} → 괜찮으면 \`node tools/overrides.js accept "${k}"\`, 아니면 \`deny\``));
    attention.push(`보류 중인 짝 ${holds.length}개`);
  }

  // JP language bundles that vanished / appeared, traced by image
  if (prevJp && curJp) {
    const langBundles = m => new Map([...m.owner].filter(([, ps]) => ps.some(p => LANG.test(p))).map(([n, ps]) => [stem(n), n]));
    const before = langBundles(prevJp), after = langBundles(curJp);
    const vanished = [...before].filter(([s]) => !after.has(s)).map(([, n]) => n);
    const appeared = [...after].filter(([s]) => !before.has(s)).map(([, n]) => n);
    say('', '## JP 언어 번들 이동 (이미지 역추적)', '', `사라짐 ${vanished.length} · 새로 생김 ${appeared.length}`);
    const matched = new Set();
    for (const old of vanished) {
      const oi = index('jp', old);
      if (!oi || !Object.keys(oi.items || {}).length) continue;
      let best = null;
      for (const neu of appeared) {
        const ni = index('jp', neu);
        if (!ni) continue;
        const o = overlap(oi, ni), score = (o.exact + o.look) / o.of;
        if (score >= 0.5 && (!best || score > best.score)) best = { neu, score, ...o };
      }
      if (best) {
        matched.add(best.neu);
        say(`- 이동: ${where(prevJp, old)} → ${where(curJp, best.neu)} (이미지 ${best.of}개 중 같은 픽셀 ${best.exact}, 같은 모양 ${best.look}) \`${stem(old)}\` → \`${stem(best.neu)}\``);
      } else {
        say(`- 사라짐: ${where(prevJp, old)} (닮은 새 번들 없음)`);
      }
    }
    // Brand-new bundles: are their images reused from somewhere already archived?
    const sm = bySha();
    for (const neu of appeared.filter(n => !matched.has(n))) {
      const ni = index('jp', neu);
      if (!ni) { say(`- 새로 생김: ${where(curJp, neu)} (색인 없음)`); continue; }
      const items = Object.values(ni.items || {});
      const seen = items.map(it => (sm.get(it.sha) || []).find(h => h.name !== neu)).filter(Boolean);
      const from = [...new Set(seen.map(h => h.name))].slice(0, 2).map(n => where(manifestOf(n), n)).join(', ');
      say(`- 새로 생김: ${where(curJp, neu)} (이미지 ${items.length}개${seen.length ? `, 그중 ${seen.length}개는 보관소에 이미 있음: ${from}` : ''})`);
    }
    if (vanished.length > Math.max(20, before.size * 0.2)) block.push(`JP 언어 번들 ${vanished.length}개가 사라짐: 경로 개편일 수 있다`);
  }

  // Overrides that no longer match, with suggestions traced by image
  say('', '## overrides 점검', '');
  const curByStem = curJp ? new Map([...curJp.owner.keys()].map(n => [stem(n), n])) : new Map();
  const oldBundle = s => { for (const m of allJpManifests()) for (const n of m ? m.owner.keys() : []) if (stem(n) === s && index('jp', n)) return n; return null; };
  let orphans = 0;
  for (const sec of ['deny', 'accept']) for (const k of Object.keys(overrides[sec] || {})) {
    if (!curJp || [...curJp.owner].some(([n, ps]) => ov.covers(k, n, ps))) {
      if (curJp && ov.isStem(k)) say(`- ${sec} \`${k}\`: 옛 stem 키 → \`node tools/overrides.js migrate\``);
      continue;
    }
    orphans++;
    // The bundle the key used to match, in an older build, traced to where its images went.
    let old = null;
    for (const m of allJpManifests()) for (const [n, ps] of m ? m.owner : []) if (!old && ov.covers(k, n, ps) && index('jp', n)) old = n;
    let hint = '예전 번들 색인 없음';
    if (old) {
      let best = null;
      for (const [n] of curJp.owner) {
        const ni = index('jp', n);
        if (!ni || !LANG.test((curJp.owner.get(n) || [])[0] || '')) continue;
        const o = overlap(index('jp', old), ni), score = o.of ? (o.exact + o.look) / o.of : 0;
        if (score >= 0.5 && (!best || score > best.score)) best = { n, score };
      }
      hint = best ? `옮겨 간 곳으로 보임: \`${ov.bundleKey(curJp.owner.get(best.n))}\`` : '닮은 번들 없음';
    }
    say(`- ${sec} \`${k}\` 가 이번 빌드에 없음 → ${hint}`);
  }
  if (!orphans) say('모두 이번 빌드에 맞음');
  else attention.push(`맞는 데가 없는 overrides ${orphans}개`);

  // The pairing rule against the game's own list of localized images
  say('', '## 언어 규칙 교차검증 (localizedImg_jp)', '');
  const lc = langcheck.check(cur, ARCHIVE), lcPrev = prev && langcheck.check(prev, ARCHIVE);
  if (!lc) say('이 빌드의 매니페스트가 보관소에 없음');
  else if (lc.missing) { say('localizedImg_jp.json을 못 찾음'); attention.push('localizedImg_jp.json이 없어짐 (언어 이미지 목록 형식이 바뀌었을 수 있다)'); }
  else {
    const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '-';
    say(`언어 항목 ${lc.entries}개 중 jp 폴더로 풀림 ${lc.resolved} (${pct(lc.resolved, lc.entries)}), 짝 있는 번들에 듦 ${lc.covered} (${pct(lc.covered, lc.resolved)})` +
      (lcPrev && !lcPrev.missing ? ` — 이전 빌드 ${lcPrev.resolved} / ${lcPrev.covered}` : ''));
    if (lc.resolved < lc.entries * 0.5) block.push(`localizedImg 항목이 jp 폴더로 거의 안 풀림 (${lc.resolved}/${lc.entries}): 언어 폴더 규칙이 바뀌었을 수 있다`);
    if (lcPrev && !lcPrev.missing && lc.covered < lcPrev.covered * 0.7) block.push(`localizedImg 기준 커버리지 급락 (${lcPrev.covered} → ${lc.covered})`);
    const was = new Set(lcPrev && !lcPrev.missing ? lcPrev.unpaired.map(u => stem(u.name)) : []);
    const fresh = lc.unpaired.filter(u => !was.has(stem(u.name)));
    const groups = {};
    for (const u of lc.unpaired) (groups[u.why.replace(/:.*/, '')] ||= []).push(u);
    for (const [why, us] of Object.entries(groups)) {
      const n = us.reduce((a, u) => a + u.entries, 0);
      say(`- ${why}: 번들 ${us.length}개, 항목 ${n}개${why === 'KR 빌드에 kr 버전 없음' ? ' (JP 전용 콘텐츠, 정상)' : ''}`);
      if (why !== 'KR 빌드에 kr 버전 없음') for (const u of us.slice(0, 20)) say(`  - ${where(curJp, u.name)} 항목 ${u.entries}: ${u.why}`);
    }
    if (prev && fresh.length) {
      say('', '### 이번에 새로 짝 없는 언어 번들', '', ...fresh.slice(0, 40).map(u => `- ${where(curJp, u.name)}: ${u.why}`));
      if (fresh.some(u => u.why !== 'KR 빌드에 kr 버전 없음')) attention.push(`localizedImg에 있는데 짝이 없는 새 번들 ${fresh.length}개`);
    }
  }

  // The text patch: canary result and Lua changes since the previous build
  say('', '## 텍스트 패치 (canary)', '');
  const canary = readJson(path.join(ARCHIVE, 'canary', cur.jp + '.json'), null);
  const prevCanary = prev && readJson(path.join(ARCHIVE, 'canary', prev.jp + '.json'), null);
  if (!canary) {
    say('canary 결과 없음 (`node tools/canary.js`)');
    attention.push('canary를 안 돌렸음');
  } else {
    say(canary.ok ? '통과' : '**실패**', ...canary.problems.map(p => `- ${p}`));
    if (!canary.ok) block.push(`canary 실패: ${canary.problems.join('; ')}`);
    for (const [mod, l] of Object.entries(canary.lua || {})) {
      const was = prevCanary && prevCanary.lua && prevCanary.lua[mod];
      if (!was || was.sha === l.sha) continue;
      attention.push(`${mod}.lua가 바뀜`);
      const file = sha => path.join(ARCHIVE, 'lua', mod, sha + '.lua');
      let diff = '(이전 소스 없음)';
      if (fs.existsSync(file(was.sha))) {
        try { execFileSync('diff', ['-u', file(was.sha), file(l.sha)]); diff = ''; } catch (e) { diff = e.stdout ? e.stdout.toString() : String(e); }
      }
      const cut = diff.split('\n');
      say('', `### ${mod}.lua \`${was.sha}\` → \`${l.sha}\``, '', '```diff', ...cut.slice(0, 200), ...(cut.length > 200 ? [`… ${cut.length - 200}줄 더`] : []), '```');
    }
  }

  const summary = [...block.map(b => `**게시 중단** ${b}`), ...attention];
  lines.splice(headLen, 0, '', summary.length ? `**볼 것 ${summary.length}개**` : '**볼 것 없음**', ...summary.map(a => `- ${a}`));
  const md = lines.join('\n') + '\n';
  const write = (flag, text) => {
    const i = process.argv.indexOf(flag);
    if (i < 0) return;
    fs.mkdirSync(path.dirname(process.argv[i + 1]), { recursive: true });
    fs.writeFileSync(process.argv[i + 1], text);
  };
  write('--out', md);
  write('--json', JSON.stringify({ snapshot: names[names.length - 1], block, attention }, null, 1) + '\n');
  process.stdout.write(md);
}

// Which archived jp manifest lists a bundle (for printing old paths).
function manifestOf(name) {
  for (const m of allJpManifests()) if (m && m.owner.has(name)) return m;
  return null;
}

main();
