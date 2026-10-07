import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Store } from '../store';
import { ClockError } from '../clock';

function tmpStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-test-'));
  return new Store(path.join(dir, 'test.db'));
}

test('演示场景：60000/2000 全流程余额', () => {
  const s = tmpStore();
  const g = s.createGame(60000, 2000).game;
  let r = s.start(g.id, 'white', 0, 0, 'r1');
  assert.equal(r.game.turn, 'white');
  r = s.move(g.id, 'white', 10000, 1, 'r2');
  assert.equal(r.game.whiteMs, 52000);
  assert.equal(r.game.blackMs, 60000);
  assert.equal(r.game.turn, 'black');
  r = s.pause(g.id, 25000, 2, 'r3');
  assert.equal(r.game.blackMs, 45000);
  assert.equal(r.game.status, 'paused');
  r = s.resume(g.id, 100000, 3, 'r4');
  assert.equal(r.game.blackMs, 45000); // 暂停期间不扣时
  r = s.move(g.id, 'black', 110000, 4, 'r5');
  assert.equal(r.game.blackMs, 37000);
  assert.equal(r.game.whiteMs, 52000);
  assert.equal(r.game.turn, 'white');
  s.close();
});

test('恰在剩余时间走棋仍落旗，增益不救回，落旗时刻精确', () => {
  const s = tmpStore();
  const g = s.createGame(1000, 100).game;
  s.start(g.id, 'white', 0, 0, 'a');
  const r = s.move(g.id, 'white', 1000, 1, 'b');
  assert.equal(r.game.status, 'flagged');
  assert.equal(r.game.flagSide, 'white');
  assert.equal(r.game.flagTs, 1000); // 段起点0 + 原剩余1000
  assert.equal(r.game.whiteMs, 0);
  assert.equal(r.event.type, 'flag');
  s.close();
});

test('晚到请求报告实际落旗时刻而非提交时刻', () => {
  const s = tmpStore();
  const g = s.createGame(1000, 100).game;
  s.start(g.id, 'white', 500, 0, 'a');
  const r = s.move(g.id, 'white', 9000, 1, 'b'); // 剩余1000，500+1000=1500 落旗
  assert.equal(r.game.flagTs, 1500);
  s.close();
});

test('零耗时连续换手', () => {
  const s = tmpStore();
  const g = s.createGame(60000, 2000).game;
  s.start(g.id, 'white', 100, 0, 'a');
  let r = s.move(g.id, 'white', 100, 1, 'b');
  assert.equal(r.game.whiteMs, 62000);
  r = s.move(g.id, 'black', 100, 2, 'c');
  assert.equal(r.game.blackMs, 62000);
  assert.equal(r.game.lastTs, 100);
  s.close();
});

test('错方落子不改变余额、序号、起点', () => {
  const s = tmpStore();
  const g = s.createGame(60000, 2000).game;
  s.start(g.id, 'white', 0, 0, 'a');
  assert.throws(() => s.move(g.id, 'black', 5000, 1, 'b'), (e: ClockError) => e.code === 'ERR_WRONG_SIDE');
  const after = s.getGame(g.id);
  assert.equal(after.whiteMs, 60000);
  assert.equal(after.version, 1);
  assert.equal(after.seq, 1);
  assert.equal(after.lastTs, 0);
  s.close();
});

test('倒序时间戳明确拒绝', () => {
  const s = tmpStore();
  const g = s.createGame(60000, 2000).game;
  s.start(g.id, 'white', 1000, 0, 'a');
  assert.throws(() => s.move(g.id, 'white', 500, 1, 'b'), (e: ClockError) => e.code === 'ERR_TIME_REGRESSION');
  s.close();
});

test('暂停中拒绝 move 且不发放增益；未暂停 resume 报错；重复 start 报错；未启动 move 报错', () => {
  const s = tmpStore();
  const g = s.createGame(60000, 2000).game;
  assert.throws(() => s.move(g.id, 'white', 0, 0, 'x'), (e: ClockError) => e.code === 'ERR_NOT_STARTED');
  s.start(g.id, 'white', 0, 0, 'a');
  assert.throws(() => s.start(g.id, 'white', 0, 1, 'y'), (e: ClockError) => e.code === 'ERR_ALREADY_STARTED');
  assert.throws(() => s.resume(g.id, 10, 1, 'z'), (e: ClockError) => e.code === 'ERR_NOT_PAUSED');
  s.pause(g.id, 5000, 1, 'p');
  assert.throws(() => s.move(g.id, 'white', 6000, 2, 'm'), (e: ClockError) => e.code === 'ERR_PAUSED');
  const after = s.getGame(g.id);
  assert.equal(after.whiteMs, 55000); // 未获得增益
  s.close();
});

test('暂停请求晚于落旗：记录落旗而非成功暂停', () => {
  const s = tmpStore();
  const g = s.createGame(1000, 0).game;
  s.start(g.id, 'white', 0, 0, 'a');
  const r = s.pause(g.id, 5000, 1, 'p');
  assert.equal(r.game.status, 'flagged');
  assert.equal(r.game.flagTs, 1000);
  assert.equal(r.event.type, 'flag');
  s.close();
});

test('终局后不再接受推进', () => {
  const s = tmpStore();
  const g = s.createGame(1000, 0).game;
  s.start(g.id, 'white', 0, 0, 'a');
  s.move(g.id, 'white', 2000, 1, 'b');
  assert.throws(() => s.move(g.id, 'black', 3000, 2, 'c'), (e: ClockError) => e.code === 'ERR_GAME_OVER');
  assert.throws(() => s.pause(g.id, 3000, 2, 'd'), (e: ClockError) => e.code === 'ERR_GAME_OVER');
  s.close();
});

