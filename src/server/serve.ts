import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { SseBus, type SseClient } from './sse.ts';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export type ServerOptions = Readonly<{
  root: string;
  port?: number;
  host?: string;
  onComment?: (comment: unknown) => Promise<void> | void;
  onAsk?: (ask: { text: string; channel: string; url?: string; viewport?: string; target?: unknown; images?: unknown }) => Promise<void> | void;
  onEvent?: (event: string, data: unknown) => void;
  /** POST /__pi: a change the storybook asks of the Pi session (model, thinking). Returns the new state. */
  onPi?: (change: unknown) => Promise<unknown>;
  /** Extra folders served under a path prefix, such as `/p/` for the built prototypes. */
  mounts?: ReadonlyArray<Readonly<{ prefix: string; dir: string }>>;
  /**
   * Generated responses. A key ending in `/` matches every path under it;
   * any other key matches that path only. Undefined falls through to files.
   */
  routes?: Readonly<Record<string, (url: URL) => Promise<Generated | undefined>>>;
}>;

export type Generated = Readonly<{ type: string; body: string; status?: number }>;

export type RunningServer = Readonly<{
  url: string;
  port: number;
  host: string;
  bus: SseBus;
  close(): Promise<void>;
}>;

export const withinRoot = (root: string, path: string): string | undefined => {
  const resolved = resolve(root, normalize(path).replace(/^\/+/, ''));
  const rooted = resolve(root) + sep;
  if (resolved !== resolve(root) && !resolved.startsWith(rooted)) return undefined;
  return resolved;
};

export const sendFile = async (res: ServerResponse, file: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(file);
    if (stat.isDirectory()) {
      const indexPath = join(file, 'index.html');
      if (await fs.stat(indexPath).then(() => true, () => false)) return sendFile(res, indexPath);
      res.writeHead(404).end('not found');
      return false;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(stat.size),
      // A prototype changes under the reader: never serve a stale copy.
      'cache-control': 'no-store',
    });
    await new Promise<void>((ok, fail) => {
      createReadStream(file).on('error', fail).pipe(res).on('error', fail).on('end', ok);
    });
    return true;
  } catch {
    res.writeHead(404).end('not found');
    return false;
  }
};

/** A message can carry a few images; anything past this is refused, not buffered. */
const MAX_BODY = 40 * 1024 * 1024;

export const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  const received = { size: 0 };
  for await (const chunk of req) {
    received.size += (chunk as Buffer).length;
    if (received.size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

export const serve = async (options: ServerOptions): Promise<RunningServer> => {
  const bus = new SseBus();
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;

  const server = createServer(async (req, res) => {
    if (!req.url) { res.writeHead(400).end('bad request'); return; }
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname === '/__events' && req.method === 'GET') {
      bus.subscribe(req, res, url.searchParams.get('channel') ?? 'default');
      return;
    }
    if (url.pathname === '/__comment' && req.method === 'POST') {
      const body = await readJson(req).catch(() => undefined);
      if (!body) { res.writeHead(400).end('bad json'); return; }
      const channel = (body as { channel?: string } | undefined)?.channel ?? 'default';
      bus.publish(channel, 'comment', body);
      options.onEvent?.('comment', body);
      await options.onComment?.(body);
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/__pi' && req.method === 'POST' && options.onPi) {
      const body = await readJson(req).catch(() => undefined);
      if (!body) { res.writeHead(400).end('bad json'); return; }
      const state = await options.onPi(body).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(state));
      return;
    }
    if (url.pathname === '/__ask' && req.method === 'POST') {
      const body = await readJson(req).catch(() => undefined);
      if (!body) { res.writeHead(400).end('bad json'); return; }
      const text = (body as { text?: string } | undefined)?.text?.trim() ?? '';
      const images = (body as { images?: unknown[] } | undefined)?.images;
      if (!text && !(Array.isArray(images) && images.length)) { res.writeHead(400).end('empty ask'); return; }
      const channel = (body as { channel?: string } | undefined)?.channel ?? 'default';
      // Other pages hear that something was sent, never the images themselves.
      bus.publish(channel, 'ask', { text, images: Array.isArray(images) ? images.length : 0 });
      options.onEvent?.('ask', body);
      await options.onAsk?.(body as { text: string; channel: string; target?: unknown; images?: unknown });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, channel }));
      return;
    }
    if (url.pathname === '/favicon.ico') {
      // Browsers always ask; serve a 1×1 transparent PNG so devtools is quiet.
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) });
      res.end(png);
      return;
    }
    const route = Object.entries(options.routes ?? {}).find(([key]) => key.endsWith('/') ? url.pathname.startsWith(key) : url.pathname === key);
    if (route) {
      const generated = await route[1](url).catch((error: unknown) => ({ type: 'text/plain; charset=utf-8', body: String(error instanceof Error ? error.message : error), status: 500 }));
      if (generated) {
        res.writeHead(generated.status ?? 200, { 'content-type': generated.type, 'cache-control': 'no-store' });
        res.end(generated.body);
        return;
      }
    }
    const mount = options.mounts?.find(candidate => url.pathname.startsWith(candidate.prefix));
    const file = mount
      ? withinRoot(mount.dir, decodeURIComponent(url.pathname.slice(mount.prefix.length)))
      : withinRoot(options.root, decodeURIComponent(url.pathname));
    if (!file) { res.writeHead(403).end('forbidden'); return; }
    await sendFile(res, file);
  });

  await new Promise<void>((ok, fail) => server.once('error', fail).listen(port, host, ok));
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host}:${boundPort}`;

  return {
    url,
    port: boundPort,
    host,
    bus,
    async close() {
      await new Promise<void>(ok => server.close(() => ok()));
    },
  };
};

export type { SseClient };
