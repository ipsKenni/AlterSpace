// Binäres Protokoll für Spielstate über WebRTC-DataChannel
// - Kompakt, um Bandbreite zu sparen
// - Ungeordnet und unzuverlässig (Game-typisch)

export const OPC = {
  UPDATE: 0x75, // 'u'
  SNAPSHOT: 0x73, // 's'
  CHAT_PUBLIC: 0x63, // 'c'
  CHAT_PRIVATE: 0x70, // 'p'
  NAME: 0x6e, // 'n'
  STATE: 0x53, // 'S'
  BEAM_REQ: 0x62, // 'b'
  BEAM_RESP: 0x72, // 'r'
  MOVE: 0x6d, // 'm' ship move target
};

export function encodeUpdate(x, y) {
  const buf = new ArrayBuffer(1 + 4 + 4);
  const dv = new DataView(buf);
  dv.setUint8(0, OPC.UPDATE);
  dv.setFloat32(1, x, true);
  dv.setFloat32(5, y, true);
  return buf;
}

export function encodeChatPublic(cx, cy, radius, text) {
  const enc = new TextEncoder();
  const bytes = enc.encode(text || '');
  const len = Math.min(255, bytes.length);
  const buf = new ArrayBuffer(1 + 4 + 4 + 4 + 1 + len);
  const dv = new DataView(buf); let o = 0;
  dv.setUint8(o++, OPC.CHAT_PUBLIC);
  dv.setFloat32(o, cx, true); o += 4; dv.setFloat32(o, cy, true); o += 4; dv.setFloat32(o, radius, true); o += 4;
  dv.setUint8(o++, len); new Uint8Array(buf, o).set(bytes.subarray(0, len));
  return buf;
}

export function encodeChatPrivate(targetHash, text) {
  const enc = new TextEncoder();
  const bytes = enc.encode(text || ''); const len = Math.min(255, bytes.length);
  const buf = new ArrayBuffer(1 + 4 + 1 + len);
  const dv = new DataView(buf); let o = 0;
  dv.setUint8(o++, OPC.CHAT_PRIVATE);
  dv.setUint32(o, targetHash, true); o += 4; dv.setUint8(o++, len);
  new Uint8Array(buf, o).set(bytes.subarray(0, len));
  return buf;
}

export function encodeName(name) {
  const enc = new TextEncoder();
  const bytes = enc.encode(name || '');
  const len = Math.min(255, bytes.length);
  const buf = new ArrayBuffer(1 + 1 + len);
  const dv = new DataView(buf); let o = 0;
  dv.setUint8(o++, OPC.NAME);
  dv.setUint8(o++, len);
  new Uint8Array(buf, o).set(bytes.subarray(0, len));
  return buf;
}

export function decodeSnapshot(buf) {
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== OPC.SNAPSHOT) return [];
  const n = dv.getUint16(1, true);
  let o = 3;
  const out = [];
  for (let i = 0; i < n; i++) {
    if (o + 12 > dv.byteLength) break;
    const idHash = dv.getUint32(o, true); o += 4;
    const x = dv.getFloat32(o, true); o += 4;
    const y = dv.getFloat32(o, true); o += 4;
    let name = '';
    if (o < dv.byteLength) {
      const len = dv.getUint8(o); o += 1;
      if (len > 0 && o + len <= dv.byteLength) {
        const bytes = new Uint8Array(dv.buffer, dv.byteOffset + o, len);
        name = new TextDecoder().decode(bytes);
        o += len;
      }
    }
    // optional extended scene info
    let scene = 0, body = 0, tileX = 0, tileY = 0, ship = 0;
    if (o + 1 + 4 + 2 + 2 + 4 <= dv.byteLength) {
      scene = dv.getUint8(o); o += 1;
      body = dv.getUint32(o, true); o += 4;
      tileX = dv.getInt16(o, true); o += 2;
      tileY = dv.getInt16(o, true); o += 2;
      ship = dv.getUint32(o, true); o += 4;
    }
    out.push({ idHash, x, y, name, scene, body, tileX, tileY, ship });
  }
  return out;
}

// STATE: scene presence (space/surface/interior) and local coords
// scene: 0=space, 1=surface, 2=interior
export function encodeState(scene, body = 0, tileX = 0, tileY = 0, ship = 0) {
  const buf = new ArrayBuffer(1 + 1 + 4 + 2 + 2 + 4);
  const dv = new DataView(buf); let o = 0;
  dv.setUint8(o++, OPC.STATE);
  dv.setUint8(o++, scene|0);
  dv.setUint32(o, body>>>0, true); o += 4;
  dv.setInt16(o, tileX|0, true); o += 2;
  dv.setInt16(o, tileY|0, true); o += 2;
  dv.setUint32(o, ship>>>0, true); o += 4;
  return buf;
}

// BEAM REQUEST: ask targetHash to allow us to beam to them.
// Layout: [OP][targetHash:u32][txtLen:u8][txt...]
export function encodeBeamRequest(targetHash, text = '') {
  const enc = new TextEncoder();
  const bytes = enc.encode(text || '');
  const len = Math.min(255, bytes.length);
  const buf = new ArrayBuffer(1 + 4 + 1 + len);
  const dv = new DataView(buf); let o = 0;
  dv.setUint8(o++, OPC.BEAM_REQ);
  dv.setUint32(o, targetHash>>>0, true); o += 4;
  dv.setUint8(o++, len);
  new Uint8Array(buf, o).set(bytes.subarray(0, len));
  return buf;
}

// BEAM RESPONSE: reply to requester with accept flag and our destination coords
// Layout: [OP][targetHash:u32][accept:u8][scene:u8][body:u32][tileX:i16][tileY:i16][ship:u32]
export function encodeBeamResponse(targetHash, accept, scene = 0, body = 0, tileX = 0, tileY = 0, ship = 0) {
  const buf = new ArrayBuffer(1 + 4 + 1 + 1 + 4 + 2 + 2 + 4);
  const dv = new DataView(buf); let o = 0;
  dv.setUint8(o++, OPC.BEAM_RESP);
  dv.setUint32(o, targetHash>>>0, true); o += 4;
  dv.setUint8(o++, accept ? 1 : 0);
  dv.setUint8(o++, scene|0);
  dv.setUint32(o, body>>>0, true); o += 4;
  dv.setInt16(o, tileX|0, true); o += 2;
  dv.setInt16(o, tileY|0, true); o += 2;
  dv.setUint32(o, ship>>>0, true); o += 4;
  return buf;
}

// MOVE: send ship target in world units; clients simulate locally
// Layout: [OP][tx:f32][ty:f32]
export function encodeMove(tx, ty) {
  const buf = new ArrayBuffer(1 + 4 + 4);
  const dv = new DataView(buf);
  dv.setUint8(0, OPC.MOVE);
  dv.setFloat32(1, tx, true);
  dv.setFloat32(5, ty, true);
  return buf;
}
