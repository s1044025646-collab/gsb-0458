import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClockStore } from '../src/store.js';
import { ClockError } from '../src/clock.js';

let dirCounter = 0;
function freshStore(): { store: ClockStore; dir: string } {
  const dir = path.join('data', 'test', `t-${process.pid}-${dirCounter++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return { store: new ClockStore(dir), dir };
}

function adv(
  store: ClockStore,
  id: string,
  action: 'start' | 'move' | 'pause' | 'resume',
  body: Record<string, unknown>,
) {
  const version = store.get(id).version;
  return store.advance(id, action, {
    requestId: `r-${Math.random().toString(36).slice(2)}`,
    expectedVersion: version,
    ...body,
  });
}

test('demo scenario: 60000/2000 full flow matches hand computation', () => {
  const { store } = freshStore();
  store.create('g', 60000, 2000);
  adv(store, 'g', 'start', { side: 'white', at: 0 });

  let r = adv(store, 'g', 'move', { side: 'white', at: 10000 });
  assert.equal(r.state!.whiteMs, 52000);
  assert.equal(r.state!.blackMs, 60000);
  assert.equal(r.state!.sideToMove, 'black');

  r = adv(store, 'g', 'pause', { at: 25000 });
  assert.equal(r.state!.blackMs, 45000);
  assert.equal(r.state!.status, 'paused');

  const p = store.preview('g', 90000);
  assert.equal(p.blackMs, 45000);
  assert.equal(p.status, 'paused');
  assert.equal(store.get('g').anchorAt, 25000);

  r = adv(store, 'g', 'resume', { at: 100000 });
  assert.equal(r.state!.blackMs, 45000);

  r = adv(store, 'g', 'move', { side: 'black', at: 110000 });
  assert.equal(r.state!.blackMs, 37000);
  assert.equal(r.state!.whiteMs, 52000);
  assert.equal(r.state!.sideToMove, 'white');
  store.close();
});

test('move exactly at exhaustion still flags, flagAt is real exhaustion time', () => {
  const { store } = freshStore();
  store.create('g', 1000, 100);
  adv(store, 'g', 'start', { side: 'white', at: 0 });
  const r = adv(store, 'g', 'move', { side: 'white', at: 1000 });
  assert.equal(r.state!.status, 'flagged');
  assert.equal(r.state!.flagSide, 'white');
  assert.equal(r.state!.flagAt, 1000);
  assert.equal(r.state!.whiteMs, 0);
  assert.equal(r.events![0].type, 'flag');
  store.close();
});

test('late request reports real flag time, not submission time', () => {
  const { store } = freshStore();
  store.create('g', 1000, 100);
  adv(store, 'g', 'start', { side: 'white', at: 0 });
  const r = adv(store, 'g', 'move', { side: 'white', at: 5000 });
  assert.equal(r.state!.flagAt, 1000);
  assert.throws(
    () => adv(store, 'g', 'move', { side: 'black', at: 6000 }),
    (e: ClockError) => e.code === 'GAME_OVER',
  );
  store.close();
});

test('pause arriving after flag records flag instead of pausing', () => {
  const { store } = freshStore();
  store.create('g', 1000, 0);
  adv(store, 'g', 'start', { side: 'white', at: 0 });
  const r = adv(store, 'g', 'pause', { at: 2000 });
  assert.equal(r.state!.status, 'flagged');
  assert.equal(r.state!.flagAt, 1000);
  assert.equal(r.events![0].type, 'flag');
  store.close();
});

test('zero-elapsed consecutive moves at same timestamp', () => {
  const { store } = freshStore();
  store.create('g', 10000, 500);
  adv(store, 'g', 'start', { side: 'white', at: 100 });
  let r = adv(store, 'g', 'move', { side: 'white', at: 100 });
  assert.equal(r.state!.whiteMs, 10500);
  r = adv(store, 'g', 'move', { side: 'black', at: 100 });
  assert.equal(r.state!.blackMs, 10500);
  assert.equal(r.state!.sideToMove, 'white');
  store.close();
});

test('wrong side move changes nothing', () => {
  const { store } = freshStore();
  store.create('g', 10000, 500);
  adv(store, 'g', 'start', { side: 'white', at: 0 });
  assert.throws(
    () => adv(store, 'g', 'move', { side: 'black', at: 5000 }),
    (e: ClockError) => e.code === 'WRONG_SIDE',
  );
  const s = store.get('g');
  assert.equal(s.whiteMs, 10000);
  assert.equal(s.anchorAt, 0);
  assert.equal(s.version, 1);
  assert.equal(store.events('g').length, 1);
  store.close();
});

test('reversed timestamp rejected', () => {
  const { store } = freshStore();
  store.create('g', 10000, 0);
  adv(store, 'g', 'start', { side: 'white', at: 5000 });
  assert.throws(
    () => adv(store, 'g', 'move', { side: 'white', at: 4999 }),
    (e: ClockError) => e.code === 'STALE_TIMESTAMP',
  );
  store.close();
});

test('invalid state transitions rejected', () => {
  const { store } = freshStore();
  store.create('g', 10000, 0);
  assert.throws(
    () => adv(store, 'g', 'move', { side: 'white', at: 0 }),
    (e: ClockError) => e.code === 'INVALID_STATE',
  );
  adv(store, 'g', 'start', { side: 'white', at: 0 });
  assert.throws(
    () => adv(store, 'g', 'start', { side: 'black', at: 1 }),
    (e: ClockError) => e.code === 'INVALID_STATE',
  );
  assert.throws(
    () => adv(store, 'g', 'resume', { at: 1 }),
    (e: ClockError) => e.code === 'INVALID_STATE',
  );
  adv(store, 'g', 'pause', { at: 100 });
  assert.throws(
    () => adv(store, 'g', 'move', { side: 'white', at: 200 }),
    (e: ClockError) => e.code === 'INVALID_STATE',
  );
  store.close();
});

test('duplicate requestId returns original result, stale version rejected', () => {
  const { store } = freshStore();
  store.create('g', 10000, 0);
  const body = { side: 'white', at: 0, requestId: 'same-rid', expectedVersion: 0 };
  const r1 = store.advance('g', 'start', body);
  const r2 = store.advance('g', 'start', body);
  assert.equal(r2.replayed, true);
  assert.deepEqual(r2.state, r1.state);
  assert.equal(store.get('g').version, 1);
  assert.equal(store.events('g').length, 1);

  assert.throws(
    () => store.advance('g', 'move', { side: 'white', at: 100, requestId: 'x', expectedVersion: 0 }),
    (e: ClockError) => e.code === 'VERSION_CONFLICT',
  );
  store.close();
});

test('preview is read-only, projects flag, cannot go to the past', () => {
  const { store } = freshStore();
  store.create('g', 1000, 0);
  adv(store, 'g', 'start', { side: 'white', at: 0 });
  const p = store.preview('g', 5000);
  assert.equal(p.status, 'would-flag');
  assert.equal(p.whiteMs, 0);
  assert.equal(p.projectedFlagAt, 1000);
  assert.equal(store.get('g').status, 'running');
  assert.throws(
    () => store.preview('g', -1),
    (e: ClockError) => e.code === 'PREVIEW_IN_PAST' || e.code === 'VALIDATION_ERROR',
  );
  const r = adv(store, 'g', 'move', { side: 'white', at: 5000 });
  assert.equal(r.state!.status, 'flagged');
  assert.equal(r.state!.flagAt, 1000);
  store.close();
});

test('replay event chain matches persisted final state', () => {
  const { store } = freshStore();
  store.create('g', 60000, 2000);
  adv(store, 'g', 'start', { side: 'white', at: 0 });
  adv(store, 'g', 'move', { side: 'white', at: 10000 });
  adv(store, 'g', 'pause', { at: 25000 });
  adv(store, 'g', 'resume', { at: 100000 });
  adv(store, 'g', 'move', { side: 'black', at: 110000 });

  const replay = store.exportReplay('g');
  let prev = replay.events[0].before;
  for (const ev of replay.events) {
    assert.deepEqual(ev.before, prev);
    prev = ev.after;
  }
  const final = replay.final;
  assert.equal(final.whiteMs, 52000);
  assert.equal(final.blackMs, 37000);
  assert.deepEqual(replay.events[replay.events.length - 1].after, {
    status: final.status,
    sideToMove: final.sideToMove,
    whiteMs: final.whiteMs,
    blackMs: final.blackMs,
    anchorAt: final.anchorAt,
    flagSide: final.flagSide,
    flagAt: final.flagAt,
  });
  store.close();
});

test('restart continues from persisted data with new logical time', () => {
  const { store, dir } = freshStore();
  store.create('g', 10000, 100);
  adv(store, 'g', 'start', { side: 'white', at: 0 });
  adv(store, 'g', 'move', { side: 'white', at: 3000 });
  store.close();

  const reopened = new ClockStore(dir);
  const s = reopened.get('g');
  assert.equal(s.whiteMs, 7100);
  assert.equal(s.sideToMove, 'black');
  const r = adv(reopened, 'g', 'move', { side: 'black', at: 5000 });
  assert.equal(r.state!.blackMs, 8100);
  reopened.close();
});

test('validation: illegal initial time and timestamps', () => {
  const { store } = freshStore();
  assert.throws(() => store.create('a', 0, 0), (e: ClockError) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => store.create('b', 1000, -1), (e: ClockError) => e.code === 'VALIDATION_ERROR');
  store.create('g', 1000, 0);
  assert.throws(
    () => adv(store, 'g', 'start', { side: 'white', at: 1.5 }),
    (e: ClockError) => e.code === 'VALIDATION_ERROR',
  );
  store.close();
});