test('preview 不写状态、不消耗增益、不改变可提交边界；暂停中预览冻结', () => {
  const s = tmpStore();
  const g = s.createGame(10000, 500).game;
  s.start(g.id, 'white', 0, 0, 'a');
  const p1 = s.preview(g.id, 3000);
  assert.equal(p1.whiteMs, 7000);
  assert.equal(p1.projectedFlag, null);
  const p2 = s.preview(g.id, 99999);
  assert.equal(p2.whiteMs, 0);
  assert.deepEqual(p2.projectedFlag, { side: 'white', flagTs: 10000 });
  // 预览后持久化状态不变
  const after = s.getGame(g.id);
  assert.equal(after.whiteMs, 10000);
  assert.equal(after.version, 1);
  // 预览不提交落旗：实际 move 才提交
  const r = s.move(g.id, 'white', 12000, 1, 'b');
  assert.equal(r.game.status, 'flagged');
  assert.equal(r.game.flagTs, 10000);
  // 暂停中预览
  const g2 = s.createGame(10000, 500).game;
  s.start(g2.id, 'white', 0, 0, 'a2');
  s.pause(g2.id, 4000, 1, 'p2');
  const p3 = s.preview(g2.id, 9000);
  assert.equal(p3.whiteMs, 6000);
  assert.equal(p3.status, 'paused');
  assert.equal(p3.projectedFlag, null);
  // 预览不能回溯
  assert.throws(() => s.preview(g2.id, 100), (e: ClockError) => e.code === 'ERR_TIME_REGRESSION');
  s.close();
});

test('重复 requestId 返回原结果，不重复记账', () => {
  const s = tmpStore();
  const g = s.createGame(60000, 2000).game;
  s.start(g.id, 'white', 0, 0, 'a');
  const r1 = s.move(g.id, 'white', 10000, 1, 'dup');
  const r2 = s.move(g.id, 'white', 10000, 1, 'dup');
  assert.equal(r2.replayed, true);
  assert.equal(r2.event.seq, r1.event.seq);
  const after = s.getGame(g.id);
  assert.equal(after.whiteMs, 52000);
  assert.equal(after.version, 2);
  s.close();
});

test('过期版本被拒绝', () => {
  const s = tmpStore();
  const g = s.createGame(60000, 2000).game;
  s.start(g.id, 'white', 0, 0, 'a');
  assert.throws(
    () => s.move(g.id, 'white', 1000, 0, 'stale'),
    (e: { code: string }) => e.code === 'ERR_VERSION_CONFLICT',
  );
  s.close();
});

test('回放与逐次执行一致：事件流重放等于存储状态', () => {
  const s = tmpStore();
  const g = s.createGame(60000, 2000).game;
  s.start(g.id, 'white', 0, 0, 'a');
  s.move(g.id, 'white', 10000, 1, 'b');
  s.pause(g.id, 25000, 2, 'c');
  s.resume(g.id, 100000, 3, 'd');
  s.move(g.id, 'black', 110000, 4, 'e');
  const replay = s.exportReplay(g.id) as { events: Array<{ stateAfter: { whiteMs: number } }>; final: { whiteMs: number } };
  const events = s.listEvents(g.id);
  assert.equal(events.length, 6); // create + 5
  // 手算事件表核对
  const balances = events.map((e) => [e.stateAfter.whiteMs, e.stateAfter.blackMs]);
  assert.deepEqual(balances, [
    [60000, 60000], // create
    [60000, 60000], // start@0
    [52000, 60000], // move white@10000
    [52000, 45000], // pause@25000
    [52000, 45000], // resume@100000
    [52000, 37000], // move black@110000
  ]);
  // 导出回放的末事件状态 == 最终状态
  const last = replay.events[replay.events.length - 1];
  assert.equal(last.stateAfter.whiteMs, replay.final.whiteMs);
  // 事件前后状态查询
  const { event, stateBefore } = s.getEventWithBefore(g.id, 2);
  assert.equal(event.type, 'move');
  assert.equal(stateBefore!.whiteMs, 60000);
  assert.equal(event.stateAfter.whiteMs, 52000);
  s.close();
});

test('参数校验：非法初始时间/增益/时间戳', () => {
  const s = tmpStore();
  assert.throws(() => s.createGame(0, 100), (e: ClockError) => e.code === 'ERR_INVALID_PARAMS');
  assert.throws(() => s.createGame(-5, 100), (e: ClockError) => e.code === 'ERR_INVALID_PARAMS');
  assert.throws(() => s.createGame(1000, -1), (e: ClockError) => e.code === 'ERR_INVALID_PARAMS');
  assert.throws(() => s.createGame(1.5, 100), (e: ClockError) => e.code === 'ERR_INVALID_PARAMS');
  const g = s.createGame(1000, 0).game;
  assert.throws(() => s.start(g.id, 'white', -1, 0, 'a'), (e: ClockError) => e.code === 'ERR_INVALID_PARAMS');
  s.close();
});

test('重启后凭持久化数据继续（重新打开同一 DB）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-test-'));
  const db = path.join(dir, 'test.db');
  const s1 = new Store(db);
  const g = s1.createGame(60000, 2000).game;
  s1.start(g.id, 'white', 0, 0, 'a');
  s1.move(g.id, 'white', 10000, 1, 'b');
  s1.close();
  const s2 = new Store(db);
  const loaded = s2.getGame(g.id);
  assert.equal(loaded.whiteMs, 52000);
  assert.equal(loaded.version, 2);
  const r = s2.move(g.id, 'black', 20000, 2, 'c');
  assert.equal(r.game.blackMs, 52000);
  s2.close();
});
