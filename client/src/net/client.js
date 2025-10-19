// WebRTC-Client: Verbindet per WS (Signalisierung) und DataChannel (Spiel)
// Skalierung: Server ist Gegenstelle; Datenkanal unordered/unreliable für Bewegungen

import { encodeUpdate, decodeSnapshot, encodeChatPublic, encodeChatPrivate, encodeName, encodeState, OPC, encodeBeamRequest, encodeBeamResponse, encodeMove } from './protocol.js';

export class NetClient {
  constructor({ url = 'ws://localhost:8080', onSnapshot }) {
    this.url = url;
    this.onSnapshot = onSnapshot;
    this.ws = null;
    this.pc = null;
    this.dc = null;
    this.id = null;
    this.connected = false;
    this._lastSend = 0;
  this._lastState = 0;
  this._fallbackWS = false;
  this.onChat = null; // (event) => void, event: { type: 'regional'|'private', from, name, text, x?, y? }
  this.onBeamRequest = null; // (evt) => void, { from, name, text }
  this.onBeamResponse = null; // (evt) => void, { from, name, accept, scene, body, tileX, tileY, ship }
  }

  async connect() {
    return new Promise((resolve) => {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = async () => {
        // Versuche WebRTC, ansonsten WS-Fallback
        if (typeof RTCPeerConnection !== 'undefined') {
          this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
          this.dc = this.pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 });
          this.dc.binaryType = 'arraybuffer';
          this.dc.onopen = () => { this.connected = true; this._sendNameIfAny(); resolve(true); };
          this.dc.onmessage = (e) => {
            if (!(e.data instanceof ArrayBuffer)) return;
            const list = decodeSnapshot(e.data);
            if (list && this.onSnapshot) this.onSnapshot(list);
          };
          this.pc.onicecandidate = (e) => { if (e.candidate) this.ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate })); };
          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);
          this.ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
        } else {
          // Kein WebRTC im Kontext
          this._enableWSFallback(resolve);
        }
      };
      this.ws.onmessage = async (ev) => {
        // Kann Binär (Snapshot) oder JSON (Signalisierung/Fallback) sein
  if (ev.data instanceof ArrayBuffer) {
          const list = decodeSnapshot(ev.data); if (list && this.onSnapshot) this.onSnapshot(list); return;
        }
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'answer') {
            if (this.pc) { await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); }
            this.id = msg.id || this.id; this._sendNameIfAny();
          } else if (msg.type === 'ice') {
            if (msg.candidate && this.pc) await this.pc.addIceCandidate(msg.candidate);
          } else if (msg.type === 'welcome') {
            this.id = msg.id; if (msg.mode === 'ws' && !this._fallbackWS) this._enableWSFallback(); this._sendNameIfAny();
          } else if (msg.type === 'fallback' && msg.transport === 'ws') {
            this._enableWSFallback();
          } else if (msg.type === 'chat:regional') {
            this.onChat && this.onChat({ type: 'regional', from: msg.from, name: msg.name, text: msg.text, x: msg.x, y: msg.y });
          } else if (msg.type === 'chat:private') {
            this.onChat && this.onChat({ type: 'private', from: msg.from, name: msg.name, text: msg.text });
          } else if (msg.type === 'beam:req') {
            this.onBeamRequest && this.onBeamRequest({ from: msg.from>>>0, name: msg.name||'', text: msg.text||'' });
          } else if (msg.type === 'beam:resp') {
            this.onBeamResponse && this.onBeamResponse({ from: msg.from>>>0, name: msg.name||'', accept: !!msg.accept, scene: msg.scene|0, body: msg.body>>>0, tileX: msg.tileX|0, tileY: msg.tileY|0, ship: msg.ship>>>0 });
          } else if (msg.type === 'move') {
            // Movement target of a remote ship; let the app handle simulation if desired
            this.onRemoteMove && this.onRemoteMove({ from: msg.from>>>0, x: msg.x, y: msg.y });
          }
        } catch {}
      };
      this.ws.onerror = () => resolve(false);
      this.ws.onclose = () => { this.connected = false; };
    });
  }

  _enableWSFallback(resolve) {
    this._fallbackWS = true;
    this.dc = null; this.pc = null; // Nur WS verwenden
    this.connected = true; if (resolve) resolve(true);
  }

  sendChatPublic(cx, cy, radius, text) {
    const buf = encodeChatPublic(cx, cy, Math.max(100, radius||0), text);
    if (this._fallbackWS) { try { if (this.ws && this.ws.readyState === 1) this.ws.send(buf); } catch {} }
    else if (this.dc && this.dc.readyState === 'open') { try { this.dc.send(buf); } catch {} }
  }

  sendChatPrivate(targetHash, text) {
    const buf = encodeChatPrivate(targetHash, text);
    if (this._fallbackWS) { try { if (this.ws && this.ws.readyState === 1) this.ws.send(buf); } catch {} }
    else if (this.dc && this.dc.readyState === 'open') { try { this.dc.send(buf); } catch {} }
  }

  setName(name) { this._name = (name || '').slice(0, 24); this._sendNameIfAny(); }
  _sendNameIfAny() {
    if (!this._name) return; const buf = encodeName(this._name);
    if (this._fallbackWS) { try { if (this.ws && this.ws.readyState === 1) this.ws.send(buf); } catch {} }
    else if (this.dc && this.dc.readyState === 'open') { try { this.dc.send(buf); } catch {} }
  }

  // Keep for compatibility when needed
  sendPosition(x, y) {
    const now = performance.now(); if (now - this._lastSend < 1000/10) return; this._lastSend = now;
    const buf = encodeUpdate(x, y);
    if (this._fallbackWS) { try { this.ws && this.ws.readyState === 1 ? this.ws.send(buf) : null; } catch {} }
    else if (this.dc && this.dc.readyState === 'open') { try { this.dc.send(buf); } catch {} }
  }

  sendMoveTarget(x, y) {
    const buf = encodeMove(x, y);
    if (this._fallbackWS) { try { this.ws && this.ws.readyState === 1 ? this.ws.send(buf) : null; } catch {} }
    else if (this.dc && this.dc.readyState === 'open') { try { this.dc.send(buf); } catch {} }
  }

  sendState(scene, body, tileX, tileY, ship) {
    const now = performance.now(); if (now - this._lastState < 1000/4) return; // 4 Hz
    this._lastState = now;
    const buf = encodeState(scene, body, tileX, tileY, ship);
    if (this._fallbackWS) { try { this.ws && this.ws.readyState === 1 ? this.ws.send(buf) : null; } catch {} }
    else if (this.dc && this.dc.readyState === 'open') { try { this.dc.send(buf); } catch {} }
  }

  requestBeam(targetHash, text = '') {
    const buf = encodeBeamRequest(targetHash>>>0, text);
    if (this._fallbackWS) { try { this.ws && this.ws.readyState === 1 ? this.ws.send(buf) : null; } catch {} }
    else if (this.dc && this.dc.readyState === 'open') { try { this.dc.send(buf); } catch {} }
  }

  respondBeam(targetHash, accept, scene = 0, body = 0, tileX = 0, tileY = 0, ship = 0) {
    const buf = encodeBeamResponse(targetHash>>>0, !!accept, scene|0, body>>>0, tileX|0, tileY|0, ship>>>0);
    if (this._fallbackWS) { try { this.ws && this.ws.readyState === 1 ? this.ws.send(buf) : null; } catch {} }
    else if (this.dc && this.dc.readyState === 'open') { try { this.dc.send(buf); } catch {} }
  }
}
