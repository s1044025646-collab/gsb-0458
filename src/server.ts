import * as http from 'node:http';
import { ClockError } from './clock.js';
import { ClockStore } from './store.js';

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ClockError('VALIDATION_ERROR', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_ERROR: 400,
  WRONG_SIDE: 400,
  STALE_TIMESTAMP: 400,
  PREVIEW_IN_PAST: 400,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  GAME_OVER: 409,
  VERSION_CONFLICT: 409,
};

export function createServer(store: ClockStore): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'POST' && parts.length === 1 && parts[0] === 'games') {
        const body = await readBody(req);
        const id =
          typeof body.id === 'string' && body.id.length > 0
            ? body.id
            : `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const state = store.create(id, body.initialMs, body.incrementMs);
        send(res, 201, { ok: true, state });
        return;
      }

      if (parts[0] === 'games' && parts.length >= 2) {
        const id = decodeURIComponent(parts[1]);
        const sub = parts[2];

        if (method === 'GET' && !sub) {
          send(res, 200, { ok: true, state: store.get(id) });
          return;
        }
        if (method === 'GET' && sub === 'preview') {
          const atRaw = url.searchParams.get('at');
          const at = atRaw === null ? NaN : Number(atRaw);
          send(res, 200, { ok: true, preview: store.preview(id, at) });
          return;
        }
        if (method === 'GET' && sub === 'events') {
          send(res, 200, { ok: true, events: store.events(id) });
          return;
        }
        if (method === 'GET' && sub === 'replay') {
          send(res, 200, { ok: true, replay: store.exportReplay(id) });
          return;
        }
        if (
          method === 'POST' &&
          (sub === 'start' || sub === 'move' || sub === 'pause' || sub === 'resume')
        ) {
          const body = await readBody(req);
          const result = store.advance(id, sub, body);
          send(res, 200, result);
          return;
        }
      }

      if (method === 'GET' && parts.length === 1 && parts[0] === 'games') {
        send(res, 200, { ok: true, games: store.list() });
        return;
      }

      send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '路由不存在' } });
    } catch (err) {
      if (err instanceof ClockError) {
        send(res, STATUS_BY_CODE[err.code] ?? 400, {
          ok: false,
          error: { code: err.code, message: err.message },
        });
      } else {
        send(res, 500, {
          ok: false,
          error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  });
}

export function startServer(
  port: number,
  dataDir: string,
): Promise<{ port: number; close: () => void }> {
  const store = new ClockStore(dataDir);
  const server = createServer(store);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: actualPort,
        close: () => {
          server.close();
          store.close();
        },
      });
    });
  });
}

if (require.main === module) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.split('=')[1]) : Number(process.env.PORT ?? 0);
  const dataDir = process.env.CLOCK_DATA_DIR ?? 'data';
  startServer(port, dataDir).then(({ port: p }) => {
    console.log(`Fischer 棋钟服务已启动: http://localhost:${p} (数据目录: ${dataDir})`);
  });
}
