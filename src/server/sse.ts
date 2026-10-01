import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Per-connection state for an SSE channel. */
export type SseClient = Readonly<{
  id: string;
  channel: string;
  res: ServerResponse;
}>;

/** The Server-Sent-Events bus. One bus per project, shared across all clients. */
export class SseBus {
  private readonly emitter = new EventEmitter();
  private readonly clients = new Set<SseClient>();

  constructor() {
    this.emitter.setMaxListeners(64);
  }

  publish(channel: string, event: string, data: unknown): void {
    this.emitter.emit(channel, event, data);
  }

  subscribe(req: IncomingMessage, res: ServerResponse, channel: string): SseClient {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const id = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
    const client: SseClient = { id, channel, res };
    this.clients.add(client);
    res.write(`event: hello\ndata: ${JSON.stringify({ id, channel })}\n\n`);
    const listener = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    this.emitter.on(channel, listener);
    req.on('close', () => {
      this.emitter.off(channel, listener);
      this.clients.delete(client);
    });
    return client;
  }

  count(): number {
    return this.clients.size;
  }
}
