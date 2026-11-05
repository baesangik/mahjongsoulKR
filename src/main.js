// Browser glue: intercept the bundle manifest and the bundle holding GameMgr.lua.
(() => {
  'use strict';
  const TAG = '[mjs-kr]';
  const TARGET_ASSET = '/GameMgr.lua.bytes';
  const TARGET_SCRIPT = 'GameMgr.lua';
  const MANIFEST_RE = /\/resources\/ab\/.+\/bundle_info_so\.[^/?]+(\?|$)/;

  const realFetch = window.fetch.bind(window);
  let target = null; // { name, bytes } once the patched bundle is ready

  const urlOf = input => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const fileOf = url => new URL(url, location.href).pathname.split('/').pop();

  function respond(orig, bytes) {
    const headers = new Headers(orig.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(bytes, { status: orig.status, statusText: orig.statusText, headers });
  }

  async function onManifest(input, init) {
    const res = await realFetch(input, init);
    if (!res.ok) return res;
    const raw = new Uint8Array(await res.clone().arrayBuffer());
    try {
      const name = MjsKr.locate(raw, TARGET_ASSET);
      if (!name) throw new Error('GameMgr.lua not found in manifest');
      const bundleUrl = new URL(name, new URL(urlOf(input), location.href)).href;
      const br = await realFetch(bundleUrl, { cache: 'no-store' });
      if (!br.ok) throw new Error('bundle fetch ' + br.status);
      const patched = MjsKr.patchLuaBundle(new Uint8Array(await br.arrayBuffer()), TARGET_SCRIPT, MJS_KR_LUA, m => console.log(TAG, m));
      if (!patched) throw new Error('GameMgr.lua not found in ' + name);
      const manifest = MjsKr.setManifestSize(raw, name, patched.length);
      if (!manifest) throw new Error('could not update manifest');
      target = { name, bytes: patched };
      console.log(TAG, 'ready:', name, patched.length, 'bytes');
      return respond(res, manifest);
    } catch (e) {
      console.warn(TAG, 'disabled, game stays Japanese:', e);
      return respond(res, raw);
    }
  }

  window.fetch = function (input, init) {
    const url = urlOf(input);
    if (url && MANIFEST_RE.test(url)) return onManifest(input, init);
    if (target && url && fileOf(url) === target.name) {
      console.log(TAG, 'serving patched', target.name);
      return Promise.resolve(new Response(target.bytes.slice(), { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
    }
    return realFetch(input, init);
  };
  console.log(TAG, 'fetch hook installed');
})();
