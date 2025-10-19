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

// Optional wrtc laden (Node-native Modul). Bei Fehlschlag -> WS-Fallback.
let wrtc = null;
try {
  const mod = await import('wrtc');
  wrtc = mod.default || mod;
} catch (e) {
  console.warn('[webrtc] wrtc not available, WS-only mode enabled');
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

// Spielerzustand
// scene: 0=space, 1=surface, 2=interior
const players = new Map(); // id -> { id, ws, pc?, dc?, x, y, last, name, scene, body, tileX, tileY, ship }

// Räume (Interessenfilter)
const CELL = 6000;
const grid = new Map(); // key -> Set<id>
function cellKey(x, y) { const cx = Math.floor((x||0) / CELL), cy = Math.floor((y||0) / CELL); return `${cx},${cy}`; }
function gridAdd(id, x, y) { const k = cellKey(x, y); if (!grid.has(k)) grid.set(k, new Set()); grid.get(k).add(id); }
function gridMove(id, ox, oy, nx, ny) { const ko = cellKey(ox, oy), kn = cellKey(nx, ny); if (ko === kn) return; if (grid.has(ko)) grid.get(ko).delete(id); gridAdd(id, nx, ny); }
function gridRemove(id, x, y) { const k = cellKey(x, y); if (grid.has(k)) grid.get(k).delete(id); }

// Protokoll
const OPC = { UPDATE: 0x75, SNAPSHOT: 0x73, CHAT_PUBLIC: 0x63, CHAT_PRIVATE: 0x70, NAME: 0x6e, STATE: 0x53, BEAM_REQ: 0x62, BEAM_RESP: 0x72, MOVE: 0x6d };
function hashId(id) { let h = 2166136261 >>> 0; for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function encodeSnapshot(_viewerId, list) {
  const count = list.length;
  // variable length per entry for name (1 byte length + bytes)
  // precompute total length
  let total = 1 + 2; const enc = new TextEncoder(); const names = [];
  for (const p of list) { const nameBytes = enc.encode(p.name || ''); names.push(nameBytes); total += (4 + 4 + 4 + 1 + Math.min(255, nameBytes.length) + (1 + 4 + 2 + 2 + 4)); }
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf); let o = 0; dv.setUint8(o++, OPC.SNAPSHOT); dv.setUint16(o, count, true); o += 2;
  for (let i = 0; i < list.length; i++) {
    const p = list[i]; const nb = names[i];
    dv.setUint32(o, hashId(p.id), true); o += 4; dv.setFloat32(o, p.x||0, true); o += 4; dv.setFloat32(o, p.y||0, true); o += 4;
    const ln = Math.min(255, nb.length); dv.setUint8(o++, ln); new Uint8Array(buf, o).set(nb.subarray(0, ln)); o += ln;
    // extended scene info
    dv.setUint8(o++, (p.scene||0) & 0xff);
    dv.setUint32(o, (p.body||0) >>> 0, true); o += 4;
    dv.setInt16(o, (p.tileX||0)|0, true); o += 2;
    dv.setInt16(o, (p.tileY||0)|0, true); o += 2;
    dv.setUint32(o, (p.ship||0) >>> 0, true); o += 4;
  }
  return Buffer.from(buf);
}
function interestFor(p) {
  const res = []; const [cx, cy] = cellKey(p.x||0, p.y||0).split(',').map(Number);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const set = grid.get(`${cx+dx},${cy+dy}`); if (!set) continue;
    for (const id of set) if (id !== p.id) {
      const q = players.get(id); if (!q) continue;
      // Scenes/body must match to be relevant unless in space
      if ((p.scene||0) !== (q.scene||0)) continue;
      if ((p.scene||0) === 1 /* surface */ && (p.body||0) !== (q.body||0)) continue;
      if ((p.scene||0) === 2 /* interior */ && (p.ship||0) !== (q.ship||0)) continue;
      res.push(q);
    }
  }
  res.sort((a,b)=>((a.x-p.x)**2+(a.y-p.y)**2)-((b.x-p.x)**2+(b.y-p.y)**2));
  return res.slice(0,128);
}

// Static file server
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');
const NO_BUILD_MSG = 'Frontend build nicht gefunden. Bitte `pnpm build` im Projektwurzelverzeichnis ausführen.';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
};
function resolveStaticRoot() {
  const indexPath = path.join(CLIENT_DIST, 'index.html');
  return fs.existsSync(indexPath) ? CLIENT_DIST : null;
}

let staticRoot = resolveStaticRoot();
if (!staticRoot) {
  console.warn(`[server] Kein Frontend-Build unter ${CLIENT_DIST}. HTTP-Auslieferung antwortet bis zum Build mit 503.`);
}

