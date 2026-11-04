import { BridgeError } from '../core/config.js';

export class SSEDecoder {
  private buffer = '';
  private data: string[] = [];
  private event = '';
  private decoder = new TextDecoder();
  constructor(private receive: (event: { event: string; data: string }) => void) {}
  push(chunk: Uint8Array) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let boundary: number;
    while ((boundary = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, boundary).replace(/\r$/, ''); this.buffer = this.buffer.slice(boundary + 1);
      if (!line) { if (this.data.length) this.receive({ event: this.event, data: this.data.join('\n') }); this.data = []; this.event = ''; }
      else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('event:')) this.event = line.slice(6).trim();
      if (this.data.reduce((n, s) => n + s.length, 0) > 2097152) throw new BridgeError(502, 'upstream_event_too_large', 'Upstream stream event exceeds the size limit.');
    }
    if (this.buffer.length > 2097152) throw new BridgeError(502, 'upstream_event_too_large', 'Upstream stream event exceeds the size limit.');
  }
  finish() { this.push(new TextEncoder().encode('\n\n')); }
}
export const sse = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
