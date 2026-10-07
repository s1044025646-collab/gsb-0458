// API 冒烟测试：启动服务 -> 建钟 -> start -> move -> 幂等重放 -> preview -> 过期版本
import { spawn } from 'node:child_process';

const server = spawn(process.execPath, ['dist/cli.js', 'serve', '--port', '0'], {
  env: { ...process.env, CLOCK_DATA_DIR: './data-smoke' },
});
const port = await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => {
    const m = String(d).match(/127\.0\.0\.1:(\d+)/);
    if (m) resolve(Number(m[1]));
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  setTimeout(() => reject(new Error('启动超时')), 10000);
});
const base = `http://127.0.0.1:${port}`;
const post = (p, body) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

const g = await post('/games', { initialMs: 60000, incrementMs: 2000 });
const id = g.body.game.id;
console.log('create:', g.status, id);
await post(`/games/${id}/start`, { side: 'white', at: 0, expectedVersion: 0, requestId: 's1' });
const m = await post(`/games/${id}/move`, { side: 'white', at: 10000, expectedVersion: 1, requestId: 'm1' });
console.log('move:', m.body.game.whiteMs, m.body.game.blackMs, m.body.game.turn);
const dup = await post(`/games/${id}/move`, { side: 'white', at: 10000, expectedVersion: 1, requestId: 'm1' });
console.log('dup replayed:', dup.body.replayed, 'seq:', dup.body.event.seq);
const pv = await fetch(`${base}/games/${id}/preview?at=999999`).then((r) => r.json());
console.log('preview:', pv.blackMs, 'projectedFlag:', JSON.stringify(pv.projectedFlag));
const stale = await post(`/games/${id}/move`, { side: 'black', at: 20000, expectedVersion: 1, requestId: 'stale1' });
console.log('stale version:', stale.status, stale.body.error.code);
const exp = await fetch(`${base}/games/${id}/export`).then((r) => r.json());
console.log('export events:', exp.events.length);
server.kill();
server.stdout.destroy();
server.stderr.destroy();