function sendFile(res, p) {
  fs.readFile(p, (err, data) => {
    if (err) { res.statusCode = 404; res.end('Not found'); return; }
    const ext = path.extname(p).toLowerCase(); res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=3600'); res.end(data);
  });
}
const server = http.createServer((req, res) => {
  const root = staticRoot || resolveStaticRoot();
  if (!root) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(NO_BUILD_MSG);
    return;
  }
  staticRoot = root;
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/' || urlPath === '') return sendFile(res, path.join(root, 'index.html'));
    const abs = path.normalize(path.join(root, urlPath));
    if (!abs.startsWith(root)) { res.statusCode = 403; return res.end('Forbidden'); }
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return sendFile(res, abs);
    // SPA fallback to index.html
    return sendFile(res, path.join(root, 'index.html'));
  } catch {
    res.statusCode = 500; res.end('Server error');
  }
});

const wss = new WebSocketServer({ server });
server.listen(PORT, () => {
  const root = staticRoot || 'kein Build';
  console.log(`[server] http+ws on :${PORT} (mode: ${wrtc ? 'webrtc' : 'ws'}), root=${root}`);
});

wss.on('connection', (ws) => {
  const id = uuidv4();
  const pc = wrtc ? new wrtc.RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }) : null;
  let dc = null;

  if (pc) {
    pc.ondatachannel = (e) => {
  if (e.channel.label !== 'game') return; dc = e.channel;
  dc.onmessage = (ev) => handleBinaryMessage(id, ev.data);
    };
    pc.onicecandidate = (e) => { if (e.candidate) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate })); };
  }

  // Nachrichten über WebSocket: Signalisierung oder Binärupdates im Fallback
  ws.on('message', async (raw) => {
    if (Buffer.isBuffer(raw)) { handleBinaryMessage(id, raw); return; }
    try {
      const msg = JSON.parse(raw.toString());
      if (!pc || !wrtc) {
        // Kein WebRTC: Client informieren, dass WS genutzt wird
        if (msg.type === 'offer' || msg.type === 'ice') ws.send(JSON.stringify({ type: 'fallback', transport: 'ws', id }));
        return;
      }
      if (msg.type === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription.sdp, id }));
      } else if (msg.type === 'ice') {
        if (msg.candidate) await pc.addIceCandidate(msg.candidate);
      }
    } catch (e) { /* ignore */ }
  });

  ws.on('close', () => {
    const p = players.get(id); if (!p) return;
    try { p.dc && p.dc.close(); } catch {}
    try { p.pc && p.pc.close(); } catch {}
    gridRemove(id, p.x||0, p.y||0); players.delete(id);
  });

  // Spieler registrieren
  players.set(id, { id, ws, pc, dc, x: 0, y: 0, last: Date.now(), name: '', scene: 0, body: 0, tileX: 0, tileY: 0, ship: 0 });
  gridAdd(id, 0, 0);
  ws.send(JSON.stringify({ type: 'welcome', id, mode: wrtc ? 'webrtc' : 'ws' }));

  function handleBinaryMessage(pid, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!buf || buf.length < 1) return;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const op = dv.getUint8(0);
    if (op === OPC.UPDATE) {
      const x = dv.getFloat32(1, true); const y = dv.getFloat32(5, true);
      const p = players.get(pid); if (!p) return;
      const ox = p.x||0, oy = p.y||0; p.x = x; p.y = y; p.last = Date.now(); gridMove(pid, ox, oy, x, y);
      // No direct broadcast here; snapshots are sent on tick
    } else if (op === OPC.STATE) {
      // presence update from client: scene/body/tile/ship
      const p = players.get(pid); if (!p) return; let o = 1;
      p.scene = dv.getUint8(o++)|0;
      p.body = dv.getUint32(o, true)>>>0; o += 4;
      p.tileX = dv.getInt16(o, true)|0; o += 2;
      p.tileY = dv.getInt16(o, true)|0; o += 2;
      p.ship = dv.getUint32(o, true)>>>0; o += 4; p.last = Date.now();
    } else if (op === OPC.CHAT_PUBLIC) {
      let o = 1; const cx = dv.getFloat32(o, true); o+=4; const cy = dv.getFloat32(o, true); o+=4; const r = dv.getFloat32(o, true); o+=4;
      const ln = dv.getUint8(o); o+=1; const text = new TextDecoder().decode(new Uint8Array(buf.buffer, buf.byteOffset+o, ln));
      broadcastRegional(pid, cx, cy, r, text);
    } else if (op === OPC.CHAT_PRIVATE) {
      let o = 1; const targetHash = dv.getUint32(o, true); o+=4; const ln = dv.getUint8(o); o+=1; const text = new TextDecoder().decode(new Uint8Array(buf.buffer, buf.byteOffset+o, ln));
      sendPrivate(pid, targetHash, text);
    } else if (op === OPC.NAME) {
      let o = 1; const ln = dv.getUint8(o); o += 1; const text = new TextDecoder().decode(new Uint8Array(buf.buffer, buf.byteOffset+o, ln));
      const p = players.get(pid); if (p) p.name = (text || '').slice(0, 24);
  } else if (op === OPC.BEAM_REQ) {
      // forward beam request to target
      let o = 1; const targetHash = dv.getUint32(o, true); o += 4; const ln = dv.getUint8(o); o += 1; const text = new TextDecoder().decode(new Uint8Array(buf.buffer, buf.byteOffset+o, ln));
      forwardBeamRequest(pid, targetHash, text);
  } else if (op === OPC.BEAM_RESP) {
      // forward response back to requester
      let o = 1; const targetHash = dv.getUint32(o, true); o += 4; const accept = dv.getUint8(o++)|0; const scene = dv.getUint8(o++)|0; const body = dv.getUint32(o, true)>>>0; o+=4; const tileX = dv.getInt16(o, true)|0; o+=2; const tileY = dv.getInt16(o, true)|0; o+=2; const ship = dv.getUint32(o, true)>>>0; o+=4;
      forwardBeamResponse(pid, targetHash, accept, scene, body, tileX, tileY, ship);
    } else if (op === OPC.MOVE) {
      // Forward move target to nearby interested players (regional event)
      const p = players.get(pid); if (!p || !p.ws || p.ws.readyState !== WebSocket.OPEN) return;
      const tx = dv.getFloat32(1, true); const ty = dv.getFloat32(5, true);
      const payload = JSON.stringify({ type: 'move', from: hashId(pid), x: tx, y: ty });
      // Send to viewers in interest grid with same scene context
      const viewers = interestFor(p);
      for (const v of viewers) {
        if (!v.ws || v.ws.readyState !== WebSocket.OPEN) continue;
        try { v.ws.send(payload); } catch {}
      }
    }
  }
});

