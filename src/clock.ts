export type Side = 'white' | 'black';
export type Status = 'created' | 'running' | 'paused' | 'flagged';

export interface GameState {
  id: string;
  initialMs: number;
  incrementMs: number;
  status: Status;
  sideToMove: Side | null;
  whiteMs: number;
  blackMs: number;
  /** 最近一次已提交事件的逻辑时间戳，即当前计时段的起点 */
  anchorAt: number | null;
  version: number;
  flagSide: Side | null;
  flagAt: number | null;
}

export type EventType = 'create' | 'start' | 'move' | 'pause' | 'resume' | 'flag';

export interface ClockEvent {
  seq: number;
  type: EventType;
  at: number;
  side: Side | null;
  note: string;
  before: Snapshot;
  after: Snapshot;
}

export interface Snapshot {
  status: Status;
  sideToMove: Side | null;
  whiteMs: number;
  blackMs: number;
  anchorAt: number | null;
  flagSide: Side | null;
  flagAt: number | null;
}

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'WRONG_SIDE'
  | 'STALE_TIMESTAMP'
  | 'INVALID_STATE'
  | 'GAME_OVER'
  | 'VERSION_CONFLICT'
  | 'PREVIEW_IN_PAST';

export class ClockError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
    this.name = 'ClockError';
  }
}

export function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

export function requireTimestamp(v: unknown, field: string): number {
  if (!isNonNegSafeInt(v)) {
    throw new ClockError('VALIDATION_ERROR', `${field} 必须是非负安全整数毫秒`);
  }
  return v;
}

export function requireSide(v: unknown, field = 'side'): Side {
  if (v !== 'white' && v !== 'black') {
    throw new ClockError('VALIDATION_ERROR', `${field} 必须是 "white" 或 "black"`);
  }
  return v;
}

export function snapshotOf(s: GameState): Snapshot {
  return {
    status: s.status,
    sideToMove: s.sideToMove,
    whiteMs: s.whiteMs,
    blackMs: s.blackMs,
    anchorAt: s.anchorAt,
    flagSide: s.flagSide,
    flagAt: s.flagAt,
  };
}

export function balanceOf(s: GameState, side: Side): number {
  return side === 'white' ? s.whiteMs : s.blackMs;
}

function setBalance(s: GameState, side: Side, ms: number): void {
  if (side === 'white') s.whiteMs = ms;
  else s.blackMs = ms;
}

export function other(side: Side): Side {
  return side === 'white' ? 'black' : 'white';
}

function checkAnchor(s: GameState, at: number): number {
  if (s.anchorAt === null) {
    throw new ClockError('INVALID_STATE', '棋钟尚未启动');
  }
  if (at < s.anchorAt) {
    throw new ClockError('STALE_TIMESTAMP', `时间戳 ${at} 早于最后已提交事件时间 ${s.anchorAt}`);
  }
  return s.anchorAt;
}

function ensureNotOver(s: GameState): void {
  if (s.status === 'flagged') {
    throw new ClockError('GAME_OVER', `对局已结束：${s.flagSide} 方在 ${s.flagAt} 落旗`);
  }
}

/** 结算当前行棋方从 anchorAt 到 at 的消耗；返回剩余（可能 <= 0 表示落旗） */
function settle(s: GameState, at: number): { side: Side; remaining: number } {
  const anchor = checkAnchor(s, at);
  const side = s.sideToMove;
  if (side === null) throw new ClockError('INVALID_STATE', '当前无行棋方');
  const remaining = balanceOf(s, side) - (at - anchor);
  return { side, remaining };
}

function applyFlag(s: GameState, side: Side, anchor: number): void {
  const budget = balanceOf(s, side);
  setBalance(s, side, 0);
  s.status = 'flagged';
  s.flagSide = side;
  // 实际落旗时刻 = 本段起点 + 本段开始时剩余时间（而非晚到请求的提交时间）
  s.flagAt = anchor + budget;
}

export interface TransitionResult {
  events: Array<{ type: EventType; at: number; side: Side | null; note: string }>;
}

export function createGame(id: string, initialMs: number, incrementMs: number): GameState {
  if (!isNonNegSafeInt(initialMs) || initialMs <= 0) {
    throw new ClockError('VALIDATION_ERROR', 'initialMs 必须是正的安全整数毫秒');
  }
  if (!isNonNegSafeInt(incrementMs)) {
    throw new ClockError('VALIDATION_ERROR', 'incrementMs 必须是非负安全整数毫秒');
  }
  return {
    id,
    initialMs,
    incrementMs,
    status: 'created',
    sideToMove: null,
    whiteMs: initialMs,
    blackMs: initialMs,
    anchorAt: null,
    version: 0,
    flagSide: null,
    flagAt: null,
  };
}

