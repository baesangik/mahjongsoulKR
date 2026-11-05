// Core of the JP-server Korean patch: UnityFS bundle repacking + Lua injection.
// Pure functions over Uint8Array so it runs both in the browser and in node.

const MjsKr = (() => {
  'use strict';

  const TEXT_ASSET = 49;
  const KNOWN_KEYS = ['wrelupqezdfrqdsd'];
  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8', { fatal: false });

  // ---------- byte helpers ----------
  class Reader {
    constructor(buf, pos = 0, little = false) {
      this.b = buf; this.v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      this.p = pos; this.le = little;
    }
    u8() { return this.b[this.p++]; }
    u16() { const x = this.v.getUint16(this.p, this.le); this.p += 2; return x; }
    i16() { const x = this.v.getInt16(this.p, this.le); this.p += 2; return x; }
    u32() { const x = this.v.getUint32(this.p, this.le); this.p += 4; return x; }
    i32() { const x = this.v.getInt32(this.p, this.le); this.p += 4; return x; }
    i64() { const x = this.v.getBigInt64(this.p, this.le); this.p += 8; return Number(x); }
    bytes(n) { const x = this.b.subarray(this.p, this.p + n); this.p += n; return x; }
    cstr() { let e = this.p; while (this.b[e] !== 0) e++; const s = dec.decode(this.b.subarray(this.p, e)); this.p = e + 1; return s; }
    align(n) { this.p = (this.p + n - 1) & ~(n - 1); }
  }

  class Writer {
    constructor() { this.parts = []; this.len = 0; }
    push(u8) { this.parts.push(u8); this.len += u8.length; }
    num(size, fn) { const a = new Uint8Array(size); fn(new DataView(a.buffer)); this.push(a); }
    u16(x) { this.num(2, d => d.setUint16(0, x)); }
    u32(x) { this.num(4, d => d.setUint32(0, x)); }
    i32(x) { this.num(4, d => d.setInt32(0, x)); }
    i64(x) { this.num(8, d => d.setBigInt64(0, BigInt(x))); }
    cstr(s) { this.push(enc.encode(s)); this.push(new Uint8Array(1)); }
    align(n) { const pad = (n - (this.len % n)) % n; if (pad) this.push(new Uint8Array(pad)); }
    out() { const o = new Uint8Array(this.len); let p = 0; for (const x of this.parts) { o.set(x, p); p += x.length; } return o; }
  }

  // ---------- LZ4 block decompression ----------
  function lz4(src, outSize) {
    const out = new Uint8Array(outSize);
    let s = 0, d = 0;
    while (s < src.length) {
      const tok = src[s++];
      let lit = tok >> 4;
      if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
      out.set(src.subarray(s, s + lit), d); s += lit; d += lit;
      if (s >= src.length) break;
      const off = src[s] | (src[s + 1] << 8); s += 2;
      let m = tok & 15;
      if (m === 15) { let b; do { b = src[s++]; m += b; } while (b === 255); }
      m += 4;
      for (let i = 0; i < m; i++, d++) out[d] = out[d - off];
    }
    if (d !== outSize) throw new Error(`lz4 size mismatch ${d}/${outSize}`);
    return out;
  }

  function inflateBlock(data, usize, flags) {
    const c = flags & 0x3f;
    if (c === 0) return data;
    if (c === 2 || c === 3) return lz4(data, usize);
    throw new Error('unsupported compression ' + c);
  }

  // ---------- UnityFS ----------
  function readBundle(buf) {
    const r = new Reader(buf);
    const sig = r.cstr();
    if (sig !== 'UnityFS') throw new Error('not UnityFS: ' + sig);
    const h = { version: r.u32(), unityVersion: r.cstr(), revision: r.cstr() };
    r.i64(); // total size
    const csize = r.u32(), usize = r.u32();
    h.flags = r.u32();
    if (h.version >= 7) r.align(16);
    let info;
    if (h.flags & 0x80) {
      info = buf.subarray(buf.length - csize);
    } else {
      info = r.bytes(csize);
      if (h.flags & 0x200) r.align(16);
    }
    const ir = new Reader(inflateBlock(info, usize, h.flags));
    h.hash = ir.bytes(16).slice();
    const blocks = [];
    for (let n = ir.i32(); n > 0; n--) blocks.push({ u: ir.u32(), c: ir.u32(), f: ir.u16() });
    const nodes = [];
    for (let n = ir.i32(); n > 0; n--) nodes.push({ offset: ir.i64(), size: ir.i64(), flags: ir.u32(), path: ir.cstr() });
    const stream = new Uint8Array(blocks.reduce((a, b) => a + b.u, 0));
    let p = 0;
    for (const b of blocks) { stream.set(inflateBlock(r.bytes(b.c), b.u, b.f), p); p += b.u; }
    for (const n of nodes) n.data = stream.slice(n.offset, n.offset + n.size);
    return { h, nodes };
  }

  // Repack uncompressed; directory info right after the header.
  function writeBundle({ h, nodes }) {
    const CHUNK = 0x20000;
    let off = 0;
    for (const n of nodes) { n.offset = off; n.size = n.data.length; off += n.size; }
    const total = off;
    const blocks = [];
    for (let p = 0; p < total; p += CHUNK) blocks.push(Math.min(CHUNK, total - p));
    if (!blocks.length) blocks.push(0);

    const iw = new Writer();
    iw.push(h.hash);
    iw.i32(blocks.length);
    for (const b of blocks) { iw.u32(b); iw.u32(b); iw.u16(0); }
    iw.i32(nodes.length);
    for (const n of nodes) { iw.i64(n.offset); iw.i64(n.size); iw.u32(n.flags); iw.cstr(n.path); }
    const info = iw.out();

    const flags = h.flags & ~0xbf; // compression none, info not at end
    const head = new Writer();
    head.cstr('UnityFS'); head.u32(h.version); head.cstr(h.unityVersion); head.cstr(h.revision);
    const sizePos = head.len; head.i64(0);
    head.u32(info.length); head.u32(info.length); head.u32(flags);
    if (h.version >= 7) head.align(16);
    head.push(info);
    if (flags & 0x200) head.align(16);
    for (const n of nodes) head.push(n.data);
    const out = head.out();
    new DataView(out.buffer).setBigInt64(sizePos, BigInt(out.length));
    return out;
  }

  // ---------- SerializedFile (v22+, object table only) ----------
  function readSerialized(buf) {
    const r = new Reader(buf);
    r.p = 8;
    const version = r.u32();
    if (version < 22) throw new Error('serialized version ' + version);
    r.p = 16;
    const little = r.u8() === 0;
    r.p = 20; r.u32();
    const fileSizePos = 24; r.i64();
    const dataOffset = r.i64();
    r.p = 48; r.le = little;
    r.cstr(); r.i32();
    const typeTree = r.u8() !== 0;
    const types = [];
    for (let n = r.i32(); n > 0; n--) {
      const classId = r.i32();
      r.u8();
      const scriptIdx = r.i16();
      if (classId === 114) r.bytes(16);
      r.bytes(16);
      if (typeTree) {
        const nodeCount = r.i32(), strSize = r.i32();
        r.bytes(nodeCount * 32 + strSize);
        for (let d = r.i32(); d > 0; d--) r.i32();
      }
      types.push({ classId, scriptIdx });
    }
    const objects = [];
    for (let n = r.i32(); n > 0; n--) {
      r.align(4);
      const o = { entry: r.p, pathId: r.i64(), start: r.i64(), size: r.u32(), typeId: r.i32() };
      o.classId = types[o.typeId].classId;
      o.data = buf.slice(dataOffset + o.start, dataOffset + o.start + o.size);
      objects.push(o);
    }
    return { buf, little, dataOffset, fileSizePos, objects };
  }

  function writeSerialized(sf) {
    const head = sf.buf.slice(0, sf.dataOffset);
    const dv = new DataView(head.buffer);
    const order = [...sf.objects].sort((a, b) => a.start - b.start);
    let pos = 0;
    for (const o of order) {
      pos = (pos + 7) & ~7;
      o.start = pos; pos += o.data.length;
      dv.setBigInt64(o.entry + 8, BigInt(o.start), sf.little);
      dv.setUint32(o.entry + 16, o.data.length, sf.little);
    }
    const out = new Uint8Array(sf.dataOffset + pos);
    out.set(head);
    for (const o of order) out.set(o.data, sf.dataOffset + o.start);
    new DataView(out.buffer).setBigInt64(sf.fileSizePos, BigInt(out.length), false);
    return out;
  }

  function serializedNodes(bundle) {
    return bundle.nodes.filter(n => !/\.(resS|resource)$/i.test(n.path) && n.data.length > 48);
  }

  // ---------- TextAsset ----------
  function readTextAsset(o, little) {
    const r = new Reader(o.data, 0, little);
    const name = dec.decode(r.bytes(r.i32())); r.align(4);
    const script = r.bytes(r.i32()).slice(); r.align(4);
    return { name, script, rest: o.data.slice(r.p) };
  }

  function writeTextAsset(o, little, t) {
    const name = enc.encode(t.name);
    const size = 4 + ((name.length + 3) & ~3) + 4 + ((t.script.length + 3) & ~3) + t.rest.length;
    const out = new Uint8Array(size), dv = new DataView(out.buffer);
    let p = 0;
    dv.setInt32(p, name.length, little); p += 4; out.set(name, p); p += (name.length + 3) & ~3;
    dv.setInt32(p, t.script.length, little); p += 4; out.set(t.script, p); p += (t.script.length + 3) & ~3;
    out.set(t.rest, p);
    o.data = out;
  }

  // ---------- XOR "encryption" ----------
  const xor = (data, key) => {
    if (!key.length) return data.slice();
    const o = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) o[i] = data[i] ^ key[i % key.length];
    return o;
  };

  function textScore(bytes) {
    let s = 0;
    for (const b of bytes) {
      if (b === 32 || b === 9 || b === 10 || b === 13) s += 3;
      else if (b >= 97 && b <= 122) s += 2;
      else if (b >= 32 && b < 127) s += 1;
      else if (b < 32) s -= 5;
    }
    return s;
  }

  // Recover a repeating XOR key by per-column frequency; tries common periods.
  function deriveKey(data, isPlain) {
    for (const period of [16, 32, 8, 24, 64, 4, 12, 20, 48]) {
      const key = new Uint8Array(period);
      for (let i = 0; i < period; i++) {
        let best = 0, bestScore = -Infinity;
        const col = [];
        for (let j = i; j < data.length; j += period) col.push(data[j]);
        for (let k = 0; k < 256; k++) {
          const sc = textScore(col.map(c => c ^ k));
          if (sc > bestScore) { bestScore = sc; best = k; }
        }
        key[i] = best;
      }
      if (isPlain(xor(data, key))) return key;
    }
    return null;
  }

  function findKey(data, isPlain) {
    if (isPlain(data)) return new Uint8Array(0);
    for (const k of KNOWN_KEYS) {
      const key = enc.encode(k);
      if (isPlain(xor(data, key))) return key;
    }
    return deriveKey(data, isPlain);
  }

  // ---------- manifest (BundleInfoSO MonoBehaviour) ----------
  // Layout: PPtr, u8+align, PPtr, string m_Name, bundleInfos[{string name, int fileSize}],
  //         assetInfos[{string assetPath, int ownerBundleIndex}], groupInfos...
  function parseManifest(data, little) {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let p = 12 + 4 + 12;
    const str = () => { const n = v.getInt32(p, little); const s = dec.decode(data.subarray(p + 4, p + 4 + n)); p += 4 + ((n + 3) & ~3); return s; };
    str();
    const bundles = [];
    for (let n = v.getInt32(p, little), i = (p += 4, 0); i < n; i++) {
      const name = str(); bundles.push({ name, sizePos: p }); p += 4;
    }
    const assets = [];
    for (let n = v.getInt32(p, little), i = (p += 4, 0); i < n; i++) {
      const path = str(); assets.push({ path, owner: v.getInt32(p, little) }); p += 4;
    }
    return { bundles, assets };
  }

  // ---------- public API ----------

  // Returns { bundleName } of the bundle containing assetSuffix, from the manifest bundle bytes.
  function locate(manifestBytes, assetSuffix) {
    const b = readBundle(manifestBytes);
    for (const node of serializedNodes(b)) {
      const sf = readSerialized(node.data);
      for (const o of sf.objects) {
        if (o.classId !== 114) continue;
        let m;
        try { m = parseManifest(o.data, sf.little); } catch (e) { continue; }
        const hit = m.assets.find(a => a.path.toLowerCase().endsWith(assetSuffix.toLowerCase()));
        if (hit && m.bundles[hit.owner]) return m.bundles[hit.owner].name;
      }
    }
    return null;
  }

  // Rewrites fileSize for bundleName in the manifest. Returns new manifest bytes.
  function setManifestSize(manifestBytes, bundleName, size) {
    const b = readBundle(manifestBytes);
    for (const node of serializedNodes(b)) {
      const sf = readSerialized(node.data);
      for (const o of sf.objects) {
        if (o.classId !== 114) continue;
        let m;
        try { m = parseManifest(o.data, sf.little); } catch (e) { continue; }
        const e = m.bundles.find(x => x.name === bundleName);
        if (!e) continue;
        new DataView(o.data.buffer, o.data.byteOffset).setInt32(e.sizePos, size, sf.little);
        node.data = writeSerialized(sf);
        return writeBundle(b);
      }
    }
    return null;
  }

  // Patches the Lua TextAsset whose name matches `scriptName` (e.g. "GameMgr.lua"):
  // inserts `luaChunk` right before the module's final `return <Module>`.
  function patchLuaBundle(bundleBytes, scriptName, luaChunk, log = () => {}) {
    const b = readBundle(bundleBytes);
    const modName = scriptName.replace(/\.lua$/i, '').split(/[./]/).pop();
    const tail = new RegExp(`return\\s+${modName}\\s*$`);
    const isPlain = d => tail.test(dec.decode(d.subarray(Math.max(0, d.length - 64))));
    for (const node of serializedNodes(b)) {
      const sf = readSerialized(node.data);
      for (const o of sf.objects) {
        if (o.classId !== TEXT_ASSET) continue;
        const t = readTextAsset(o, sf.little);
        if (t.name.toLowerCase() !== scriptName.toLowerCase()) continue;
        const key = findKey(t.script, isPlain);
        if (!key) throw new Error('could not recover XOR key for ' + t.name);
        const src = dec.decode(xor(t.script, key));
        const m = src.match(tail);
        const patched = src.slice(0, m.index) + '\n' + luaChunk + '\n' + src.slice(m.index);
        t.script = xor(enc.encode(patched), key);
        writeTextAsset(o, sf.little, t);
        node.data = writeSerialized(sf);
        log(`patched ${t.name} (key len ${key.length}, +${patched.length - src.length} chars)`);
        return writeBundle(b);
      }
    }
    return null;
  }

  // For offline verification.
  function extractLua(bundleBytes, scriptName) {
    const b = readBundle(bundleBytes);
    for (const node of serializedNodes(b)) {
      const sf = readSerialized(node.data);
      for (const o of sf.objects) {
        if (o.classId !== TEXT_ASSET) continue;
        const t = readTextAsset(o, sf.little);
        if (t.name.toLowerCase() === scriptName.toLowerCase()) return t.script;
      }
    }
    return null;
  }

  return { locate, setManifestSize, patchLuaBundle, extractLua, xor, readBundle };
})();

if (typeof module !== 'undefined') module.exports = MjsKr;
