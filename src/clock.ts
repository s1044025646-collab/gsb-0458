// 纯领域逻辑：Fischer 双人棋钟记账。不依赖 IO，可单测。

export type Side = 'white' | 'black';
export type Status = 'created' | 'running' | 'paused' | 'flagged';

export interface ClockState {
  initialMs: number;
  incrementMs: number;
  whiteMs: number;
  blackMs: number;
  turn: Side;
  status: Status;
  lastTs: number; // 最近一次已提交事件的逻辑时间戳（当前计时段起点）
  flagSide: Side | null; // 落旗方
  flagTs: number | null; // 实际落旗时刻 = 段起点 + 当时剩余
}

export type ErrorCode =
  | 'ERR_INVALID_PARAMS'
  | 'ERR_NOT_STARTED'
  | 'ERR_ALREADY_STARTED'
  | 'ERR_WRONG_SIDE'
  | 'ERR_PAUSED'
  | 'ERR_NOT_PAUSED'
  | 'ERR_GAME_OVER'
  | 'ERR_TIME_REGRESSION';

export class ClockError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
}

export function isSafeMs(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

export function other(side: Side): Side {
  return side === 'white' ? 'black' : 'white';
}

function balanceOf(s: ClockState, side: Side): number {
  return side === 'white' ? s.whiteMs : s.blackMs;
}

function setBalance(s: ClockState, side: Side, v: number): void {
  if (side === 'white') s.whiteMs = v;
  else s.blackMs = v;
}

export interface SettleResult {
  flagged: boolean;
  flagSide?: Side;
  flagTs?: number;
}

// 结算从 lastTs 到 at 当前行棋方的消耗；余额 <= 0 即落旗（含恰好为零）。
export function settle(s: ClockState, at: number): SettleResult {
  if (s.status !== 'running') return { flagged: false };
  const side = s.turn;
  const bal = balanceOf(s, side);
  const elapsed = at - s.lastTs;
  if (elapsed >= bal) {
    // 实际落旗时刻：段起点 + 原剩余，而不是晚到的提交时间
    return { flagged: true, flagSide: side, flagTs: s.lastTs + bal };
  }
  setBalance(s, side, bal - elapsed);
  return { flagged: false };
}

function applyFlag(s: ClockState, r: SettleResult): void {
  s.status = 'flagged';
  s.flagSide = r.flagSide!;
  s.flagTs = r.flagTs!;
  // 冻结余额：落旗方归零，对方保留原余额
  setBalance(s, s.flagSide!, 0);
}

function checkCommon(s: ClockState, at: number): void {
  if (!isSafeMs(at)) throw new ClockError('ERR_INVALID_PARAMS', 'at 必须是非负安全整数毫秒');
  if (s.status === 'flagged') throw new ClockError('ERR_GAME_OVER', '对局已终局（落旗），不再接受推进');
  if (at < s.lastTs) throw new ClockError('ERR_TIME_REGRESSION', `时间戳 ${at} 早于最后已提交事件 ${s.lastTs}`);
}

export type EventType = 'create' | 'start' | 'move' | 'pause' | 'resume' | 'flag';

export interface AppliedEvent {
  type: EventType;
  at: number;
  side: Side | null;
  detail: Record<string, unknown>;
}

export function createState(initialMs: number, incrementMs: number): ClockState {
  if (!isSafeMs(initialMs) || initialMs <= 0)
    throw new ClockError('ERR_INVALID_PARAMS', 'initialMs 必须是正的安全整数毫秒');
  if (!isSafeMs(incrementMs))
    throw new ClockError('ERR_INVALID_PARAMS', 'incrementMs 必须是非负安全整数毫秒');
  return {
    initialMs, incrementMs,
    whiteMs: initialMs, blackMs: initialMs,
    turn: 'white', status: 'created', lastTs: 0,
    flagSide: null, flagTs: null,
  };
}

export function applyStart(s: ClockState, side: Side, at: number): AppliedEvent {
  if (side !== 'white' && side !== 'black')
    throw new ClockError('ERR_INVALID_PARAMS', 'side 必须是 white 或 black');
  if (s.status !== 'created') throw new ClockError('ERR_ALREADY_STARTED', '棋钟已启动，不能重复 start');
  checkCommon(s, at);
  s.status = 'running';
  s.turn = side;
  s.lastTs = at;
  return { type: 'start', at, side, detail: {} };
}

export function applyMove(s: ClockState, side: Side, at: number): AppliedEvent {
  if (side !== 'white' && side !== 'black')
    throw new ClockError('ERR_INVALID_PARAMS', 'side 必须是 white 或 black');
  if (s.status === 'created') throw new ClockError('ERR_NOT_STARTED', '棋钟尚未启动');
  if (s.status === 'paused') throw new ClockError('ERR_PAUSED', '暂停中，拒绝 move');
  checkCommon(s, at);
  if (side !== s.turn) throw new ClockError('ERR_WRONG_SIDE', `当前行棋方是 ${s.turn}，拒绝 ${side} 落子`);
  const r = settle(s, at);
  if (r.flagged) {
    // 格式合法但到达已过截止：提交落旗结果，不发放增益
    applyFlag(s, r);
    return { type: 'flag', at, side, detail: { reason: 'move_after_deadline', flagTs: r.flagTs } };
  }
  // 先扣本段耗时（settle 已扣），再加增益，切换行棋方
  setBalance(s, side, balanceOf(s, side) + s.incrementMs);
  s.turn = other(side);
  s.lastTs = at;
  return { type: 'move', at, side, detail: { incrementMs: s.incrementMs } };
}

export function applyPause(s: ClockState, at: number): AppliedEvent {
  if (s.status === 'created') throw new ClockError('ERR_NOT_STARTED', '棋钟尚未启动');
  if (s.status === 'paused') throw new ClockError('ERR_NOT_PAUSED', '已处于暂停状态'); // 重复暂停
  checkCommon(s, at);
  const r = settle(s, at);
  if (r.flagged) {
    // 暂停请求晚于落旗：记录落旗而非成功暂停
    applyFlag(s, r);
    return { type: 'flag', at, side: null, detail: { reason: 'pause_after_deadline', flagTs: r.flagTs } };
  }
  s.status = 'paused';
  s.lastTs = at;
  return { type: 'pause', at, side: null, detail: {} };
}

export function applyResume(s: ClockState, at: number): AppliedEvent {
  if (s.status === 'created') throw new ClockError('ERR_NOT_STARTED', '棋钟尚未启动');
  if (s.status !== 'paused') throw new ClockError('ERR_NOT_PAUSED', '未暂停，不能 resume');
  checkCommon(s, at);
  s.status = 'running';
  s.lastTs = at; // 暂停期间不扣时，新计时从恢复时刻开始
  return { type: 'resume', at, side: null, detail: {} };
}

export interface PreviewResult {
  at: number;
  status: Status;
  turn: Side;
  whiteMs: number;
  blackMs: number;
  projectedFlag: { side: Side; flagTs: number } | null;
  flagSide: Side | null;
  flagTs: number | null;
}

// 只读预览：不保存事件、不消耗增益、不改变状态。
export function preview(s: ClockState, at: number): PreviewResult {
  if (!isSafeMs(at)) throw new ClockError('ERR_INVALID_PARAMS', 'at 必须是非负安全整数毫秒');
  if (at < s.lastTs) throw new ClockError('ERR_TIME_REGRESSION', `预览时间 ${at} 早于最后已提交事件 ${s.lastTs}，历史状态请查询事件`);
  const copy: ClockState = { ...s };
  let projectedFlag: PreviewResult['projectedFlag'] = null;
  if (copy.status === 'running') {
    const r = settle(copy, at);
    if (r.flagged) {
      projectedFlag = { side: r.flagSide!, flagTs: r.flagTs! };
      if (r.flagSide === 'white') copy.whiteMs = 0;
      else copy.blackMs = 0;
    }
  }
  return {
    at,
    status: copy.status,
    turn: copy.turn,
    whiteMs: Math.max(0, copy.whiteMs),
    blackMs: Math.max(0, copy.blackMs),
    projectedFlag,
    flagSide: s.flagSide,
    flagTs: s.flagTs,
  };
}
