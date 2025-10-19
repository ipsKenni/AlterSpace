// Multiplayer-Server mit optionalem WebRTC-Datenkanal
// Ziel: leichte Erweiterbarkeit durch modulare Verantwortlichkeiten

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface RTCDataChannelLike {
  readonly label: string;
  readonly readyState?: 'open' | 'closing' | 'closed' | 'connecting';
  onmessage: ((event: { data: ArrayBuffer | Buffer | Uint8Array }) => void) | null;
  send(data: ArrayBuffer | Buffer | Uint8Array): void;
  close(): void;
}

interface RTCPeerConnectionLike {
  ondatachannel: ((event: { channel: RTCDataChannelLike }) => void) | null;
  onicecandidate: ((event: { candidate: unknown }) => void) | null;
  createAnswer(): Promise<{ sdp?: string }>;
  setLocalDescription(desc: { type: 'answer'; sdp?: string }): Promise<void>;
  setRemoteDescription(desc: { type: 'offer'; sdp: string }): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  close(): void;
  readonly localDescription: { sdp?: string } | null;
}

interface WrtcModule {
  RTCPeerConnection: new (...args: unknown[]) => RTCPeerConnectionLike;
}

const CONFIG = {
  port: process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8080,
  snapshotHz: 15,
  idleTimeoutMs: 30_000,
  cellSize: 6_000,
  maxInterest: 128,
  stunServers: [{ urls: 'stun:stun.l.google.com:19302' }],
} as const;

const OPC = {
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

type Opcode = (typeof OPC)[keyof typeof OPC];

interface PlayerConnections {
  ws: WebSocket;
  pc: RTCPeerConnectionLike | null;
  dc: RTCDataChannelLike | null;
}

interface Player {
  id: string;
  connections: PlayerConnections;
  x: number;
  y: number;
  lastSeen: number;
  name: string;
  scene: number;
  body: number;
  tileX: number;
  tileY: number;
  ship: number;
}

class PlayerRegistry {
  private readonly players = new Map<string, Player>();
  private readonly cells = new Map<string, Set<string>>();

  constructor(private readonly cellSize: number, private readonly maxInterest: number) {}

  add(player: Player): void {
    this.players.set(player.id, player);
    this.addToGrid(player.id, player.x, player.y);
  }

  remove(id: string): Player | null {
    const player = this.players.get(id) ?? null;
    if (!player) {
      return null;
    }
    this.removeFromGrid(id, player.x, player.y);
    this.players.delete(id);
    return player;
  }

  get(id: string): Player | null {
    return this.players.get(id) ?? null;
  }

  updatePosition(id: string, x: number, y: number, seen: number): void {
    const player = this.players.get(id);
    if (!player) {
      return;
    }
    const oldX = player.x;
    const oldY = player.y;
    const oldKey = this.cellKey(oldX, oldY);
    const newKey = this.cellKey(x, y);
    player.x = x;
    player.y = y;
    player.lastSeen = seen;
    if (oldKey !== newKey) {
      this.removeFromGrid(id, oldX, oldY, oldKey);
      this.addToGrid(id, x, y, newKey);
    }
  }

  updatePresence(id: string, details: Pick<Player, 'scene' | 'body' | 'tileX' | 'tileY' | 'ship'>, seen: number): void {
    const player = this.players.get(id);
    if (!player) {
      return;
    }
    player.scene = details.scene;
    player.body = details.body;
    player.tileX = details.tileX;
    player.tileY = details.tileY;
    player.ship = details.ship;
    player.lastSeen = seen;
  }

  setName(id: string, name: string): void {
    const player = this.players.get(id);
    if (!player) {
      return;
    }
    player.name = name;
  }

  touch(id: string, seen: number): void {
    const player = this.players.get(id);
    if (player) {
      player.lastSeen = seen;
    }
  }

  values(): Iterable<Player> {
    return this.players.values();
  }

  findByHash(hash: number): Player | null {
    for (const player of this.players.values()) {
      if (hashId(player.id) === hash) {
        return player;
      }
    }
    return null;
  }

  interestFor(player: Player): Player[] {
    const originKey = this.cellKey(player.x, player.y);
    const [cxRaw, cyRaw] = originKey.split(',');
    const cx = Number(cxRaw ?? '0');
    const cy = Number(cyRaw ?? '0');
    const nearby: Player[] = [];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const cell = this.cells.get(`${cx + dx},${cy + dy}`);
        if (!cell) {
          continue;
        }
        for (const id of cell) {
          if (id === player.id) {
            continue;
          }
          const candidate = this.players.get(id);
          if (!candidate) {
            continue;
          }
          if (player.scene !== candidate.scene) {
            continue;
          }
          if (player.scene === 1 && player.body !== candidate.body) {
            continue;
          }
          if (player.scene === 2 && player.ship !== candidate.ship) {
            continue;
          }
          nearby.push(candidate);
        }
      }
    }
    nearby.sort((a, b) => {
      const da = (a.x - player.x) ** 2 + (a.y - player.y) ** 2;
      const db = (b.x - player.x) ** 2 + (b.y - player.y) ** 2;
      return da - db;
    });
    return nearby.slice(0, this.maxInterest);
  }

  pruneIdle(now: number, timeoutMs: number): Player[] {
    const removed: Player[] = [];
    for (const player of Array.from(this.players.values())) {
      if (now - player.lastSeen > timeoutMs) {
        removed.push(player);
        this.remove(player.id);
      }
    }
    return removed;
  }

  private cellKey(x: number, y: number): string {
    const cx = Math.floor((x || 0) / this.cellSize);
    const cy = Math.floor((y || 0) / this.cellSize);
    return `${cx},${cy}`;
  }

  private ensureCell(key: string): Set<string> {
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = new Set();
      this.cells.set(key, bucket);
    }
    return bucket;
  }

  private addToGrid(id: string, x: number, y: number, key?: string): void {
    const cell = this.ensureCell(key ?? this.cellKey(x, y));
    cell.add(id);
  }

  private removeFromGrid(id: string, x: number, y: number, key?: string): void {
    const bucket = this.cells.get(key ?? this.cellKey(x, y));
    bucket?.delete(id);
  }
}

