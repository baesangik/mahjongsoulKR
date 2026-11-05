// Browser glue: intercept the bundle manifest, the bundle holding GameMgr.lua and the language
// bundles listed in swap.json (served from the KR build, renamed to pass as the JP ones).
(() => {
  'use strict';
  const TAG = '[mjs-kr]';
  const TARGET_ASSET = '/GameMgr.lua.bytes';
  const TARGET_SCRIPT = 'GameMgr.lua';
  const MANIFEST_RE = /\/resources\/ab\/.+\/bundle_info_so\.[^/?]+(\?|$)/;
  const SWAP_URL = 'https://jakhon.chamchi.me/swap.json';
  const SWAP_FORMAT = 1; // the swap.json shape this script reads (swap.js SWAP_FORMAT)

  const realFetch = window.fetch.bind(window);
  let target = null; // { name, bytes } once the patched bundle is ready
  const swaps = new Map(); // jp bundle name -> { kr: url, size }

  const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
  const urlOf = input => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const fileOf = url => new URL(url, location.href).pathname.split('/').pop();

  function respond(orig, bytes) {
    const headers = new Headers(orig.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(bytes, { status: orig.status, statusText: orig.statusText, headers });
  }
  const bundleResponse = bytes => new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });

  async function prepareLua(raw, base) {
    const name = MjsKr.locate(raw, TARGET_ASSET);
    if (!name) throw new Error('GameMgr.lua not found in manifest');
    const br = await realFetch(new URL(name, base).href, { cache: 'no-store' });
    if (!br.ok) throw new Error('bundle fetch ' + br.status);
    const patched = MjsKr.patchLuaBundle(new Uint8Array(await br.arrayBuffer()), TARGET_SCRIPT, MJS_KR_LUA, m => console.log(TAG, m));
    if (!patched) throw new Error('GameMgr.lua not found in ' + name);
    return { name, bytes: patched };
  }

  // Entries are keyed by full bundle names (content hashes included), so a stale swap.json
  // simply matches nothing in a newer manifest.
  async function prepareSwap(base) {
    if (!/\/v4\/jp\//.test(base.pathname)) throw new Error('unexpected manifest path ' + base.pathname);
    const r = await realFetch(SWAP_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error('swap.json ' + r.status);
    const data = await r.json();
    if (data.v !== undefined && data.v !== SWAP_FORMAT) throw new Error(`swap.json format ${data.v}, this script reads ${SWAP_FORMAT}: update the userscript`);
    if (data.min && newer(data.min, MJS_KR_VERSION)) throw new Error(`swap.json wants script ${data.min}+, this is ${MJS_KR_VERSION}: update the userscript`);
    const { pairs } = data;
    const krBase = new URL(base.href.replace('/v4/jp/', '/v4/kr/'));
    return new Map(Object.entries(pairs).map(([jp, [kr, size, pages]]) => [jp, { kr: new URL(kr, krBase).href, krName: kr, size, pages: pages || [] }]));
  }

  async function onManifest(input, init) {
    const res = await realFetch(input, init);
    if (!res.ok) return res;
    const raw = new Uint8Array(await res.clone().arrayBuffer());
    const base = new URL(urlOf(input), location.href);
    const [lua, swap] = await Promise.all([
      prepareLua(raw, base).catch(e => { console.warn(TAG, 'text disabled, stays Japanese:', e); return null; }),
      prepareSwap(base).catch(e => { console.warn(TAG, 'image swap disabled:', e); return null; }),
    ]);
    try {
      const sizes = new Map(), pages = [];
      if (swap) for (const [jp, s] of swap) { sizes.set(jp, s.size); for (const p of s.pages) pages.push([p, jp]); }
      if (lua) sizes.set(lua.name, lua.bytes.length);
      if (!sizes.size) return respond(res, raw);
      const out = MjsKr.setManifestSizes(raw, sizes, pages);
      if (!out) throw new Error('could not update manifest');
      if (lua && out.found.has(lua.name)) target = lua;
      if (swap) for (const [jp, s] of swap) if (out.found.has(jp) && jp !== (lua && lua.name)) swaps.set(jp, s);
      console.log(TAG, 'ready:', target ? target.name : 'no text patch', '/', swap ? `${swaps.size}/${swap.size}` : 0, 'image bundles to swap');
      // Entries match by content hash, so after a game update only unchanged bundles still match
      // until swap.json is rebuilt (tools/watch.js picks the update up within ~30 minutes).
      if (swap && swap.size && swaps.size < swap.size * 0.5) console.warn(TAG, 'swap.json is for another build; most images stay Japanese until it is rebuilt');
      return respond(res, out.bytes);
    } catch (e) {
      console.warn(TAG, 'disabled, game stays Japanese:', e);
      return respond(res, raw);
    }
  }

  // The manifest already promised `size` bytes; anything else falls back to the JP original.
  // Entries with pages also need the JP original, for sprites only it has.
  async function serveSwap(name, s, input, init) {
    try {
      const [r, jr] = await Promise.all([realFetch(s.kr, { cache: 'no-store' }), s.pages.length ? realFetch(input, init) : null]);
      if (!r.ok) throw new Error('kr fetch ' + r.status);
      if (jr && !jr.ok) throw new Error('jp fetch ' + jr.status);
      let bytes = MjsKr.swapBundle(new Uint8Array(await r.arrayBuffer()), s.krName, name);
      if (jr) bytes = MjsKr.mergeJpSprites(bytes, new Uint8Array(await jr.arrayBuffer())).bytes;
      if (bytes.length !== s.size) throw new Error(`size ${bytes.length} != ${s.size}`);
      console.log(TAG, 'swapped', name);
      return bundleResponse(bytes);
    } catch (e) {
      console.warn(TAG, 'swap failed, serving JP original:', name, e);
      return realFetch(input, init);
    }
  }

  window.fetch = function (input, init) {
    const url = urlOf(input);
    if (url && MANIFEST_RE.test(url)) return onManifest(input, init);
    const name = url && fileOf(url);
    if (target && name === target.name) {
      console.log(TAG, 'serving patched', target.name);
      return Promise.resolve(bundleResponse(target.bytes.slice()));
    }
    if (swaps.has(name)) return serveSwap(name, swaps.get(name), input, init);
    return realFetch(input, init);
  };
  console.log(TAG, 'fetch hook installed');
})();
