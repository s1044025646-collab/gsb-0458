// 纯 node:http 的 JSON API 服务。
import * as http from 'node:http';
import { Store, StoreError } from './store';
import { ClockError } from './clock';

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ClockError('ERR_INVALID_PARAMS', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function errStatus(code: string): number {
  switch (code) {
    case 'ERR_NOT_FOUND': return 404;
    case 'ERR_VERSION_CONFLICT': return 409;
    case 'ERR_GAME_OVER': return 409;
    case 'ERR_TIME_REGRESSION': return 409;
    default: return 400;
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';
      if (method === 'GET' && url.pathname === '/health') {
        send(res, 200, { ok: true });
        return;
      }
      if (method === 'POST' && url.pathname === '/games') {
        const b = (await readBody(req)) as Record<string, unknown>;
        const r = store.createGame(b.initialMs as number, b.incrementMs as number);
        send(res, 201, r);
        return;
      }
      if (method === 'GET' && url.pathname === '/games') {
        send(res, 200, { games: store.listGames() });
        return;
      }
      if (parts[0] === 'games' && parts.length >= 2) {
        const id = parts[1];
        const sub = parts[2];
        if (method === 'GET' && parts.length === 2) { send(res, 200, store.getGame(id)); return; }
        if (method === 'GET' && sub === 'preview') {
          send(res, 200, store.preview(id, Number(url.searchParams.get('at'))));
          return;
        }
        if (method === 'GET' && sub === 'events' && parts.length === 3) {
          send(res, 200, { events: store.listEvents(id) });
          return;
        }
        if (method === 'GET' && sub === 'events' && parts.length === 4) {
          send(res, 200, store.getEventWithBefore(id, Number(parts[3])));
          return;
        }
        if (method === 'GET' && sub === 'export') { send(res, 200, store.exportReplay(id)); return; }
        if (method === 'POST' && ['start', 'move', 'pause', 'resume'].includes(sub ?? '')) {
          const b = (await readBody(req)) as Record<string, unknown>;
          const ver = b.expectedVersion as number;
          const rid = b.requestId as string;
          const at = b.at as number;
          let r;
          if (sub === 'start') r = store.start(id, b.side as never, at, ver, rid);
          else if (sub === 'move') r = store.move(id, b.side as never, at, ver, rid);
          else if (sub === 'pause') r = store.pause(id, at, ver, rid);
          else r = store.resume(id, at, ver, rid);
          send(res, 200, r);
          return;
        }
      }
      send(res, 404, { error: { code: 'ERR_NOT_FOUND', message: '路由不存在' } });
    } catch (e) {
      if (e instanceof ClockError || e instanceof StoreError) {
        send(res, errStatus(e.code), { error: { code: e.code, message: e.message } });
        return;
      }
      send(res, 500, { error: { code: 'ERR_INTERNAL', message: String(e) } });
    }
  });
}

export function startServer(store: Store, port: number): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(store);
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : port });
    });
  });
}
