// node tools/drift.js [--out FILE]
// Compares the latest swapdb/builds snapshot with the one before and writes a Markdown report:
// which pairs stayed, changed, appeared, went away or newly failed validation, what the audit
// flagged among the new ones, and where things moved. Moves are traced through the image archive
// (tools/imgindex.py): a JP language bundle that vanished and one that appeared holding the same
// pixels are the same asset under a new path, and an override or revert entry that no longer
// matches anything is looked up the same way. Nothing is changed; the report only suggests.
const fs = require('fs');
const path = require('path');
const MjsKr = require('../src/core.js');

const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'swapdb');
const ARCHIVE = path.join(ROOT, '.cache/archive');
const LANG = /(?<![A-Za-z0-9])jp(?![A-Za-z0-9])/i;
const LOOK = 6; // dHash bits that may differ for two images to count as the same look
const readJson = (p, dflt) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : dflt;
const stem = MjsKr.bundleStem;

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
  const outArg = process.argv.indexOf('--out');
  const names = fs.readdirSync(path.join(DB, 'builds')).filter(f => f.endsWith('.json')).sort();
  if (!names.length) throw new Error('no snapshots in swapdb/builds');
  const cur = readJson(path.join(DB, 'builds', names[names.length - 1]));
  const prev = names.length > 1 ? readJson(path.join(DB, 'builds', names[names.length - 2])) : null;
  const verdicts = readJson(path.join(DB, 'verdicts.json'), {});
  const overrides = readJson(path.join(DB, 'overrides.json'), {});
  const curJp = manifest('jp', cur.jp), prevJp = prev && manifest('jp', prev.jp);

  const lines = [], attention = [];
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
    attention.push(`짝 수가 절반 아래로 줄었음 (${Object.keys(pp).length} → ${Object.keys(cur.pairs).length}): 언어 폴더 규칙이 바뀌었을 수 있다`);
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
  const decided = n => stem(n) in (overrides.deny || {}) || stem(n) in (overrides.revert || {});
  for (const [n, v] of flagged) say(`- ${where(curJp, n)} \`${stem(n)}\`: ${v ? v.reasons.join(', ') : '감사 안 됨'}${decided(n) ? ' (overrides에서 처리함)' : ''}`);
  const open = flagged.filter(([n]) => !decided(n)).length;
  if (open) attention.push(`처리 안 된 플래그·미감사 ${open}개`);

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
    if (vanished.length > Math.max(20, before.size * 0.2)) attention.push(`JP 언어 번들 ${vanished.length}개가 사라짐: 경로 개편일 수 있다`);
  }

  // Overrides that no longer match, with suggestions traced by image
  say('', '## overrides 점검', '');
  const curByStem = curJp ? new Map([...curJp.owner.keys()].map(n => [stem(n), n])) : new Map();
  const oldBundle = s => { for (const m of allJpManifests()) for (const n of m ? m.owner.keys() : []) if (stem(n) === s && index('jp', n)) return n; return null; };
  let orphans = 0;
  const keys = [...new Set([...Object.keys(overrides.deny || {}), ...Object.keys(overrides.revert || {})])];
  for (const s of keys) {
    const kind = s in (overrides.deny || {}) ? 'deny' : 'revert';
    const nowName = curByStem.get(s);
    if (!nowName) {
      if (!curJp) continue;
      orphans++;
      const old = oldBundle(s);
      let hint = '예전 번들 색인 없음';
      if (old) {
        let best = null;
        for (const [, n] of curByStem) {
          const ni = index('jp', n);
          if (!ni) continue;
          const o = overlap(index('jp', old), ni), score = o.of ? (o.exact + o.look) / o.of : 0;
          if (score >= 0.5 && (!best || score > best.score)) best = { n, score };
        }
        hint = best ? `옮겨 간 곳으로 보임: \`${stem(best.n)}\` ${where(curJp, best.n)}` : '닮은 번들 없음';
      }
      say(`- ${kind} \`${s}\` 가 이번 빌드에 없음 → ${hint}`);
      continue;
    }
    if (kind !== 'revert') continue;
    // Sprite names to keep as JP must still exist; look a missing one up by its old pixels.
    const ni = index('jp', nowName);
    if (!ni) continue;
    for (const sprite of overrides.revert[s]) {
      if (ni.items[`sprite:${sprite}`]) continue;
      orphans++;
      const was = [...bySha()].flatMap(([, hs]) => hs).find(h => h.lang === 'jp' && h.key === `sprite:${sprite}` && stem(h.name) === s);
      const old = was && index('jp', was.name).items[was.key];
      const cand = old && Object.entries(ni.items).find(([, it]) => it.sha === old.sha || hamming(it.dhash, old.dhash) <= LOOK);
      say(`- revert \`${s}\` 의 스프라이트 \`${sprite}\` 가 없음 → ${cand ? `이름이 \`${cand[0].replace(/^sprite:/, '')}\` 로 바뀐 것으로 보임` : '같은 이미지 없음'}`);
    }
  }
  if (!orphans) say('모두 이번 빌드에 맞음');
  else attention.push(`맞는 데가 없는 overrides ${orphans}개`);

  lines.splice(headLen, 0, '', attention.length ? `**볼 것 ${attention.length}개**` : '**볼 것 없음**', ...attention.map(a => `- ${a}`));
  const md = lines.join('\n') + '\n';
  if (outArg > 0) {
    fs.mkdirSync(path.dirname(process.argv[outArg + 1]), { recursive: true });
    fs.writeFileSync(process.argv[outArg + 1], md);
  }
  process.stdout.write(md);
}

// Which archived jp manifest lists a bundle (for printing old paths).
function manifestOf(name) {
  for (const m of allJpManifests()) if (m && m.owner.has(name)) return m;
  return null;
}

main();
