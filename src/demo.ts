import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClockStore } from './store.js';

const dataDir = path.join('data', 'demo');
fs.rmSync(dataDir, { recursive: true, force: true });
const store = new ClockStore(dataDir);

function show(label: string, v: unknown): void {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(v, null, 2));
}

// 场景一：初始 60000ms，增益 2000ms
store.create('demo-1', 60000, 2000);
show('创建（初始 60000 / 增益 2000）', store.get('demo-1'));

let v = 0;
const adv = (action: 'start' | 'move' | 'pause' | 'resume', body: Record<string, unknown>, rid: string) =>
  store.advance('demo-1', action, { ...body, requestId: rid, expectedVersion: v++ });

show('start 白方 @0', adv('start', { side: 'white', at: 0 }, 'd1-start'));
show('move 白 @10000（白 60000-10000+2000=52000，黑 60000）', adv('move', { side: 'white', at: 10000 }, 'd1-m1'));
show('pause @25000（黑 60000-5000=45000）', adv('pause', { at: 25000 }, 'd1-p1'));
show('preview @90000（暂停中预览，余额冻结）', store.preview('demo-1', 90000));
show('resume @100000（暂停期间不计时）', adv('resume', { at: 100000 }, 'd1-r1'));
show('move 黑 @110000（黑 45000-10000+2000=37000，白 52000）', adv('move', { side: 'black', at: 110000 }, 'd1-m2'));
show('preview @200000（白预计落旗）', store.preview('demo-1', 200000));
show('事件列表', store.events('demo-1'));
show('导出回放', store.exportReplay('demo-1'));

// 场景二：初始 1000ms，增益 100ms，恰在 1000 时走棋仍落旗
store.create('demo-2', 1000, 100);
store.advance('demo-2', 'start', { side: 'white', at: 0, requestId: 'd2-start', expectedVersion: 0 });
show(
  'move 白 @1000（余额恰为零 → 落旗，flagAt=1000）',
  store.advance('demo-2', 'move', { side: 'white', at: 1000, requestId: 'd2-m1', expectedVersion: 1 }),
);

store.close();
console.log('\n演示完成。');
