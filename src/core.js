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
    r.p = 20;
    const metaEnd = 48 + r.u32();
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
    const tableStart = r.p;
    for (let n = r.i32(); n > 0; n--) {
      r.align(4);
      const o = { entry: r.p, pid: buf.slice(r.p, r.p + 8), pathId: r.i64(), start: r.i64(), size: r.u32(), typeId: r.i32() };
      o.classId = types[o.typeId].classId;
      o.data = buf.slice(dataOffset + o.start, dataOffset + o.start + o.size);
      objects.push(o);
    }
    return { buf, little, dataOffset, fileSizePos, metaEnd, tableStart, tableEnd: r.p, types, objects };
  }

  // Like writeSerialized, but also rebuilds the object table, so objects may be added:
  // each new one needs pid (8 raw pathID bytes), typeId (index into sf.types) and data.
  function writeSerializedTable(sf) {
    const { buf, little } = sf;
    const w = new Writer();
    w.push(buf.subarray(0, sf.tableStart));
    const count = new Uint8Array(4);
    new DataView(count.buffer).setInt32(0, sf.objects.length, little);
    w.push(count);
    const entries = [];
    for (const o of sf.objects) { w.align(4); entries.push(w.len); w.push(o.pid); w.push(new Uint8Array(16)); }
    w.push(buf.subarray(sf.tableEnd, sf.metaEnd));
    const metaEnd = w.len;
    const dataOffset = sf.dataOffset + ((metaEnd - sf.metaEnd + 15) & ~15);
    let pos = 0;
    const starts = sf.objects.map(o => { pos = (pos + 7) & ~7; const s = pos; pos += o.data.length; return s; });
    const out = new Uint8Array(dataOffset + pos);
    out.set(w.out());
    const dv = new DataView(out.buffer);
    sf.objects.forEach((o, i) => {
      dv.setBigInt64(entries[i] + 8, BigInt(starts[i]), little);
      dv.setUint32(entries[i] + 16, o.data.length, little);
      dv.setInt32(entries[i] + 20, o.typeId, little);
      out.set(o.data, dataOffset + starts[i]);
    });
    dv.setUint32(20, metaEnd - 48, false);
    dv.setBigInt64(sf.fileSizePos, BigInt(out.length), false);
    dv.setBigInt64(32, BigInt(dataOffset), false);
    return out;
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
    const assetCountPos = p;
    for (let n = v.getInt32(p, little), i = (p += 4, 0); i < n; i++) {
      const path = str(); assets.push({ path, owner: v.getInt32(p, little) }); p += 4;
    }
    return { bundles, assets, assetCountPos, assetsEnd: p };
  }

  const i32Bytes = (x, little) => { const a = new Uint8Array(4); new DataView(a.buffer).setInt32(0, x, little); return a; };
  const strBytes = (s, little) => {
    const b = enc.encode(s), a = new Uint8Array(4 + ((b.length + 3) & ~3));
    new DataView(a.buffer).setInt32(0, b.length, little); a.set(b, 4);
    return a;
  };
  const concat = parts => { const w = new Writer(); for (const x of parts) w.push(x); return w.out(); };

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

  // Returns { bundles: [{ name, size }], assets: [{ path, owner }] } from the manifest bundle bytes.
  function readManifest(manifestBytes) {
    const b = readBundle(manifestBytes);
    for (const node of serializedNodes(b)) {
      const sf = readSerialized(node.data);
      for (const o of sf.objects) {
        if (o.classId !== 114) continue;
        let m;
        try { m = parseManifest(o.data, sf.little); } catch (e) { continue; }
        if (!m.assets.length) continue;
        const v = new DataView(o.data.buffer, o.data.byteOffset);
        return { bundles: m.bundles.map(x => ({ name: x.name, size: v.getInt32(x.sizePos, sf.little) })), assets: m.assets };
      }
    }
    return null;
  }

  // Rewrites fileSize for every bundle in `sizes` (Map name -> size) that the manifest lists, and
  // registers `addAssets` ([assetPath, bundleName]) whose bundle it lists.
  // Returns { bytes, found: Set of names updated }, or null if the bundle table was not found.
  function setManifestSizes(manifestBytes, sizes, addAssets = []) {
    const b = readBundle(manifestBytes);
    for (const node of serializedNodes(b)) {
      const sf = readSerialized(node.data);
      for (const o of sf.objects) {
        if (o.classId !== 114) continue;
        let m;
        try { m = parseManifest(o.data, sf.little); } catch (e) { continue; }
        if (!m.assets.length) continue;
        const v = new DataView(o.data.buffer, o.data.byteOffset);
        const found = new Set();
        for (const e of m.bundles) {
          if (!sizes.has(e.name)) continue;
          v.setInt32(e.sizePos, sizes.get(e.name), sf.little);
          found.add(e.name);
        }
        const index = new Map(m.bundles.map((e, i) => [e.name, i]));
        const known = new Set(m.assets.map(a => a.path));
        const extra = addAssets.filter(([path, name]) => index.has(name) && !known.has(path));
        if (extra.length) {
          v.setInt32(m.assetCountPos, m.assets.length + extra.length, sf.little);
          const added = extra.flatMap(([path, name]) => [strBytes(path, sf.little), i32Bytes(index.get(name), sf.little)]);
          o.data = concat([o.data.subarray(0, m.assetsEnd), ...added, o.data.subarray(m.assetsEnd)]);
        }
        node.data = writeSerialized(sf);
        return { bytes: writeBundle(b), found };
      }
    }
    return null;
  }

  // ---------- language bundle swap ----------
  // The JP client always asks for `.../jp/...` assets. A bundle from the KR build is renamed in
  // place so it passes for its JP twin: the bundle name stem and standalone `kr` tokens in
  // names/paths become their `jp` forms. Every rename keeps its length, so no offset moves.
  const LANG_SWAP = { kr: 'jp', KR: 'JP', Kr: 'Jp' };
  const BINARY_CLASSES = new Set([28, 43, 48, 83, 128]); // Texture2D, Mesh, Shader, AudioClip, Font: m_Name only
  const isAlnum = c => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  const isPrint = c => c >= 32 && c < 127;

  // Bundle file names are "<stem>_<20 hex content hash>"; the stem is the AssetBundle's own name.
  const bundleStem = name => name.replace(/_[0-9a-f]{20}$/, '');

  function replaceBytes(buf, from, to) {
    outer: for (let i = 0; i + from.length <= buf.length; i++) {
      for (let j = 0; j < from.length; j++) if (buf[i + j] !== from[j]) continue outer;
      buf.set(to, i);
      i += from.length - 1;
    }
  }

  // A token only counts inside text: three printable bytes before it (the last one not alphanumeric),
  // and after it a non-alphanumeric printable byte, a NUL or the end. Keeps binary payloads intact.
  function swapLangTokens(buf) {
    for (let i = 3; i + 1 < buf.length; i++) {
      const t = LANG_SWAP[String.fromCharCode(buf[i], buf[i + 1])];
      if (!t) continue;
      const before = buf[i - 1], after = i + 2 < buf.length ? buf[i + 2] : 0;
      if (!isPrint(before) || isAlnum(before) || !isPrint(buf[i - 2]) || !isPrint(buf[i - 3])) continue;
      if (after !== 0 && (!isPrint(after) || isAlnum(after))) continue;
      buf[i] = t.charCodeAt(0); buf[i + 1] = t.charCodeAt(1); i++;
    }
  }

  // krBytes: KR build bundle `krName`; returns it renamed to pass as JP bundle `jpName` (uncompressed).
  function swapBundle(krBytes, krName, jpName) {
    const krStem = bundleStem(krName), jpStem = bundleStem(jpName);
    if (krStem.length !== jpStem.length) throw new Error('bundle names differ in length');
    const from = enc.encode(krStem), to = enc.encode(jpStem);
    const b = readBundle(krBytes);
    for (const node of serializedNodes(b)) {
      const sf = readSerialized(node.data);
      for (const o of sf.objects) {
        let len = o.data.length;
        if (BINARY_CLASSES.has(o.classId)) {
          const n = len >= 4 ? new DataView(o.data.buffer, o.data.byteOffset).getInt32(0, sf.little) : -1;
          len = n >= 0 && n + 4 <= len ? n + 4 : 0;
        }
        const region = node.data.subarray(sf.dataOffset + o.start, sf.dataOffset + o.start + len);
        replaceBytes(region, from, to);
        swapLangTokens(region);
      }
    }
    return writeBundle(b);
  }

  // ---------- AssetBundle object (class 142): name, preload table, container; the rest kept as is ----------
  function readAssetBundle(data, little) {
    const r = new Reader(data, 0, little);
    const name = dec.decode(r.bytes(r.i32())); r.align(4);
    const preload = [];
    for (let n = r.i32(); n > 0; n--) preload.push(r.bytes(12).slice()); // PPtr: fileID i32, pathID i64
    const container = [];
    for (let n = r.i32(); n > 0; n--) {
      const key = dec.decode(r.bytes(r.i32())); r.align(4);
      container.push({ key, index: r.i32(), size: r.i32(), asset: r.bytes(12).slice() });
    }
    return { name, preload, container, rest: data.slice(r.p) };
  }

  function writeAssetBundle(ab, little) {
    return concat([
      strBytes(ab.name, little),
      i32Bytes(ab.preload.length, little), ...ab.preload,
      i32Bytes(ab.container.length, little),
      ...ab.container.flatMap(c => [strBytes(c.key, little), i32Bytes(c.index, little), i32Bytes(c.size, little), c.asset]),
      ab.rest,
    ]);
  }

  const objectName = (o, little) => {
    const n = o.data.length >= 4 ? new DataView(o.data.buffer, o.data.byteOffset).getInt32(0, little) : -1;
    return n >= 0 && n + 4 <= o.data.length ? dec.decode(o.data.subarray(4, 4 + n)) : '';
  };

  // Atlases are "<prefix>_<page>.png" textures plus a "<prefix>_config" TextAsset mapping sprite
  // name -> page. When the KR atlas lacks sprites the JP one has, or has some in `keep` (sprite
  // names to show as JP, e.g. English placeholders), the JP page textures holding them are appended
  // to `swappedBytes` as new pages and the config points those sprites there.
  // Returns { bytes, pages: [container keys added] }, or null when nothing is missing.
  function mergeJpSprites(swappedBytes, jpBytes, keep = []) {
    const b = readBundle(swappedBytes);
    const node = serializedNodes(b)[0], sf = readSerialized(node.data);
    const jsf = readSerialized(serializedNodes(readBundle(jpBytes))[0].data);
    const L = sf.little;
    const krSprites = new Set(sf.objects.filter(o => o.classId === 213).map(o => objectName(o, L)));
    const missing = new Set(jsf.objects.filter(o => o.classId === 213).map(o => objectName(o, jsf.little)).filter(n => !krSprites.has(n) || keep.includes(n)));
    if (!missing.size) return null;

    const config = s => s.objects.find(o => o.classId === TEXT_ASSET && /_config$/.test(objectName(o, s.little)));
    const krCfgObj = config(sf), jpCfgObj = config(jsf);
    if (!krCfgObj || !jpCfgObj) throw new Error('missing sprites outside an atlas');
    const krCfgText = readTextAsset(krCfgObj, L);
    const krCfg = JSON.parse(dec.decode(krCfgText.script));
    const jpCfg = JSON.parse(dec.decode(readTextAsset(jpCfgObj, jsf.little).script));

    const abObj = sf.objects.find(o => o.classId === 142);
    const ab = readAssetBundle(abObj.data, L);
    const jab = readAssetBundle(jsf.objects.find(o => o.classId === 142).data, jsf.little);
    const typeOf = cls => { const i = sf.types.findIndex(t => t.classId === cls); if (i < 0) throw new Error('no type ' + cls); return i; };
    const byPid = new Map(jsf.objects.map(o => [o.pid.join(','), o]));
    const taken = new Set(sf.objects.map(o => o.pid.join(',')));

    // KR sprites being replaced get renamed so nothing finds them by name any more.
    for (const o of sf.objects) {
      const name = o.classId === 213 && objectName(o, L);
      if (!name || !keep.includes(name)) continue;
      o.data = concat([strBytes(name + '@kr', L), o.data.subarray(4 + ((enc.encode(name).length + 3) & ~3))]);
    }

    let next = Math.max(...Object.values(krCfg)) + 1;
    const pages = [];
    for (const page of [...new Set([...missing].map(n => jpCfg[n]))].sort()) {
      const entry = jab.container.find(c => c.key.endsWith(`_${page}.png`));
      if (!entry) throw new Error('JP page ' + page + ' not in container');
      const objs = jab.preload.slice(entry.index, entry.index + entry.size).map(p => byPid.get(p.subarray(4).join(','))).filter(Boolean);
      const tex = objs.find(o => o.classId === 28);
      const sprites = objs.filter(o => o.classId === 213 && missing.has(objectName(o, jsf.little)));
      if (!tex || !sprites.length) throw new Error('JP page ' + page + ' has no texture/sprites');
      const added = [tex, ...sprites];
      if (added.some(o => taken.has(o.pid.join(',')))) throw new Error('pathID clash');

      const texName = objectName(tex, jsf.little).replace(/_\d+$/, '_' + next);
      const nameEnd = 4 + ((enc.encode(objectName(tex, jsf.little)).length + 3) & ~3);
      const texData = concat([strBytes(texName, L), tex.data.subarray(nameEnd)]);
      const index = ab.preload.length;
      for (const o of added) {
        sf.objects.push({ pid: o.pid, typeId: typeOf(o.classId), classId: o.classId, data: o === tex ? texData : o.data });
        ab.preload.push(concat([i32Bytes(0, L), o.pid]));
      }
      const key = entry.key.replace(/_\d+\.png$/, `_${next}.png`);
      // One container entry per sub-asset, all sharing the page's key and preload range (as Unity writes it).
      for (const o of added) ab.container.push({ key, index, size: added.length, asset: concat([i32Bytes(0, L), o.pid]) });
      for (const o of sprites) krCfg[objectName(o, jsf.little)] = next;
      pages.push(key);
      next++;
    }
    abObj.data = writeAssetBundle(ab, L);
    krCfgText.script = enc.encode(JSON.stringify(krCfg));
    writeTextAsset(krCfgObj, L, krCfgText);
    node.data = writeSerializedTable(sf);
    return { bytes: writeBundle(b), pages };
  }

  // For offline checks: [{ classId, data }] of every object in a bundle.
  function listObjects(bundleBytes) {
    const out = [];
    for (const node of serializedNodes(readBundle(bundleBytes))) {
      const sf = readSerialized(node.data);
      for (const o of sf.objects) out.push({ classId: o.classId, data: o.data });
    }
    return out;
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

  return { locate, readManifest, setManifestSizes, patchLuaBundle, extractLua, xor, readBundle, bundleStem, swapBundle, mergeJpSprites, listObjects, readAssetBundle };
})();

if (typeof module !== 'undefined') module.exports = MjsKr;
