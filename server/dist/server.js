// Einfacher Multiplayer-Server mit optionalem WebRTC und WS-Fallback
// - WebSocket: Signalisierung oder reiner Transport, wenn wrtc nicht verfügbar
// - WebRTC (wrtc): DataChannel "game" für binäre Updates/Snapshots
// - Autoritativer Snapshot-Versand mit einfachem Interessenfilter (Gitter)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let wrtc = null;
try {
    const mod = (await import('wrtc'));
    if (mod && typeof mod === 'object' && 'RTCPeerConnection' in mod) {
        wrtc = mod;
    }
}
catch {
    console.warn('[webrtc] wrtc not available, WS-only mode enabled');
}
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
// Spielerzustand
// scene: 0=space, 1=surface, 2=interior
const players = new Map();
// Räume (Interessenfilter)
const CELL = 6000;
const grid = new Map();
function cellKey(x, y) {
    const cx = Math.floor((x || 0) / CELL);
    const cy = Math.floor((y || 0) / CELL);
    return `${cx},${cy}`;
}
function gridAdd(id, x, y) {
    const key = cellKey(x, y);
    if (!grid.has(key)) {
        grid.set(key, new Set());
    }
    grid.get(key).add(id);
}
function gridMove(id, ox, oy, nx, ny) {
    const from = cellKey(ox, oy);
    const to = cellKey(nx, ny);
    if (from === to) {
        return;
    }
    grid.get(from)?.delete(id);
    gridAdd(id, nx, ny);
}
function gridRemove(id, x, y) {
    const key = cellKey(x, y);
    grid.get(key)?.delete(id);
}
// Protokoll
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
function hashId(id) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < id.length; i += 1) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}
function encodeSnapshot(_viewerId, list) {
    const count = list.length;
    let total = 1 + 2;
    const names = [];
    for (const entry of list) {
        const nameBytes = encoder.encode(entry.name ?? '');
        names.push(nameBytes);
        total += 4 + 4 + 4 + 1 + Math.min(255, nameBytes.length) + (1 + 4 + 2 + 2 + 4);
    }
    const buf = new ArrayBuffer(total);
    const view = new DataView(buf);
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
        new Uint8Array(buf, offset, nameLength).set(nameBytes.subarray(0, nameLength));
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
    return Buffer.from(buf);
}
function interestFor(player) {
    const result = [];
    const key = cellKey(player.x || 0, player.y || 0);
    const [cxRaw, cyRaw] = key.split(',');
    const cx = Number(cxRaw ?? '0');
    const cy = Number(cyRaw ?? '0');
    for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
            const set = grid.get(`${cx + dx},${cy + dy}`);
            if (!set) {
                continue;
            }
            for (const id of set) {
                if (id === player.id) {
                    continue;
                }
                const other = players.get(id);
                if (!other) {
                    continue;
                }
                if (player.scene !== other.scene) {
                    continue;
                }
                if (player.scene === 1 && player.body !== other.body) {
                    continue;
                }
                if (player.scene === 2 && player.ship !== other.ship) {
                    continue;
                }
                result.push(other);
            }
        }
    }
    result.sort((a, b) => {
        const da = (a.x - player.x) ** 2 + (a.y - player.y) ** 2;
        const db = (b.x - player.x) ** 2 + (b.y - player.y) ** 2;
        return da - db;
    });
    return result.slice(0, 128);
}
// Static file server
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
function resolveStaticRoot() {
    const indexPath = path.join(CLIENT_DIST, 'index.html');
    return fs.existsSync(indexPath) ? CLIENT_DIST : null;
}
let staticRoot = resolveStaticRoot();
if (!staticRoot) {
    console.warn(`[server] Kein Frontend-Build unter ${CLIENT_DIST}. HTTP-Auslieferung antwortet bis zum Build mit 503.`);
}
function sendFile(res, absolutePath) {
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
}
const server = http.createServer((req, res) => {
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
        if (requestPath === '/' || requestPath === '') {
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
const wss = new WebSocketServer({ server });
server.listen(PORT, () => {
    const root = staticRoot ?? 'kein Build';
    console.log(`[server] http+ws on :${PORT} (mode: ${wrtc ? 'webrtc' : 'ws'}), root=${root}`);
});
wss.on('connection', (ws) => {
    const id = uuidv4();
    const pc = wrtc ? new wrtc.RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }) : null;
    let dc = null;
    if (pc) {
        pc.ondatachannel = (event) => {
            if (event.channel.label !== 'game') {
                return;
            }
            dc = event.channel;
            const state = players.get(id);
            if (state) {
                state.dc = event.channel;
            }
            dc.onmessage = (ev) => handleBinaryMessage(id, ev.data);
        };
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                ws.send(JSON.stringify({ type: 'ice', candidate: event.candidate }));
            }
        };
    }
    ws.on('message', async (raw) => {
        if (Buffer.isBuffer(raw)) {
            handleBinaryMessage(id, raw);
            return;
        }
        try {
            const text = typeof raw === 'string' ? raw : raw.toString();
            const message = JSON.parse(text);
            const type = typeof message.type === 'string' ? message.type : undefined;
            if (!pc || !wrtc) {
                if (type === 'offer' || type === 'ice') {
                    ws.send(JSON.stringify({ type: 'fallback', transport: 'ws', id }));
                }
                return;
            }
            if (type === 'offer' && typeof message.sdp === 'string') {
                await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
                const answer = await pc.createAnswer();
                const sdp = typeof answer.sdp === 'string' ? answer.sdp : '';
                await pc.setLocalDescription({ type: 'answer', sdp });
                ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription?.sdp ?? sdp, id }));
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
        const player = players.get(id);
        if (!player) {
            return;
        }
        try {
            player.dc?.close();
        }
        catch {
            /* ignore */
        }
        try {
            player.pc?.close();
        }
        catch {
            /* ignore */
        }
        gridRemove(id, player.x || 0, player.y || 0);
        players.delete(id);
    });
    const player = {
        id,
        ws,
        pc,
        dc,
        x: 0,
        y: 0,
        last: Date.now(),
        name: '',
        scene: 0,
        body: 0,
        tileX: 0,
        tileY: 0,
        ship: 0,
    };
    players.set(id, player);
    gridAdd(id, 0, 0);
    ws.send(JSON.stringify({ type: 'welcome', id, mode: wrtc ? 'webrtc' : 'ws' }));
    function handleBinaryMessage(pid, data) {
        const buf = Buffer.isBuffer(data)
            ? data
            : data instanceof ArrayBuffer
                ? Buffer.from(new Uint8Array(data))
                : Buffer.from(data);
        if (buf.length < 1) {
            return;
        }
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const op = view.getUint8(0);
        if (op === OPC.UPDATE) {
            const x = view.getFloat32(1, true);
            const y = view.getFloat32(5, true);
            const target = players.get(pid);
            if (!target) {
                return;
            }
            const ox = target.x || 0;
            const oy = target.y || 0;
            target.x = x;
            target.y = y;
            target.last = Date.now();
            gridMove(pid, ox, oy, x, y);
        }
        else if (op === OPC.STATE) {
            const target = players.get(pid);
            if (!target) {
                return;
            }
            let offset = 1;
            target.scene = view.getUint8(offset) | 0;
            offset += 1;
            target.body = view.getUint32(offset, true) >>> 0;
            offset += 4;
            target.tileX = view.getInt16(offset, true) | 0;
            offset += 2;
            target.tileY = view.getInt16(offset, true) | 0;
            offset += 2;
            target.ship = view.getUint32(offset, true) >>> 0;
            target.last = Date.now();
        }
        else if (op === OPC.CHAT_PUBLIC) {
            let offset = 1;
            const cx = view.getFloat32(offset, true);
            offset += 4;
            const cy = view.getFloat32(offset, true);
            offset += 4;
            const radius = view.getFloat32(offset, true);
            offset += 4;
            const length = view.getUint8(offset);
            offset += 1;
            const textBytes = new Uint8Array(buf.buffer, buf.byteOffset + offset, length);
            const text = decoder.decode(textBytes);
            broadcastRegional(pid, cx, cy, radius, text);
        }
        else if (op === OPC.CHAT_PRIVATE) {
            let offset = 1;
            const targetHash = view.getUint32(offset, true);
            offset += 4;
            const length = view.getUint8(offset);
            offset += 1;
            const textBytes = new Uint8Array(buf.buffer, buf.byteOffset + offset, length);
            const text = decoder.decode(textBytes);
            sendPrivate(pid, targetHash, text);
        }
        else if (op === OPC.NAME) {
            let offset = 1;
            const length = view.getUint8(offset);
            offset += 1;
            const textBytes = new Uint8Array(buf.buffer, buf.byteOffset + offset, length);
            const text = decoder.decode(textBytes);
            const target = players.get(pid);
            if (target) {
                target.name = text.slice(0, 24);
            }
        }
        else if (op === OPC.BEAM_REQ) {
            let offset = 1;
            const targetHash = view.getUint32(offset, true);
            offset += 4;
            const length = view.getUint8(offset);
            offset += 1;
            const textBytes = new Uint8Array(buf.buffer, buf.byteOffset + offset, length);
            const text = decoder.decode(textBytes);
            forwardBeamRequest(pid, targetHash, text);
        }
        else if (op === OPC.BEAM_RESP) {
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
            forwardBeamResponse(pid, targetHash, accept, scene, body, tileX, tileY, ship);
        }
        else if (op === OPC.MOVE) {
            const sender = players.get(pid);
            if (!sender || sender.ws.readyState !== WebSocket.OPEN) {
                return;
            }
            const tx = view.getFloat32(1, true);
            const ty = view.getFloat32(5, true);
            const payload = JSON.stringify({ type: 'move', from: hashId(pid), x: tx, y: ty });
            const viewers = interestFor(sender);
            for (const viewer of viewers) {
                if (viewer.ws.readyState !== WebSocket.OPEN) {
                    continue;
                }
                try {
                    viewer.ws.send(payload);
                }
                catch {
                    /* ignore send failure */
                }
            }
        }
    }
});
setInterval(() => {
    const now = Date.now();
    for (const player of players.values()) {
        if (now - player.last > 30_000) {
            try {
                player.dc?.close();
            }
            catch {
                /* ignore */
            }
            try {
                player.ws.close();
            }
            catch {
                /* ignore */
            }
            continue;
        }
        const visible = interestFor(player);
        const snapshotEntries = visible.map((p) => ({
            id: p.id,
            x: p.x,
            y: p.y,
            name: p.name,
            scene: p.scene,
            body: p.body,
            tileX: p.tileX,
            tileY: p.tileY,
            ship: p.ship,
        }));
        const snap = encodeSnapshot(player.id, snapshotEntries);
        if (player.dc && player.dc.readyState === 'open') {
            try {
                player.dc.send(snap);
            }
            catch {
                /* ignore */
            }
        }
        else if (player.ws.readyState === WebSocket.OPEN) {
            try {
                player.ws.send(snap);
            }
            catch {
                /* ignore */
            }
        }
    }
}, 1000 / 15);
function broadcastRegional(fromId, cx, cy, radius, text) {
    const sender = players.get(fromId);
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
    for (const player of players.values()) {
        if (player.ws.readyState !== WebSocket.OPEN) {
            continue;
        }
        const dx = (player.x || 0) - cx;
        const dy = (player.y || 0) - cy;
        if (dx * dx + dy * dy > radiusSquared) {
            continue;
        }
        try {
            player.ws.send(payload);
        }
        catch {
            /* ignore */
        }
    }
}
function sendPrivate(fromId, targetHash, text) {
    const sender = players.get(fromId);
    if (!sender) {
        return;
    }
    const recipient = [...players.values()].find((player) => hashId(player.id) === targetHash);
    if (!recipient || recipient.ws.readyState !== WebSocket.OPEN) {
        return;
    }
    const payload = JSON.stringify({ type: 'chat:private', from: hashId(fromId), name: sender.name || '', text });
    try {
        recipient.ws.send(payload);
    }
    catch {
        /* ignore */
    }
}
function forwardBeamRequest(fromId, targetHash, text) {
    const sender = players.get(fromId);
    const recipient = [...players.values()].find((player) => hashId(player.id) === targetHash);
    if (!sender || !recipient || recipient.ws.readyState !== WebSocket.OPEN) {
        return;
    }
    const payload = JSON.stringify({
        type: 'beam:req',
        from: hashId(fromId),
        name: sender.name || '',
        text: text || '',
    });
    try {
        recipient.ws.send(payload);
    }
    catch {
        /* ignore */
    }
}
function forwardBeamResponse(fromId, targetHash, accept, scene, body, tileX, tileY, ship) {
    const sender = players.get(fromId);
    const recipient = [...players.values()].find((player) => hashId(player.id) === targetHash);
    if (!sender || !recipient || recipient.ws.readyState !== WebSocket.OPEN) {
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
    try {
        recipient.ws.send(payload);
    }
    catch {
        /* ignore */
    }
}
