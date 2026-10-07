// CLI：直接操作本地 SQLite 存储，或启动 API 服务。
import * as path from 'node:path';
import { Store } from './store';
import { startServer } from './server';
import { runDemo } from './demo';

const DATA_DIR = process.env.CLOCK_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'clocks.db');

function usage(): void {
  console.log(`Fischer 棋钟 CLI（逻辑时间，毫秒）
用法: node dist/cli.js <命令> [参数]

  serve [--port N]                     启动 API 服务（默认端口 0 = 自动选空闲端口）
  create <initialMs> <incrementMs>     创建棋钟
  show <id>                            查看当前状态
  start <id> <white|black> <at> <expectedVersion> <requestId>
  move <id> <white|black> <at> <expectedVersion> <requestId>
  pause <id> <at> <expectedVersion> <requestId>
  resume <id> <at> <expectedVersion> <requestId>
  preview <id> <at>                    只读预览（不写状态）
  events <id>                          列出全部事件
  event <id> <seq>                     查看某事件前后状态
  export <id>                          导出回放 JSON
  demo                                 运行题目演示场景`);
}

function print(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

function num(v: string | undefined, name: string): number {
  const n = Number(v);
  if (v === undefined || !Number.isSafeInteger(n) || n < 0) {
    throw new Error(`参数 ${name} 必须是非负整数毫秒，收到: ${v}`);
  }
  return n;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') { usage(); return; }

  if (cmd === 'demo') { runDemo(new Store(DB_PATH)); return; }

  if (cmd === 'serve') {
    const portIdx = args.indexOf('--port');
    const port = portIdx >= 0 ? num(args[portIdx + 1], 'port') : Number(process.env.PORT ?? 0);
    const store = new Store(DB_PATH);
    const { port: bound } = await startServer(store, port);
    console.log(`API 服务已启动: http://127.0.0.1:${bound}  (数据目录: ${DATA_DIR})`);
    return;
  }

  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case 'create':
        print(store.createGame(num(args[0], 'initialMs'), num(args[1], 'incrementMs')));
        break;
      case 'show':
        print(store.getGame(args[0]));
        break;
      case 'start':
        print(store.start(args[0], args[1] as never, num(args[2], 'at'), num(args[3], 'expectedVersion'), args[4]));
        break;
      case 'move':
        print(store.move(args[0], args[1] as never, num(args[2], 'at'), num(args[3], 'expectedVersion'), args[4]));
        break;
      case 'pause':
        print(store.pause(args[0], num(args[1], 'at'), num(args[2], 'expectedVersion'), args[3]));
        break;
      case 'resume':
        print(store.resume(args[0], num(args[1], 'at'), num(args[2], 'expectedVersion'), args[3]));
        break;
      case 'preview':
        print(store.preview(args[0], num(args[1], 'at')));
        break;
      case 'events':
        print(store.listEvents(args[0]));
        break;
      case 'event':
        print(store.getEventWithBefore(args[0], num(args[1], 'seq')));
        break;
      case 'export':
        print(store.exportReplay(args[0]));
        break;
      default:
        usage();
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main().catch((e) => {
  const code = (e as { code?: string }).code;
  console.error(`错误 [${code ?? 'ERR_INTERNAL'}]: ${(e as Error).message}`);
  process.exitCode = 1;
});