interface SnapshotEntry {
  id: string;
  x: number;
  y: number;
  name: string;
  scene: number;
  body: number;
  tileX: number;
  tileY: number;
  ship: number;
}

function hashId(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function encodeSnapshot(list: SnapshotEntry[]): Buffer {
  const count = list.length;
  let total = 1 + 2;
  const names: Uint8Array[] = [];
  for (const entry of list) {
    const nameBytes = encoder.encode(entry.name ?? '');
    names.push(nameBytes);
    total += 4 + 4 + 4 + 1 + Math.min(255, nameBytes.length) + (1 + 4 + 2 + 2 + 4);
  }

  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  let offset = 0;
  view.setUint8(offset, OPC.SNAPSHOT);
  offset += 1;
  view.setUint16(offset, count, true);
  offset += 2;

  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i]!;
    const nameBytes = names[i]!;
    view.setUint32(offset, hashId(entry.id), true);
    offset += 4;
    view.setFloat32(offset, entry.x ?? 0, true);
    offset += 4;
    view.setFloat32(offset, entry.y ?? 0, true);
    offset += 4;

    const nameLength = Math.min(255, nameBytes.length);
    view.setUint8(offset, nameLength);
    offset += 1;
    new Uint8Array(buffer, offset, nameLength).set(nameBytes.subarray(0, nameLength));
    offset += nameLength;

    view.setUint8(offset, entry.scene & 0xff);
    offset += 1;
    view.setUint32(offset, entry.body >>> 0, true);
    offset += 4;
    view.setInt16(offset, entry.tileX | 0, true);
    offset += 2;
    view.setInt16(offset, entry.tileY | 0, true);
    offset += 2;
    view.setUint32(offset, entry.ship >>> 0, true);
    offset += 4;
  }

  return Buffer.from(buffer);
}

function toBuffer(data: ArrayBuffer | Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data));
  }
  return Buffer.from(data);
}

function safeSend(ws: WebSocket, payload: string | Buffer): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    ws.send(payload);
  } catch {
    /* ignore */
  }
}

