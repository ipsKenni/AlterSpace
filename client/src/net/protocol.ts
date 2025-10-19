// Binäres Protokoll für Spielstate über WebRTC-DataChannel
// - Kompakt, um Bandbreite zu sparen
// - Ungeordnet und unzuverlässig (Game-typisch)

export const OPC = {
  UPDATE: 0x75,
  SNAPSHOT: 0x73,
  CHAT_PUBLIC: 0x63,
  CHAT_PRIVATE: 0x70,
  NAME: 0x6e,
  STATE: 0x53,
  BEAM_REQ: 0x62,
  BEAM_RESP: 0x72,
  MOVE: 0x6d,
} as const;

export interface SnapshotEntry {
  idHash: number;
  x: number;
  y: number;
  name: string;
  scene: number;
  body: number;
  tileX: number;
  tileY: number;
  ship: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

type BufferLike = ArrayBuffer | SharedArrayBuffer;

export function encodeUpdate(x: number, y: number): ArrayBuffer {
  const buf = new ArrayBuffer(9);
  const dv = new DataView(buf);
  dv.setUint8(0, OPC.UPDATE);
  dv.setFloat32(1, x, true);
  dv.setFloat32(5, y, true);
  return buf;
}

export function encodeChatPublic(cx: number, cy: number, radius: number, text: string): ArrayBuffer {
  const bytes = enc.encode(text);
  const len = Math.min(255, bytes.length);
  const buf = new ArrayBuffer(1 + 4 + 4 + 4 + 1 + len);
  const dv = new DataView(buf);
  let offset = 0;
  dv.setUint8(offset, OPC.CHAT_PUBLIC);
  offset += 1;
  dv.setFloat32(offset, cx, true);
  offset += 4;
  dv.setFloat32(offset, cy, true);
  offset += 4;
  dv.setFloat32(offset, Math.max(100, radius), true);
  offset += 4;
  dv.setUint8(offset, len);
  offset += 1;
  new Uint8Array(buf, offset).set(bytes.subarray(0, len));
  return buf;
}

export function encodeChatPrivate(targetHash: number, text: string): ArrayBuffer {
  const bytes = enc.encode(text);
  const len = Math.min(255, bytes.length);
  const buf = new ArrayBuffer(1 + 4 + 1 + len);
  const dv = new DataView(buf);
  let offset = 0;
  dv.setUint8(offset, OPC.CHAT_PRIVATE);
  offset += 1;
  dv.setUint32(offset, targetHash >>> 0, true);
  offset += 4;
  dv.setUint8(offset, len);
  offset += 1;
  new Uint8Array(buf, offset).set(bytes.subarray(0, len));
  return buf;
}

export function encodeName(name: string): ArrayBuffer {
  const bytes = enc.encode(name);
  const len = Math.min(255, bytes.length);
  const buf = new ArrayBuffer(1 + 1 + len);
  const dv = new DataView(buf);
  let offset = 0;
  dv.setUint8(offset, OPC.NAME);
  offset += 1;
  dv.setUint8(offset, len);
  offset += 1;
  new Uint8Array(buf, offset).set(bytes.subarray(0, len));
  return buf;
}

export function decodeSnapshot(buffer: BufferLike): SnapshotEntry[] {
  const dv = new DataView(buffer);
  if (dv.byteLength < 3 || dv.getUint8(0) !== OPC.SNAPSHOT) {
    return [];
  }
  const entries: SnapshotEntry[] = [];
  const count = dv.getUint16(1, true);
  let offset = 3;
  for (let i = 0; i < count; i += 1) {
    if (offset + 12 > dv.byteLength) {
      break;
    }
    const idHash = dv.getUint32(offset, true);
    offset += 4;
    const x = dv.getFloat32(offset, true);
    offset += 4;
    const y = dv.getFloat32(offset, true);
    offset += 4;
    if (offset >= dv.byteLength) {
      break;
    }
    const nameLen = dv.getUint8(offset);
    offset += 1;
    let name = '';
    if (nameLen > 0 && offset + nameLen <= dv.byteLength) {
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset + offset, nameLen);
      name = dec.decode(bytes);
      offset += nameLen;
    }
    let scene = 0;
    let body = 0;
    let tileX = 0;
    let tileY = 0;
    let ship = 0;
    if (offset + 1 + 4 + 2 + 2 + 4 <= dv.byteLength) {
      scene = dv.getUint8(offset);
      offset += 1;
      body = dv.getUint32(offset, true);
      offset += 4;
      tileX = dv.getInt16(offset, true);
      offset += 2;
      tileY = dv.getInt16(offset, true);
      offset += 2;
      ship = dv.getUint32(offset, true);
      offset += 4;
    }
    entries.push({ idHash, x, y, name, scene, body, tileX, tileY, ship });
  }
  return entries;
}

export function encodeState(scene: number, body = 0, tileX = 0, tileY = 0, ship = 0): ArrayBuffer {
  const buf = new ArrayBuffer(1 + 1 + 4 + 2 + 2 + 4);
  const dv = new DataView(buf);
  let offset = 0;
  dv.setUint8(offset, OPC.STATE);
  offset += 1;
  dv.setUint8(offset, scene | 0);
  offset += 1;
  dv.setUint32(offset, body >>> 0, true);
  offset += 4;
  dv.setInt16(offset, tileX | 0, true);
  offset += 2;
  dv.setInt16(offset, tileY | 0, true);
  offset += 2;
  dv.setUint32(offset, ship >>> 0, true);
  return buf;
}

export function encodeBeamRequest(targetHash: number, text = ''): ArrayBuffer {
  const bytes = enc.encode(text);
  const len = Math.min(255, bytes.length);
  const buf = new ArrayBuffer(1 + 4 + 1 + len);
  const dv = new DataView(buf);
  let offset = 0;
  dv.setUint8(offset, OPC.BEAM_REQ);
  offset += 1;
  dv.setUint32(offset, targetHash >>> 0, true);
  offset += 4;
  dv.setUint8(offset, len);
  offset += 1;
  new Uint8Array(buf, offset).set(bytes.subarray(0, len));
  return buf;
}

export function encodeBeamResponse(targetHash: number, accept: boolean, scene = 0, body = 0, tileX = 0, tileY = 0, ship = 0): ArrayBuffer {
  const buf = new ArrayBuffer(1 + 4 + 1 + 1 + 4 + 2 + 2 + 4);
  const dv = new DataView(buf);
  let offset = 0;
  dv.setUint8(offset, OPC.BEAM_RESP);
  offset += 1;
  dv.setUint32(offset, targetHash >>> 0, true);
  offset += 4;
  dv.setUint8(offset, accept ? 1 : 0);
  offset += 1;
  dv.setUint8(offset, scene | 0);
  offset += 1;
  dv.setUint32(offset, body >>> 0, true);
  offset += 4;
  dv.setInt16(offset, tileX | 0, true);
  offset += 2;
  dv.setInt16(offset, tileY | 0, true);
  offset += 2;
  dv.setUint32(offset, ship >>> 0, true);
  return buf;
}

export function encodeMove(tx: number, ty: number): ArrayBuffer {
  const buf = new ArrayBuffer(9);
  const dv = new DataView(buf);
  dv.setUint8(0, OPC.MOVE);
  dv.setFloat32(1, tx, true);
  dv.setFloat32(5, ty, true);
  return buf;
}
