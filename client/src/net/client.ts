// WebRTC-Client: Verbindet per WS (Signalisierung) und DataChannel (Spiel)
// Skalierung: Server ist Gegenstelle; Datenkanal unordered/unreliable für Bewegungen

import {
  encodeUpdate,
  decodeSnapshot,
  encodeChatPublic,
  encodeChatPrivate,
  encodeName,
  encodeState,
  OPC,
  encodeBeamRequest,
  encodeBeamResponse,
  encodeMove,
  SnapshotEntry,
} from './protocol.ts';

export type ChatEvent =
  | { type: 'regional'; from: number; name: string; text: string; x: number; y: number }
  | { type: 'private'; from: number; name: string; text: string };

export interface BeamRequestEvent {
  from: number;
  name: string;
  text: string;
}

export interface BeamResponseEvent {
  from: number;
  name: string;
  accept: boolean;
  scene: number;
  body: number;
  tileX: number;
  tileY: number;
  ship: number;
}

export interface RemoteMoveEvent {
  from: number;
  x: number;
  y: number;
}

export interface NetClientOptions {
  url?: string;
  onSnapshot?: (list: SnapshotEntry[]) => void;
  token?: string;
}

type MaybeDataChannel = RTCDataChannel | null;

enum ConnectionTransport {
  WebSocket = 'ws',
  WebRTC = 'webrtc',
}

export class NetClient {
  readonly url: string;
  private readonly onSnapshot: ((list: SnapshotEntry[]) => void) | undefined;
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: MaybeDataChannel = null;
  private _name = '';
  private lastPositionSend = 0;
  private lastStateSend = 0;
  private fallbackWS = false;
  private readonly token: string;

  id: string | null = null;
  connected = false;

  onChat: ((event: ChatEvent) => void) | null = null;
  onBeamRequest: ((event: BeamRequestEvent) => void) | null = null;
  onBeamResponse: ((event: BeamResponseEvent) => void) | null = null;
  onRemoteMove: ((event: RemoteMoveEvent) => void) | null = null;

  constructor({ url = 'ws://localhost:8080', onSnapshot, token = '' }: NetClientOptions) {
    this.url = url;
    this.onSnapshot = onSnapshot;
    this.token = token;
  }