function safeSendChannel(dc: RTCDataChannelLike | null, payload: Buffer): void {
  if (!dc || dc.readyState !== 'open') {
    return;
  }
  try {
    dc.send(payload);
  } catch {
    /* ignore */
  }
}

function createStaticServer(): http.Server {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');
  const NO_BUILD_MSG = 'Frontend build nicht gefunden. Bitte `pnpm build` im Projektwurzelverzeichnis ausführen.';
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  };

  const resolveStaticRoot = (): string | null => {
    const indexPath = path.join(CLIENT_DIST, 'index.html');
    return fs.existsSync(indexPath) ? CLIENT_DIST : null;
  };

  let staticRoot = resolveStaticRoot();
  if (!staticRoot) {
    console.warn(`[server] Kein Frontend-Build unter ${CLIENT_DIST}. HTTP-Auslieferung antwortet bis zum Build mit 503.`);
  }

  const sendFile = (res: http.ServerResponse, absolutePath: string): void => {
    fs.readFile(absolutePath, (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      const ext = path.extname(absolutePath).toLowerCase();
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=3600');
      res.end(data);
    });
  };

  return http.createServer((req, res) => {
    const root = staticRoot ?? resolveStaticRoot();
    if (!root) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(NO_BUILD_MSG);
      return;
    }
    staticRoot = root;
    try {
      const requestPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
      if (!requestPath || requestPath === '/') {
        sendFile(res, path.join(root, 'index.html'));
        return;
      }
      const absolutePath = path.normalize(path.join(root, requestPath));
      if (!absolutePath.startsWith(root)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
        sendFile(res, absolutePath);
        return;
      }
      sendFile(res, path.join(root, 'index.html'));
    } catch {
      res.statusCode = 500;
      res.end('Server error');
    }
  });
}

async function loadWrtc(): Promise<WrtcModule | null> {
  try {
    const mod = (await import('wrtc')) as unknown;
    if (mod && typeof mod === 'object' && 'RTCPeerConnection' in mod) {
      return mod as WrtcModule;
    }
  } catch {
    console.warn('[webrtc] wrtc not available, WS-only mode enabled');
  }
  return null;
}

function broadcastRegional(store: PlayerRegistry, fromId: string, cx: number, cy: number, radius: number, text: string): void {
  const sender = store.get(fromId);
  if (!sender) {
    return;
  }
  const payload = JSON.stringify({
    type: 'chat:regional',
    from: hashId(fromId),
    name: sender.name || '',
    x: cx,
    y: cy,
    text,
  });
  const radiusSquared = radius * radius;
  for (const player of store.values()) {
    const dx = (player.x || 0) - cx;
    const dy = (player.y || 0) - cy;
    if (dx * dx + dy * dy > radiusSquared) {
      continue;
    }
    safeSend(player.connections.ws, payload);
  }
}

function sendPrivate(store: PlayerRegistry, fromId: string, targetHash: number, text: string): void {
  const sender = store.get(fromId);
  if (!sender) {
    return;
  }
  const recipient = store.findByHash(targetHash);
  if (!recipient) {
    return;
  }
  const payload = JSON.stringify({ type: 'chat:private', from: hashId(fromId), name: sender.name || '', text });
  safeSend(recipient.connections.ws, payload);
}

function forwardBeamRequest(store: PlayerRegistry, fromId: string, targetHash: number, text: string): void {
  const sender = store.get(fromId);
  const recipient = store.findByHash(targetHash);
  if (!sender || !recipient) {
    return;
  }
  const payload = JSON.stringify({
    type: 'beam:req',
    from: hashId(fromId),
    name: sender.name || '',
    text: text || '',
  });
  safeSend(recipient.connections.ws, payload);
}

function forwardBeamResponse(
  store: PlayerRegistry,
  fromId: string,
  targetHash: number,
  accept: number,
  scene: number,
  body: number,
  tileX: number,
  tileY: number,
  ship: number,
): void {
  const sender = store.get(fromId);
  const recipient = store.findByHash(targetHash);
  if (!sender || !recipient) {
    return;
  }
  const payload = JSON.stringify({
    type: 'beam:resp',
    from: hashId(fromId),
    name: sender.name || '',
    accept: accept !== 0,
    scene: scene | 0,
    body: body >>> 0,
    tileX: tileX | 0,
    tileY: tileY | 0,
    ship: ship >>> 0,
  });
  safeSend(recipient.connections.ws, payload);
}

