import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startServer } from '../src/server.js';

let base = '';
let closeServer: () => void = () => {};

before(async () => {
  const dir = path.join('data', 'test', `api-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const { port, close } = await startServer(0, dir);
  base = `http://localhost:${port}`;
  closeServer = close;
});

after(() => closeServer());

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('API full flow with version and request id', async () => {
  let r = await call('POST', '/games', { id: 'api-1', initialMs: 60000, incrementMs: 2000 });
  assert.equal(r.status, 201);

  r = await call('POST', '/games/api-1/start', { side: 'white', at: 0, requestId: 'a1', expectedVersion: 0 });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.version, 1);

  r = await call('POST', '/games/api-1/move', { side: 'white', at: 10000, requestId: 'a2', expectedVersion: 1 });
  assert.equal(r.json.state.whiteMs, 52000);

  r = await call('POST', '/games/api-1/pause', { at: 25000, requestId: 'a3', expectedVersion: 2 });
  assert.equal(r.json.state.blackMs, 45000);

  r = await call('GET', '/games/api-1/preview?at=90000');
  assert.equal(r.json.preview.status, 'paused');
  assert.equal(r.json.preview.blackMs, 45000);

  r = await call('POST', '/games/api-1/resume', { at: 100000, requestId: 'a4', expectedVersion: 3 });
  r = await call('POST', '/games/api-1/move', { side: 'black', at: 110000, requestId: 'a5', expectedVersion: 4 });
  assert.equal(r.json.state.blackMs, 37000);

  r = await call('GET', '/games/api-1/events');
  assert.equal(r.json.events.length, 5);

  r = await call('GET', '/games/api-1/replay');
  assert.equal(r.json.replay.final.blackMs, 37000);
});

test('API duplicate request id is idempotent', async () => {
  await call('POST', '/games', { id: 'api-2', initialMs: 1000, incrementMs: 100 });
  const body = { side: 'white', at: 0, requestId: 'dup', expectedVersion: 0 };
  const r1 = await call('POST', '/games/api-2/start', body);
  const r2 = await call('POST', '/games/api-2/start', body);
  assert.equal(r2.json.replayed, true);
  assert.deepEqual(r2.json.state, r1.json.state);
});

test('API error codes and HTTP statuses', async () => {
  await call('POST', '/games', { id: 'api-3', initialMs: 1000, incrementMs: 0 });
  let r = await call('POST', '/games/api-3/move', { side: 'white', at: 0, requestId: 'e1', expectedVersion: 0 });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'INVALID_STATE');

  await call('POST', '/games/api-3/start', { side: 'white', at: 0, requestId: 'e2', expectedVersion: 0 });
  r = await call('POST', '/games/api-3/move', { side: 'black', at: 10, requestId: 'e3', expectedVersion: 1 });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'WRONG_SIDE');

  r = await call('POST', '/games/api-3/move', { side: 'white', at: 10, requestId: 'e4', expectedVersion: 0 });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'VERSION_CONFLICT');

  r = await call('POST', '/games/api-3/move', { side: 'white', at: 1000, requestId: 'e5', expectedVersion: 1 });
  assert.equal(r.json.state.status, 'flagged');
  assert.equal(r.json.state.flagAt, 1000);

  r = await call('POST', '/games/api-3/move', { side: 'black', at: 2000, requestId: 'e6', expectedVersion: 2 });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'GAME_OVER');

  r = await call('GET', '/games/nope');
  assert.equal(r.status, 404);

  r = await call('POST', '/games', { id: 'bad', initialMs: -5, incrementMs: 0 });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'VALIDATION_ERROR');
});