  async connect(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const targetUrl = this.composeUrl();
      this.ws = new WebSocket(targetUrl);
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = async () => {
        if (typeof RTCPeerConnection !== 'undefined') {
          this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
          const channel = this.pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 });
          channel.binaryType = 'arraybuffer';
          this.dc = channel;
          channel.onopen = () => {
            this.connected = true;
            this.sendNameIfAny();
            settle(true);
          };
          channel.onmessage = (event) => {
            if (!(event.data instanceof ArrayBuffer)) {
              return;
            }
            const list = decodeSnapshot(event.data);
            if (list.length && this.onSnapshot) {
              this.onSnapshot(list);
            }
          };
          this.pc.onicecandidate = (event) => {
            if (event.candidate && this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ type: 'ice', candidate: event.candidate }));
            }
          };
          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);
          const ws = this.ws;
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
          }
        } else {
          this.enableWSFallback(settle);
        }
      };
      this.ws.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          const list = decodeSnapshot(event.data);
          if (list.length && this.onSnapshot) {
            this.onSnapshot(list);
          }
          return;
        }
        try {
          const message = JSON.parse(event.data as string) as Record<string, unknown>;
          const type = message.type as string | undefined;
          if (type === 'answer') {
            if (this.pc) {
              await this.pc.setRemoteDescription({ type: 'answer', sdp: String(message.sdp ?? '') });
            }
            this.id = typeof message.id === 'string' ? message.id : this.id;
            this.sendNameIfAny();
          } else if (type === 'ice') {
            if (message.candidate && this.pc) {
              await this.pc.addIceCandidate(message.candidate as RTCIceCandidateInit);
            }
          } else if (type === 'welcome') {
            this.id = typeof message.id === 'string' ? message.id : this.id;
            if (message.mode === ConnectionTransport.WebSocket && !this.fallbackWS) {
              this.enableWSFallback();
            }
            this.sendNameIfAny();
          } else if (type === 'fallback' && message.transport === ConnectionTransport.WebSocket) {
            this.enableWSFallback();
          } else if (type === 'chat:regional') {
            this.onChat?.({
              type: 'regional',
              from: Number(message.from ?? 0) >>> 0,
              name: String(message.name ?? ''),
              text: String(message.text ?? ''),
              x: Number(message.x ?? 0),
              y: Number(message.y ?? 0),
            });
          } else if (type === 'chat:private') {
            this.onChat?.({
              type: 'private',
              from: Number(message.from ?? 0) >>> 0,
              name: String(message.name ?? ''),
              text: String(message.text ?? ''),
            });
          } else if (type === 'beam:req') {
            this.onBeamRequest?.({
              from: Number(message.from ?? 0) >>> 0,
              name: String(message.name ?? ''),
              text: String(message.text ?? ''),
            });
          } else if (type === 'beam:resp') {
            this.onBeamResponse?.({
              from: Number(message.from ?? 0) >>> 0,
              name: String(message.name ?? ''),
              accept: Boolean(message.accept),
              scene: Number(message.scene ?? 0) | 0,
              body: Number(message.body ?? 0) >>> 0,
              tileX: Number(message.tileX ?? 0) | 0,
              tileY: Number(message.tileY ?? 0) | 0,
              ship: Number(message.ship ?? 0) >>> 0,
            });
          } else if (type === 'move') {
            this.onRemoteMove?.({
              from: Number(message.from ?? 0) >>> 0,
              x: Number(message.x ?? 0),
              y: Number(message.y ?? 0),
            });
          } else if (type === 'error') {
            const code = typeof message.code === 'string' ? message.code : '';
            if (code === 'registration_required') {
              this.connected = false;
              try {
                this.ws?.close();
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          /* ignore malformed payloads */
        }
      };
      this.ws.onerror = () => settle(false);
      this.ws.onclose = () => {
        this.connected = false;
        settle(false);
      };
    });
  }

  private enableWSFallback(resolve?: (value: boolean) => void): void {
    this.fallbackWS = true;
    this.dc = null;
    this.pc?.close();
    this.pc = null;
    this.connected = true;
    if (resolve) {
      resolve(true);
    }
  }

  private composeUrl(): string {
    if (!this.token) {
      return this.url;
    }
    try {
      const target = new URL(this.url);
      target.searchParams.set('token', this.token);
      return target.toString();
    } catch {
      const separator = this.url.includes('?') ? '&' : '?';
      return `${this.url}${separator}token=${encodeURIComponent(this.token)}`;
    }
  }

  setName(name: string): void {
    this._name = name.slice(0, 24);
    this.sendNameIfAny();
  }

  private sendNameIfAny(): void {
    if (!this._name) {
      return;
    }
    const payload = encodeName(this._name);
    this.sendBinary(payload);
  }

  sendChatPublic(cx: number, cy: number, radius: number, text: string): void {
    this.sendBinary(encodeChatPublic(cx, cy, radius, text));
  }

  sendChatPrivate(targetHash: number, text: string): void {
    this.sendBinary(encodeChatPrivate(targetHash, text));
  }

  sendPosition(x: number, y: number): void {
    const now = performance.now();
    if (now - this.lastPositionSend < 1000 / 10) {
      return;
    }
    this.lastPositionSend = now;
    this.sendBinary(encodeUpdate(x, y));
  }

  sendMoveTarget(x: number, y: number): void {
    this.sendBinary(encodeMove(x, y));
  }

  sendState(scene: number, body: number, tileX: number, tileY: number, ship: number): void {
    const now = performance.now();
    if (now - this.lastStateSend < 1000 / 4) {
      return;
    }
    this.lastStateSend = now;
    this.sendBinary(encodeState(scene, body, tileX, tileY, ship));
  }

  requestBeam(targetHash: number, text = ''): void {
    this.sendBinary(encodeBeamRequest(targetHash >>> 0, text));
  }

  respondBeam(targetHash: number, accept: boolean, scene = 0, body = 0, tileX = 0, tileY = 0, ship = 0): void {
    this.sendBinary(encodeBeamResponse(targetHash >>> 0, accept, scene, body, tileX, tileY, ship));
  }

  private sendBinary(payload: ArrayBuffer): void {
    if (this.fallbackWS) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(payload);
        } catch {
          /* ignore send errors */
        }
      }
      return;
    }
    if (this.dc && this.dc.readyState === 'open') {
      try {
        this.dc.send(payload);
      } catch {
        /* ignore send errors */
      }
    }
  }
}