function handleBinaryMessage(
  store: PlayerRegistry,
  playerId: string,
  raw: ArrayBuffer | Buffer | Uint8Array,
  helpers: {
    broadcastRegional: typeof broadcastRegional;
    sendPrivate: typeof sendPrivate;
    forwardBeamRequest: typeof forwardBeamRequest;
    forwardBeamResponse: typeof forwardBeamResponse;
  },
): void {
  const buf = toBuffer(raw);
  if (buf.length < 1) {
    return;
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const opcode = view.getUint8(0) as Opcode;
  const now = Date.now();

  switch (opcode) {
    case OPC.UPDATE: {
      const x = view.getFloat32(1, true);
      const y = view.getFloat32(5, true);
      store.updatePosition(playerId, x, y, now);
      break;
    }
    case OPC.STATE: {
      let offset = 1;
      const scene = view.getUint8(offset) | 0;
      offset += 1;
      const body = view.getUint32(offset, true) >>> 0;
      offset += 4;
      const tileX = view.getInt16(offset, true) | 0;
      offset += 2;
      const tileY = view.getInt16(offset, true) | 0;
      offset += 2;
      const ship = view.getUint32(offset, true) >>> 0;
      store.updatePresence(playerId, { scene, body, tileX, tileY, ship }, now);
      break;
    }
    case OPC.CHAT_PUBLIC: {
      let offset = 1;
      const cx = view.getFloat32(offset, true);
      offset += 4;
      const cy = view.getFloat32(offset, true);
      offset += 4;
      const radius = view.getFloat32(offset, true);
      offset += 4;
      const length = view.getUint8(offset);
      offset += 1;
      const text = decoder.decode(new Uint8Array(buf.buffer, buf.byteOffset + offset, length));
      helpers.broadcastRegional(store, playerId, cx, cy, radius, text);
      break;
    }
    case OPC.CHAT_PRIVATE: {
      let offset = 1;
      const targetHash = view.getUint32(offset, true);
      offset += 4;
      const length = view.getUint8(offset);
      offset += 1;
      const text = decoder.decode(new Uint8Array(buf.buffer, buf.byteOffset + offset, length));
      helpers.sendPrivate(store, playerId, targetHash, text);
      break;
    }
    case OPC.NAME: {
      let offset = 1;
      const length = view.getUint8(offset);
      offset += 1;
      const text = decoder.decode(new Uint8Array(buf.buffer, buf.byteOffset + offset, length)).slice(0, 24);
      store.setName(playerId, text);
      break;
    }
    case OPC.BEAM_REQ: {
      let offset = 1;
      const targetHash = view.getUint32(offset, true);
      offset += 4;
      const length = view.getUint8(offset);
      offset += 1;
      const text = decoder.decode(new Uint8Array(buf.buffer, buf.byteOffset + offset, length));
      helpers.forwardBeamRequest(store, playerId, targetHash, text);
      break;
    }
    case OPC.BEAM_RESP: {
      let offset = 1;
      const targetHash = view.getUint32(offset, true);
      offset += 4;
      const accept = view.getUint8(offset) | 0;
      offset += 1;
      const scene = view.getUint8(offset) | 0;
      offset += 1;
      const body = view.getUint32(offset, true) >>> 0;
      offset += 4;
      const tileX = view.getInt16(offset, true) | 0;
      offset += 2;
      const tileY = view.getInt16(offset, true) | 0;
      offset += 2;
      const ship = view.getUint32(offset, true) >>> 0;
      helpers.forwardBeamResponse(store, playerId, targetHash, accept, scene, body, tileX, tileY, ship);
      break;
    }
    case OPC.MOVE: {
      const sender = store.get(playerId);
      if (!sender) {
        return;
      }
      const payload = JSON.stringify({ type: 'move', from: hashId(playerId), x: view.getFloat32(1, true), y: view.getFloat32(5, true) });
      for (const viewer of store.interestFor(sender)) {
        safeSend(viewer.connections.ws, payload);
      }
      break;
    }
    default:
      break;
  }
}

function startSnapshotLoop(store: PlayerRegistry): void {
  const interval = 1000 / CONFIG.snapshotHz;
  setInterval(() => {
    const now = Date.now();
    const stalePlayers = store.pruneIdle(now, CONFIG.idleTimeoutMs);
    for (const player of stalePlayers) {
      try {
        player.connections.dc?.close();
      } catch {
        /* ignore */
      }
      try {
        player.connections.ws.close();
      } catch {
        /* ignore */
      }
    }

    for (const player of store.values()) {
      const visible = store.interestFor(player);
      const snapshotEntries: SnapshotEntry[] = visible.map((other) => ({
        id: other.id,
        x: other.x,
        y: other.y,
        name: other.name,
        scene: other.scene,
        body: other.body,
        tileX: other.tileX,
        tileY: other.tileY,
        ship: other.ship,
      }));
      const payload = encodeSnapshot(snapshotEntries);
      if (player.connections.dc && player.connections.dc.readyState === 'open') {
        safeSendChannel(player.connections.dc, payload);
      } else {
        safeSend(player.connections.ws, payload);
      }
    }
  }, interval);
}

const playerStore = new PlayerRegistry(CONFIG.cellSize, CONFIG.maxInterest);
const httpServer = createStaticServer();
const wrtc = await loadWrtc();
const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(CONFIG.port, () => {
  console.log(`[server] http+ws on :${CONFIG.port} (mode: ${wrtc ? 'webrtc' : 'ws'})`);
});

const messageHelpers = {
  broadcastRegional,
  sendPrivate,
  forwardBeamRequest,
  forwardBeamResponse,
};

wss.on('connection', (ws: WebSocket) => {
  const id = uuidv4();
  const pc = wrtc ? new wrtc.RTCPeerConnection({ iceServers: CONFIG.stunServers }) : null;
  const connections: PlayerConnections = { ws, pc, dc: null };

  const player: Player = {
    id,
    connections,
    x: 0,
    y: 0,
    lastSeen: Date.now(),
    name: '',
    scene: 0,
    body: 0,
    tileX: 0,
    tileY: 0,
    ship: 0,
  };
  playerStore.add(player);

  if (pc) {
    pc.ondatachannel = (event) => {
      if (event.channel.label !== 'game') {
        return;
      }
      connections.dc = event.channel;
      event.channel.onmessage = (ev) => handleBinaryMessage(playerStore, id, ev.data, messageHelpers);
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        safeSend(ws, JSON.stringify({ type: 'ice', candidate: event.candidate }));
      }
    };
  }

  ws.on('message', async (raw: WebSocket.RawData) => {
    if (Buffer.isBuffer(raw)) {
      handleBinaryMessage(playerStore, id, raw, messageHelpers);
      return;
    }
    try {
      const text = typeof raw === 'string' ? raw : raw.toString();
      const message = JSON.parse(text) as Record<string, unknown>;
      const type = typeof message.type === 'string' ? message.type : undefined;
      if (!pc || !wrtc) {
        if (type === 'offer' || type === 'ice') {
          safeSend(ws, JSON.stringify({ type: 'fallback', transport: 'ws', id }));
        }
        return;
      }
      if (type === 'offer' && typeof message.sdp === 'string') {
        await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
        const answer = await pc.createAnswer();
        const sdp = typeof answer.sdp === 'string' ? answer.sdp : '';
        await pc.setLocalDescription({ type: 'answer', sdp });
        safeSend(ws, JSON.stringify({ type: 'answer', sdp: pc.localDescription?.sdp ?? sdp, id }));
      } else if (type === 'ice' && 'candidate' in message) {
        await pc.addIceCandidate(message.candidate);
      }
    } catch {
      /* ignore malformed messages */
    }
  });

  ws.on('close', () => {
    const removed = playerStore.remove(id);
    if (!removed) {
      return;
    }
    try {
      removed.connections.dc?.close();
    } catch {
      /* ignore */
    }
    try {
      removed.connections.pc?.close();
    } catch {
      /* ignore */
    }
  });

  safeSend(ws, JSON.stringify({ type: 'welcome', id, mode: wrtc ? 'webrtc' : 'ws' }));
});

startSnapshotLoop(playerStore);