export function startGame(s: GameState, side: Side, at: number): TransitionResult {
  ensureNotOver(s);
  if (s.status !== 'created') {
    throw new ClockError('INVALID_STATE', '棋钟已启动，不能重复 start');
  }
  requireTimestamp(at, 'at');
  s.status = 'running';
  s.sideToMove = side;
  s.anchorAt = at;
  return { events: [{ type: 'start', at, side, note: `${side} 先行，计时开始` }] };
}

export function applyMove(s: GameState, side: Side, at: number): TransitionResult {
  ensureNotOver(s);
  if (s.status === 'created') {
    throw new ClockError('INVALID_STATE', '棋钟尚未启动，不能走棋');
  }
  if (s.status === 'paused') {
    throw new ClockError('INVALID_STATE', '棋钟处于暂停状态，不能走棋');
  }
  requireTimestamp(at, 'at');
  if (side !== s.sideToMove) {
    // 错误方落子：不改变任何余额、事件序号或起点
    throw new ClockError('WRONG_SIDE', `当前行棋方是 ${s.sideToMove}，拒绝 ${side} 走棋`);
  }
  const anchor = checkAnchor(s, at);
  const { remaining } = settle(s, at);
  if (remaining <= 0) {
    // 余额恰好为零也算落旗；同一时刻的 move 不能先领增益救回
    applyFlag(s, side, anchor);
    return {
      events: [{ type: 'flag', at, side, note: `${side} 提交于 ${at}，实际落旗时刻 ${s.flagAt}` }],
    };
  }
  setBalance(s, side, remaining + s.incrementMs);
  s.sideToMove = other(side);
  s.anchorAt = at;
  return {
    events: [{ type: 'move', at, side, note: `${side} 走棋，耗时结算后加增益 ${s.incrementMs}ms` }],
  };
}

export function applyPause(s: GameState, at: number): TransitionResult {
  ensureNotOver(s);
  if (s.status !== 'running') {
    throw new ClockError('INVALID_STATE', `当前状态 ${s.status} 不能暂停`);
  }
  requireTimestamp(at, 'at');
  const anchor = checkAnchor(s, at);
  const { side, remaining } = settle(s, at);
  if (remaining <= 0) {
    // 暂停请求晚于落旗：记录落旗而不是成功暂停
    applyFlag(s, side, anchor);
    return {
      events: [{ type: 'flag', at, side, note: `pause 晚于落旗，${side} 实际落旗时刻 ${s.flagAt}` }],
    };
  }
  setBalance(s, side, remaining);
  s.status = 'paused';
  s.anchorAt = at;
  return { events: [{ type: 'pause', at, side: null, note: '暂停，双方余额冻结' }] };
}

export function applyResume(s: GameState, at: number): TransitionResult {
  ensureNotOver(s);
  if (s.status !== 'paused') {
    throw new ClockError('INVALID_STATE', '棋钟未处于暂停状态，不能恢复');
  }
  requireTimestamp(at, 'at');
  checkAnchor(s, at);
  // 暂停期间经过的时间不扣除，新计时从恢复时间开始
  s.status = 'running';
  s.anchorAt = at;
  return { events: [{ type: 'resume', at, side: null, note: '恢复计时，暂停期间不计时' }] };
}

export interface PreviewResult {
  at: number;
  status: Status | 'would-flag';
  sideToMove: Side | null;
  whiteMs: number;
  blackMs: number;
  projectedFlagSide: Side | null;
  projectedFlagAt: number | null;
}

/** 只读预览：不保存事件、不消耗增益、不改变后续可提交的时间边界 */
export function preview(s: GameState, at: number): PreviewResult {
  requireTimestamp(at, 'at');
  if (s.anchorAt !== null && at < s.anchorAt) {
    throw new ClockError('PREVIEW_IN_PAST', `不能预览最后提交时刻 ${s.anchorAt} 之前的时间`);
  }
  const base: PreviewResult = {
    at,
    status: s.status,
    sideToMove: s.sideToMove,
    whiteMs: s.whiteMs,
    blackMs: s.blackMs,
    projectedFlagSide: s.flagSide,
    projectedFlagAt: s.flagAt,
  };
  if (s.status !== 'running' || s.sideToMove === null || s.anchorAt === null) {
    return base;
  }
  const side = s.sideToMove;
  const remaining = balanceOf(s, side) - (at - s.anchorAt);
  if (remaining <= 0) {
    if (side === 'white') base.whiteMs = 0;
    else base.blackMs = 0;
    base.status = 'would-flag';
    base.projectedFlagSide = side;
    base.projectedFlagAt = s.anchorAt + balanceOf(s, side);
  } else if (side === 'white') {
    base.whiteMs = remaining;
  } else {
    base.blackMs = remaining;
  }
  return base;
}
