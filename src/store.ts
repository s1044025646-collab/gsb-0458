// SQLite 持久化：余额/起点/版本原子保存，事件追加，请求 ID 幂等。
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ClockState, ClockError, AppliedEvent, Side,
  createState, applyStart, applyMove, applyPause, applyResume, preview, PreviewResult,
} from './clock';

export class StoreError extends Error {
  constructor(public code: 'ERR_NOT_FOUND' | 'ERR_VERSION_CONFLICT' | 'ERR_INVALID_PARAMS', message: string) {
    super(message);
  }
}

export interface GameRow extends ClockState {
  id: string;
  version: number;
  seq: number; // 已提交事件序号（含 create）
}

export interface EventRow {
  seq: number;
  type: string;
  at: number;
  side: Side | null;
  detail: Record<string, unknown>;
  stateAfter: GameRow;
  requestId: string | null;
}

export interface CommandResult {
  game: GameRow;
  event: EventRow;
  replayed: boolean; // true 表示相同 requestId 的重复请求，返回原结果
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        game_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        at INTEGER NOT NULL,
        side TEXT,
        detail TEXT NOT NULL,
        state_after TEXT NOT NULL,
        request_id TEXT,
        PRIMARY KEY (game_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_request
        ON events(game_id, request_id) WHERE request_id IS NOT NULL;
    `);
  }

  close(): void { this.db.close(); }

  private rowToGame(id: string, version: number, seq: number, stateJson: string): GameRow {
    return { id, version, seq, ...(JSON.parse(stateJson) as ClockState) };
  }

  getGame(id: string): GameRow {
    const row = this.db.prepare('SELECT version, seq, state FROM games WHERE id = ?').get(id) as
      | { version: number; seq: number; state: string } | undefined;
    if (!row) throw new StoreError('ERR_NOT_FOUND', `棋钟 ${id} 不存在`);
    return this.rowToGame(id, row.version, row.seq, row.state);
  }

  listGames(): GameRow[] {
    const rows = this.db.prepare('SELECT id, version, seq, state FROM games ORDER BY rowid').all() as
      Array<{ id: string; version: number; seq: number; state: string }>;
    return rows.map((r) => this.rowToGame(r.id, r.version, r.seq, r.state));
  }

  createGame(initialMs: number, incrementMs: number): CommandResult {
    const state = createState(initialMs, incrementMs);
    const id = `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const ev: AppliedEvent = { type: 'create', at: 0, side: null, detail: { initialMs, incrementMs } };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO games(id, version, seq, state) VALUES (?, 0, 0, ?)')
        .run(id, JSON.stringify(state));
      this.insertEvent(id, 0, ev, this.rowToGame(id, 0, 0, JSON.stringify(state)), null);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    const game = this.getGame(id);
    return { game, event: this.getEvent(id, 0), replayed: false };
  }

  private insertEvent(gameId: string, seq: number, ev: AppliedEvent, stateAfter: GameRow, requestId: string | null): void {
    this.db.prepare(
      'INSERT INTO events(game_id, seq, type, at, side, detail, state_after, request_id) VALUES (?,?,?,?,?,?,?,?)'
    ).run(gameId, seq, ev.type, ev.at, ev.side, JSON.stringify(ev.detail), JSON.stringify(stateAfter), requestId);
  }

  // 所有推进命令的统一入口：事务内校验版本、应用事件、持久化；幂等重放。
  private advance(
    id: string,
    expectedVersion: number,
    requestId: string,
    apply: (s: ClockState) => AppliedEvent,
  ): CommandResult {
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128)
      throw new StoreError('ERR_INVALID_PARAMS', 'requestId 必须是 1-128 字符的字符串');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
      throw new StoreError('ERR_INVALID_PARAMS', 'expectedVersion 必须是非负安全整数');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 幂等：相同 requestId 直接返回原结果
      const dup = this.db.prepare('SELECT seq FROM events WHERE game_id = ? AND request_id = ?').get(id, requestId) as
        | { seq: number } | undefined;
      if (dup) {
        const game = this.getGame(id);
        const event = this.getEvent(id, dup.seq);
        this.db.exec('COMMIT');
        return { game, event, replayed: true };
      }

