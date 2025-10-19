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
const CONFIG = {
    port: process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8080,
    snapshotHz: 15,
    idleTimeoutMs: 30_000,
    cellSize: 6_000,
    maxInterest: 128,
    stunServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
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
};
class PlayerRegistry {
    cellSize;
    maxInterest;
    players = new Map();
    cells = new Map();
    constructor(cellSize, maxInterest) {
        this.cellSize = cellSize;
        this.maxInterest = maxInterest;
    }
    add(player) {
        this.players.set(player.id, player);
        this.addToGrid(player.id, player.x, player.y);
    }
    remove(id) {
        const player = this.players.get(id) ?? null;
        if (!player) {
            return null;
        }
        this.removeFromGrid(id, player.x, player.y);
        this.players.delete(id);
        return player;
    }
    get(id) {
        return this.players.get(id) ?? null;
    }
    updatePosition(id, x, y, seen) {
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
    updatePresence(id, details, seen) {
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
    setName(id, name) {
        const player = this.players.get(id);
        if (!player) {
            return;
        }
        player.name = name;
    }
    touch(id, seen) {
        const player = this.players.get(id);
        if (player) {
            player.lastSeen = seen;
        }
    }
    values() {
        return this.players.values();
    }
    findByHash(hash) {
        for (const player of this.players.values()) {
            if (hashId(player.id) === hash) {
                return player;
            }
        }
        return null;
    }
    interestFor(player) {
        const originKey = this.cellKey(player.x, player.y);
        const [cxRaw, cyRaw] = originKey.split(',');
        const cx = Number(cxRaw ?? '0');
        const cy = Number(cyRaw ?? '0');
        const nearby = [];
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
    pruneIdle(now, timeoutMs) {
        const removed = [];
        for (const player of Array.from(this.players.values())) {
            if (now - player.lastSeen > timeoutMs) {
                removed.push(player);
                this.remove(player.id);
            }
        }
        return removed;
    }
    cellKey(x, y) {
        const cx = Math.floor((x || 0) / this.cellSize);
        const cy = Math.floor((y || 0) / this.cellSize);
        return `${cx},${cy}`;
    }
    ensureCell(key) {
        let bucket = this.cells.get(key);
        if (!bucket) {
            bucket = new Set();
            this.cells.set(key, bucket);
        }
        return bucket;
    }
    addToGrid(id, x, y, key) {
        const cell = this.ensureCell(key ?? this.cellKey(x, y));
        cell.add(id);
    }
    removeFromGrid(id, x, y, key) {
        const bucket = this.cells.get(key ?? this.cellKey(x, y));
        bucket?.delete(id);
    }
}
function hashId(id) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < id.length; i += 1) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}
function encodeSnapshot(list) {
    const count = list.length;
    let total = 1 + 2;
    const names = [];
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
        const entry = list[i];
        const nameBytes = names[i];
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
function toBuffer(data) {
    if (Buffer.isBuffer(data)) {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(new Uint8Array(data));
    }
    return Buffer.from(data);
}
function safeSend(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) {
        return;
    }
    try {
        ws.send(payload);
    }
    catch {
        /* ignore */
    }
}
function safeSendChannel(dc, payload) {
    if (!dc || dc.readyState !== 'open') {
        return;
    }
    try {
        dc.send(payload);
    }
    catch {
        /* ignore */
    }
}
function createStaticServer() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');
    const NO_BUILD_MSG = 'Frontend build nicht gefunden. Bitte `pnpm build` im Projektwurzelverzeichnis ausführen.';
    const MIME = {
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
    const resolveStaticRoot = () => {
        const indexPath = path.join(CLIENT_DIST, 'index.html');
        return fs.existsSync(indexPath) ? CLIENT_DIST : null;
    };
    let staticRoot = resolveStaticRoot();
    if (!staticRoot) {
        console.warn(`[server] Kein Frontend-Build unter ${CLIENT_DIST}. HTTP-Auslieferung antwortet bis zum Build mit 503.`);
    }
    const sendFile = (res, absolutePath) => {
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
        }
        catch {
            res.statusCode = 500;
            res.end('Server error');
        }
    });
}
async function loadWrtc() {
    try {
        const mod = (await import('wrtc'));
        if (mod && typeof mod === 'object' && 'RTCPeerConnection' in mod) {
            return mod;
        }
    }
    catch {
        console.warn('[webrtc] wrtc not available, WS-only mode enabled');
    }
    return null;
}
function broadcastRegional(store, fromId, cx, cy, radius, text) {
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
function sendPrivate(store, fromId, targetHash, text) {
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
function forwardBeamRequest(store, fromId, targetHash, text) {
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
function forwardBeamResponse(store, fromId, targetHash, accept, scene, body, tileX, tileY, ship) {
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
function handleBinaryMessage(store, playerId, raw, helpers) {
    const buf = toBuffer(raw);
    if (buf.length < 1) {
        return;
    }
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const opcode = view.getUint8(0);
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
function startSnapshotLoop(store) {
    const interval = 1000 / CONFIG.snapshotHz;
    setInterval(() => {
        const now = Date.now();
        const stalePlayers = store.pruneIdle(now, CONFIG.idleTimeoutMs);
        for (const player of stalePlayers) {
            try {
                player.connections.dc?.close();
            }
            catch {
                /* ignore */
            }
            try {
                player.connections.ws.close();
            }
            catch {
                /* ignore */
            }
        }
        for (const player of store.values()) {
            const visible = store.interestFor(player);
            const snapshotEntries = visible.map((other) => ({
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
            }
            else {
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
wss.on('connection', (ws) => {
    const id = uuidv4();
    const pc = wrtc ? new wrtc.RTCPeerConnection({ iceServers: CONFIG.stunServers }) : null;
    const connections = { ws, pc, dc: null };
    const player = {
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
    ws.on('message', async (raw) => {
        if (Buffer.isBuffer(raw)) {
            handleBinaryMessage(playerStore, id, raw, messageHelpers);
            return;
        }
        try {
            const text = typeof raw === 'string' ? raw : raw.toString();
            const message = JSON.parse(text);
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
            }
            else if (type === 'ice' && 'candidate' in message) {
                await pc.addIceCandidate(message.candidate);
            }
        }
        catch {
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
        }
        catch {
            /* ignore */
        }
        try {
            removed.connections.pc?.close();
        }
        catch {
            /* ignore */
        }
    });
    safeSend(ws, JSON.stringify({ type: 'welcome', id, mode: wrtc ? 'webrtc' : 'ws' }));
});
startSnapshotLoop(playerStore);
