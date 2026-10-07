import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ClockError,
  ClockEvent,
  GameState,
  Side,
  applyMove,
  applyPause,
  applyResume,
  createGame,
  preview,
  requireSide,
  requireTimestamp,
  snapshotOf,
  startGame,
  PreviewResult,
} from './clock.js';

export interface CommandResult {
  ok: boolean;
  replayed?: boolean;
  gameId?: string;
  version?: number;
  state?: GameState;
  events?: Array<{ type: string; at: number; side: Side | null; note: string }>;
  error?: { code: string; message: string };
}

export class ClockStore {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'clocks.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        game_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        at INTEGER NOT NULL,
        side TEXT,
        note TEXT NOT NULL,
        before TEXT NOT NULL,
        after TEXT NOT NULL,
        request_id TEXT NOT NULL,
        PRIMARY KEY (game_id, seq)
      );
      CREATE TABLE IF NOT EXISTS requests (
        game_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        response TEXT NOT NULL,
        PRIMARY KEY (game_id, request_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private loadState(id: string): GameState {
    const row = this.db.prepare('SELECT state FROM games WHERE id = ?').get(id) as
      | { state: string }
      | undefined;
    if (!row) throw new ClockError('NOT_FOUND', `棋钟 ${id} 不存在`);
    return JSON.parse(row.state) as GameState;
  }

  create(id: string, initialMs: unknown, incrementMs: unknown): GameState {
    const state = createGame(id, initialMs as number, incrementMs as number);
    const existing = this.db.prepare('SELECT id FROM games WHERE id = ?').get(id);
    if (existing) throw new ClockError('VALIDATION_ERROR', `棋钟 ${id} 已存在`);
    this.db
      .prepare('INSERT INTO games (id, version, state) VALUES (?, ?, ?)')
      .run(id, 0, JSON.stringify(state));
    return state;
  }

  get(id: string): GameState {
    return this.loadState(id);
  }

  list(): GameState[] {
    const rows = this.db.prepare('SELECT state FROM games ORDER BY rowid').all() as Array<{
      state: string;
    }>;
    return rows.map((r) => JSON.parse(r.state) as GameState);
  }

  events(id: string): ClockEvent[] {
    this.loadState(id);
    const rows = this.db
      .prepare('SELECT seq, type, at, side, note, before, after FROM events WHERE game_id = ? ORDER BY seq')
      .all(id) as Array<{
      seq: number;
      type: string;
      at: number;
      side: string | null;
      note: string;
      before: string;
      after: string;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      type: r.type as ClockEvent['type'],
      at: r.at,
      side: r.side as Side | null,
      note: r.note,
      before: JSON.parse(r.before),
      after: JSON.parse(r.after),
    }));
  }

  preview(id: string, at: unknown): PreviewResult {
    return preview(this.loadState(id), requireTimestamp(at, 'at'));
  }

  /** 在单个事务内执行推进命令：版本校验 + 幂等 + 状态与事件原子落库 */
  advance(
    id: string,
    action: 'start' | 'move' | 'pause' | 'resume',
    body: Record<string, unknown>,
  ): CommandResult {
    const requestId = body.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new ClockError('VALIDATION_ERROR', 'requestId 必须是非空字符串');
    }
    const expectedVersion = body.expectedVersion;
    if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) {
      throw new ClockError('VALIDATION_ERROR', 'expectedVersion 必须是非负安全整数');
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const dup = this.db
        .prepare('SELECT response FROM requests WHERE game_id = ? AND request_id = ?')
        .get(id, requestId) as { response: string } | undefined;
      if (dup) {
        this.db.exec('COMMIT');
        const result = JSON.parse(dup.response) as CommandResult;
        result.replayed = true;
        return result;
      }

      const state = this.loadState(id);
      if (state.version !== expectedVersion) {
        throw new ClockError(
          'VERSION_CONFLICT',
          `期望版本 ${expectedVersion} 与当前版本 ${state.version} 不一致`,
        );
      }

      const at = requireTimestamp(body.at, 'at');
      const before = snapshotOf(state);
      let transition;
      switch (action) {
        case 'start':
          transition = startGame(state, requireSide(body.side), at);
          break;
        case 'move':
          transition = applyMove(state, requireSide(body.side), at);
          break;
        case 'pause':
          transition = applyPause(state, at);
          break;
        case 'resume':
          transition = applyResume(state, at);
          break;
      }
      state.version += 1;

      const nextSeq =
        ((this.db.prepare('SELECT MAX(seq) AS m FROM events WHERE game_id = ?').get(id) as {
          m: number | null;
        }).m ?? 0) + 1;
      const after = snapshotOf(state);
      transition.events.forEach((ev, i) => {
        this.db
          .prepare(
            'INSERT INTO events (game_id, seq, type, at, side, note, before, after, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            id,
            nextSeq + i,
            ev.type,
            ev.at,
            ev.side,
            ev.note,
            JSON.stringify(i === 0 ? before : after),
            JSON.stringify(after),
            requestId,
          );
      });
      this.db
        .prepare('UPDATE games SET version = ?, state = ? WHERE id = ?')
        .run(state.version, JSON.stringify(state), id);

      const result: CommandResult = {
        ok: true,
        gameId: id,
        version: state.version,
        state,
        events: transition.events,
      };
      this.db
        .prepare('INSERT INTO requests (game_id, request_id, response) VALUES (?, ?, ?)')
        .run(id, requestId, JSON.stringify(result));
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 导出回放：初始状态 + 全部事件 + 终态，可用于逐次重放核对 */
  exportReplay(id: string): {
    gameId: string;
    initial: GameState;
    events: ClockEvent[];
    final: GameState;
  } {
    const final = this.loadState(id);
    const events = this.events(id);
    const initial: GameState = {
      ...createGame(id, final.initialMs, final.incrementMs),
    };
    return { gameId: id, initial, events, final };
  }
}
