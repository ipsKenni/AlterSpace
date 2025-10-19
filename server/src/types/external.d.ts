declare module 'uuid' {
  export function v4(): string;
}

declare module 'wrtc' {
  export class RTCDataChannel {
    readonly label: string;
    readonly readyState: 'open' | 'closing' | 'closed' | 'connecting';
    onmessage: ((event: { data: unknown }) => void) | null;
    send(data: unknown): void;
    close(): void;
  }

  export class RTCPeerConnection {
    constructor(config?: unknown);
    ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null;
    onicecandidate: ((event: { candidate: unknown }) => void) | null;
    createAnswer(): Promise<{ sdp?: string }>;
    setLocalDescription(desc: { type: 'answer'; sdp?: string }): Promise<void>;
    setRemoteDescription(desc: { type: 'offer'; sdp: string }): Promise<void>;
    addIceCandidate(candidate: unknown): Promise<void>;
    close(): void;
    readonly localDescription: { sdp?: string } | null;
  }
}
