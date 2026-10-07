import { ClockStore } from './store.js';
import { ClockError } from './clock.js';

const dataDir = process.env.CLOCK_DATA_DIR ?? 'data';
const store = new ClockStore(dataDir);

function out(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

function num(v: string | undefined, name: string): number {
  const n = Number(v);
  if (v === undefined || !Number.isSafeInteger(n) || n < 0) {
    throw new ClockError('VALIDATION_ERROR', `${name} 必须是非负安全整数毫秒，收到: ${v}`);
  }
  return n;
}

function side(v: string | undefined): 'white' | 'black' {
  if (v !== 'white' && v !== 'black') {
    throw new ClockError('VALIDATION_ERROR', `side 必须是 white 或 black，收到: ${v}`);
  }
  return v;
}

let reqCounter = 0;
function rid(): string {
  reqCounter += 1;
  return `cli-${process.pid}-${Date.now()}-${reqCounter}`;
}

function usage(): void {
  console.log(`Fischer 棋钟 CLI（数据目录: ${dataDir}，可用 CLOCK_DATA_DIR 覆盖）

用法: node dist/cli.js <命令> [参数]

  create <id> <initialMs> <incrementMs>   创建棋钟
  start <id> <side> <at>                  启动，指定先行方与逻辑时间戳
  move <id> <side> <at>                   走棋（仅当前行棋方）
  pause <id> <at>                         暂停
  resume <id> <at>                        恢复
  state <id>                              查看当前状态
  preview <id> <at>                       只读预览（不写状态）
  events <id>                             查看事件及前后状态
  replay <id>                             导出回放
  list                                    列出全部棋钟

推进命令可选参数: --request-id=<rid> --expected-version=<n>
（缺省时自动生成 requestId，expectedVersion 取当前版本）`);
}

function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
}

function advance(id: string, action: 'start' | 'move' | 'pause' | 'resume', body: Record<string, unknown>): void {
  const expected = opt('expected-version');
  const version = expected !== undefined ? num(expected, 'expected-version') : store.get(id).version;
  const result = store.advance(id, action, {
    ...body,
    requestId: opt('request-id') ?? rid(),
    expectedVersion: version,
  });
  out(result);
}

function main(): void {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case 'create':
      out({ ok: true, state: store.create(args[0], num(args[1], 'initialMs'), num(args[2], 'incrementMs')) });
      break;
    case 'start':
      advance(args[0], 'start', { side: side(args[1]), at: num(args[2], 'at') });
      break;
    case 'move':
      advance(args[0], 'move', { side: side(args[1]), at: num(args[2], 'at') });
      break;
    case 'pause':
      advance(args[0], 'pause', { at: num(args[1], 'at') });
      break;
    case 'resume':
      advance(args[0], 'resume', { at: num(args[1], 'at') });
      break;
    case 'state':
      out({ ok: true, state: store.get(args[0]) });
      break;
    case 'preview':
      out({ ok: true, preview: store.preview(args[0], num(args[1], 'at')) });
      break;
    case 'events':
      out({ ok: true, events: store.events(args[0]) });
      break;
    case 'replay':
      out({ ok: true, replay: store.exportReplay(args[0]) });
      break;
    case 'list':
      out({ ok: true, games: store.list() });
      break;
    default:
      usage();
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  if (err instanceof ClockError) {
    out({ ok: false, error: { code: err.code, message: err.message } });
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  store.close();
}
