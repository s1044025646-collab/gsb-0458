// 演示场景：60000/2000 主场景 + 1000/100 恰零落旗场景。
import { Store } from './store';

export function runDemo(store: Store): void {
  console.log('=== 场景一：初始 60000ms，增益 2000ms ===');
  const g = store.createGame(60000, 2000).game;
  const id = g.id;
  let v = g.version;
  let rid = 0;
  const next = (): string => `demo1-${++rid}`;
  let r = store.start(id, 'white', 0, v, next());
  v = r.game.version;
  console.log(`start white@0      -> 白 ${r.game.whiteMs} 黑 ${r.game.blackMs} 行棋方 ${r.game.turn} [${r.game.status}]`);
  r = store.move(id, 'white', 10000, v, next());
  v = r.game.version;
  console.log(`move  white@10000  -> 白 ${r.game.whiteMs} 黑 ${r.game.blackMs} 行棋方 ${r.game.turn} [${r.game.status}]  (期望 白52000 黑60000)`);
  r = store.pause(id, 25000, v, next());
  v = r.game.version;
  console.log(`pause @25000       -> 白 ${r.game.whiteMs} 黑 ${r.game.blackMs} [${r.game.status}]  (期望 黑45000)`);
  r = store.resume(id, 100000, v, next());
  v = r.game.version;
  console.log(`resume @100000     -> 白 ${r.game.whiteMs} 黑 ${r.game.blackMs} [${r.game.status}]  (暂停期间不扣时)`);
  r = store.move(id, 'black', 110000, v, next());
  console.log(`move  black@110000 -> 白 ${r.game.whiteMs} 黑 ${r.game.blackMs} 行棋方 ${r.game.turn} [${r.game.status}]  (期望 白52000 黑37000)`);

  console.log('\n=== 场景二：初始 1000ms，增益 100ms，恰在 1000 时走棋 ===');
  const g2 = store.createGame(1000, 100).game;
  store.start(g2.id, 'white', 0, g2.version, 'demo2-1');
  const r2 = store.move(g2.id, 'white', 1000, 1, 'demo2-2');
  console.log(`move white@1000    -> [${r2.game.status}] 落旗方 ${r2.game.flagSide} 落旗时刻 ${r2.game.flagTs} (期望 flagged/white/1000，增益不救回)`);
}
