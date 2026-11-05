// node tools/smoke.js [--break N] [--headed] [--wait SEC] [--out DIR]
// Opens the real game (https://game.mahjongsoul.com) in Chrome with public/mahjongsoulKR.user.js
// injected at document start and reading public/swap.json instead of https://jakhon.chamchi.me/swap.json,
// so what is about to be deployed gets checked before it is. Watches the console up to the title
// screen and passes when: the hook and the text patch ran, prefer_language became kr, swap.json
// matched the manifest fully, at least one bundle was swapped, and no swap failed. No login.
//   --break N   point N swap.json entries at missing KR files, to see the JP-original fallback
//               (whose size no longer matches the patched manifest) load without errors
// Needs `npm run build` first. Chrome: $CHROME, else google-chrome on PATH; profile in
// .cache/smoke-profile. Exit 0 pass, 2 fail.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const GAME = 'https://game.mahjongsoul.com/';
const SWAP_URL = 'https://jakhon.chamchi.me/swap.json';
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  try { return execFileSync('which', ['google-chrome'], { encoding: 'utf8' }).trim(); } catch (e) { return undefined; }
}

async function main() {
  const broken = Number(arg('--break', 0)), wait = Number(arg('--wait', 240)) * 1000;
  const out = arg('--out', path.join(ROOT, '.cache/smoke'));
  fs.mkdirSync(out, { recursive: true });
  const script = fs.readFileSync(path.join(ROOT, 'public/mahjongsoulKR.user.js'), 'utf8');
  const swap = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/swap.json'), 'utf8'));
  // Break the bundles the title screen is known to load (from the last normal run), else the first N.
  const lastRun = path.join(out, 'console.log');
  const loaded = fs.existsSync(lastRun) ? [...fs.readFileSync(lastRun, 'utf8').matchAll(/\[mjs-kr\] swapped (\S+)/g)].map(x => x[1]).filter(n => swap.pairs[n]) : [];
  const breaking = [...new Set([...loaded, ...Object.keys(swap.pairs)])].slice(0, broken);
  for (const jp of breaking) swap.pairs[jp] = ['missing_' + swap.pairs[jp][0], ...swap.pairs[jp].slice(1)];

  // A kept profile keeps the game's download cache: a cold start pulls hundreds of MB and can take
  // minutes. What the userscript patches or swaps goes through its fetch hook either way.
  const context = await chromium.launchPersistentContext(path.join(ROOT, '.cache/smoke-profile'), {
    executablePath: chrome(),
    headless: !process.argv.includes('--headed'),
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'],
    viewport: { width: 1280, height: 720 },
    locale: 'ja-JP',
  });
  // swap.json goes in as a data: URL: the game's service worker sees page fetches before
  // context.route could, and the game won't start without it.
  if (!script.includes(`'${SWAP_URL}'`)) throw new Error('SWAP_URL not found in the userscript');
  await context.addInitScript(script.replace(`'${SWAP_URL}'`, JSON.stringify('data:application/json;base64,' + Buffer.from(JSON.stringify(swap)).toString('base64'))));
  const page = context.pages()[0] || await context.newPage();

  const log = [], errors = [];
  const t0 = Date.now();
  page.on('console', m => log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${m.type()} ${m.text()}`));
  page.on('pageerror', e => errors.push(String(e)));
  let closing = false;
  page.on('requestfailed', r => { if (!closing && /\/resources\/ab\//.test(r.url())) errors.push(`request failed ${r.url()} ${r.failure() && r.failure().errorText}`); });

  await page.goto(GAME, { waitUntil: 'domcontentloaded' });
  const has = re => log.some(l => re.test(l));
  // The title screen is up once the text patch reported and the loads settle.
  const deadline = Date.now() + wait;
  let quietSince = Date.now(), seen = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (log.length !== seen) { seen = log.length; quietSince = Date.now(); }
    if (has(/prefer_language=/) && Date.now() - quietSince > 15000) break;
  }
  await page.screenshot({ path: path.join(out, broken ? 'break.png' : 'title.png') });
  fs.writeFileSync(path.join(out, broken ? 'break.log' : 'console.log'), [...log, ...errors.map(e => 'ERROR ' + e)].join('\n') + '\n');
  closing = true;
  await context.close();

  const ready = log.find(l => /\[mjs-kr\] ready:/.test(l)) || '';
  const m = ready.match(/(\d+)\/(\d+) image bundles/);
  const swapped = log.filter(l => /\[mjs-kr\] swapped /.test(l)).length;
  const failed = log.filter(l => /\[mjs-kr\] swap failed/.test(l));
  const unity = log.filter(l => /error/i.test(l) && !/\[mjs-kr\]/.test(l));
  const checks = [
    ['fetch hook', has(/\[mjs-kr\] fetch hook installed/)],
    ['GameMgr.lua patched and served', has(/\[mjs-kr\] serving patched/)],
    ['Lua hooks installed', has(/hooks installed/)],
    ['prefer_language=kr', has(/prefer_language=kr/)],
    [`swap.json matches the manifest (${m ? m[0] : 'no ready line'})`, !!m && m[1] === m[2] && m[1] !== '0'],
    [`bundles swapped: ${swapped}`, swapped > 0 || broken > 0],
    [`swap failures: ${failed.length}, expected ${broken}`, failed.length === breaking.filter(jp => log.some(l => l.includes(jp))).length && failed.every(l => breaking.some(jp => l.includes(jp)))],
  ];
  if (broken) {
    // The fallback serves the JP original, whose size differs from what the manifest now says.
    const fellBack = breaking.filter(jp => failed.some(l => l.includes(jp)));
    // Reaching the title with no page error after that means the loader took the JP original
    // although the manifest promised another size (it doesn't check fileSize; seen 2026-11-06).
    checks.push([`JP original accepted for ${fellBack.length}/${broken} broken entries`, fellBack.length > 0 && has(/prefer_language=kr/)]);
  }
  checks.push([`page errors: ${errors.length}`, !errors.length]);
  let ok = true;
  for (const [what, pass] of checks) { console.log(`${pass ? 'ok  ' : 'FAIL'} ${what}`); ok = ok && pass; }
  if (unity.length) console.log(`console errors from the game (${unity.length}), first: ${unity.slice(0, 5).join('\n  ')}`);
  console.log(`log: ${path.join(out, broken ? 'break.log' : 'console.log')}`);
  process.exit(ok ? 0 : 2);
}

main().catch(e => { console.error(e); process.exit(1); });