// Snapshot-Loop
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) {
    if (now - (p.last||0) > 30000) { try { p.dc && p.dc.close(); } catch {}; try { p.ws && p.ws.close(); } catch {}; continue; }
    const vis = interestFor(p); const snap = encodeSnapshot(p.id, vis);
    if (p.dc && p.dc.readyState === 'open') { try { p.dc.send(snap); } catch {} }
    else if (p.ws && p.ws.readyState === WebSocket.OPEN) { try { p.ws.send(snap); } catch {} }
  }
}, 1000/15);

function broadcastRegional(fromId, cx, cy, radius, text) {
  const sender = players.get(fromId); if (!sender) return;
  const payload = JSON.stringify({ type: 'chat:regional', from: hashId(fromId), name: sender.name || '', x: cx, y: cy, text });
  const r2 = radius*radius;
  for (const p of players.values()) {
    if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
    const dx = (p.x||0) - cx; const dy = (p.y||0) - cy; if (dx*dx + dy*dy > r2) continue;
    try { p.ws.send(payload); } catch {}
  }
}

function sendPrivate(fromId, targetHash, text) {
  const sender = players.get(fromId); if (!sender) return;
  const to = [...players.values()].find(p => hashId(p.id) === targetHash);
  if (!to || !to.ws || to.ws.readyState !== WebSocket.OPEN) return;
  const payload = JSON.stringify({ type: 'chat:private', from: hashId(fromId), name: sender.name || '', text });
  try { to.ws.send(payload); } catch {}
}

function forwardBeamRequest(fromId, targetHash, text) {
  const to = [...players.values()].find(p => hashId(p.id) === targetHash);
  const sender = players.get(fromId);
  if (!to || !sender || !to.ws || to.ws.readyState !== WebSocket.OPEN) return;
  const payload = JSON.stringify({ type: 'beam:req', from: hashId(fromId), name: sender.name || '', text: text || '' });
  try { to.ws.send(payload); } catch {}
}

function forwardBeamResponse(fromId, targetHash, accept, scene, body, tileX, tileY, ship) {
  const to = [...players.values()].find(p => hashId(p.id) === targetHash);
  const sender = players.get(fromId);
  if (!to || !sender || !to.ws || to.ws.readyState !== WebSocket.OPEN) return;
  const payload = JSON.stringify({ type: 'beam:resp', from: hashId(fromId), name: sender.name || '', accept: !!accept, scene: scene|0, body: body>>>0, tileX: tileX|0, tileY: tileY|0, ship: ship>>>0 });
  try { to.ws.send(payload); } catch {}
}