      const game = this.getGame(id);
      if (expectedVersion !== game.version)
        throw new StoreError('ERR_VERSION_CONFLICT',
          `期望版本 ${expectedVersion} 与当前版本 ${game.version} 不一致`);

      const state: ClockState = {
        initialMs: game.initialMs, incrementMs: game.incrementMs,
        whiteMs: game.whiteMs, blackMs: game.blackMs,
        turn: game.turn, status: game.status, lastTs: game.lastTs,
        flagSide: game.flagSide, flagTs: game.flagTs,
      };
      const ev = apply(state); // 领域错误（ClockError）向外抛，整体回滚
      const newVersion = game.version + 1;
      const newSeq = game.seq + 1;
      const after = this.rowToGame(id, newVersion, newSeq, JSON.stringify(state));
      this.db.prepare('UPDATE games SET version = ?, seq = ?, state = ? WHERE id = ? AND version = ?')
        .run(newVersion, newSeq, JSON.stringify(state), id, game.version);
      this.insertEvent(id, newSeq, ev, after, requestId);
      this.db.exec('COMMIT');
      return { game: after, event: this.getEvent(id, newSeq), replayed: false };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  start(id: string, side: Side, at: number, expectedVersion: number, requestId: string): CommandResult {
    return this.advance(id, expectedVersion, requestId, (s) => applyStart(s, side, at));
  }

  move(id: string, side: Side, at: number, expectedVersion: number, requestId: string): CommandResult {
    return this.advance(id, expectedVersion, requestId, (s) => applyMove(s, side, at));
  }

  pause(id: string, at: number, expectedVersion: number, requestId: string): CommandResult {
    return this.advance(id, expectedVersion, requestId, (s) => applyPause(s, at));
  }

  resume(id: string, at: number, expectedVersion: number, requestId: string): CommandResult {
    return this.advance(id, expectedVersion, requestId, (s) => applyResume(s, at));
  }

  preview(id: string, at: number): PreviewResult {
    return preview(this.getGame(id), at);
  }

  getEvent(id: string, seq: number): EventRow {
    const row = this.db.prepare(
      'SELECT seq, type, at, side, detail, state_after, request_id FROM events WHERE game_id = ? AND seq = ?'
    ).get(id, seq) as
      | { seq: number; type: string; at: number; side: Side | null; detail: string; state_after: string; request_id: string | null }
      | undefined;
    if (!row) throw new StoreError('ERR_NOT_FOUND', `棋钟 ${id} 不存在事件序号 ${seq}`);
    return {
      seq: row.seq, type: row.type, at: row.at, side: row.side,
      detail: JSON.parse(row.detail), stateAfter: JSON.parse(row.state_after), requestId: row.request_id,
    };
  }

  // 按事件查看前后状态：stateBefore 来自上一序号事件的 stateAfter
  getEventWithBefore(id: string, seq: number): { event: EventRow; stateBefore: GameRow | null } {
    const event = this.getEvent(id, seq);
    const stateBefore = seq > 0 ? this.getEvent(id, seq - 1).stateAfter : null;
    return { event, stateBefore };
  }

  listEvents(id: string): EventRow[] {
    this.getGame(id); // 确认存在
    const rows = this.db.prepare(
      'SELECT seq FROM events WHERE game_id = ? ORDER BY seq'
    ).all(id) as Array<{ seq: number }>;
    return rows.map((r) => this.getEvent(id, r.seq));
  }

  // 导出回放：完整事件流 + 逐事件前后状态，可离线重放核对
  exportReplay(id: string): Record<string, unknown> {
    const game = this.getGame(id);
    const events = this.listEvents(id);
    return {
      gameId: id,
      exportedAt: new Date().toISOString(),
      initialMs: game.initialMs,
      incrementMs: game.incrementMs,
      final: game,
      events: events.map((e) => ({
        seq: e.seq, type: e.type, at: e.at, side: e.side, detail: e.detail,
        stateBefore: e.seq > 0 ? this.getEvent(id, e.seq - 1).stateAfter : null,
        stateAfter: e.stateAfter,
      })),
    };
  }
}
