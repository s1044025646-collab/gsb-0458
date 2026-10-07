# Fischer 双人棋钟与落旗回放后端

离线、本地可运行的双人 Fischer 增益棋钟服务。只做**时钟记账与事件边界**：不实现棋盘、落子合法性、网络对战、真实定时器，也没有后台弹窗。全部时间由调用方提交**显式逻辑时间戳**（非负安全整数毫秒），测试不依赖真实等待。

技术栈：TypeScript + Node.js（>= 22，使用内置 `node:sqlite` 与 `node:http`，零运行时依赖）+ SQLite。Windows 本地直接运行，不需要 Docker / WSL / 外部服务。

## 快速开始

```powershell
npm install        # 仅安装开发依赖 typescript / @types/node
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试（node:test，纯逻辑时间）
npm run demo       # 运行题目演示场景
npm start          # 启动 API 服务，默认端口 0 = 自动选择空闲端口
node dist/cli.js serve --port 8080   # 指定端口
node scripts/smoke.mjs               # API 冒烟测试
```

数据保存在项目内 `data/clocks.db`（可用环境变量 `CLOCK_DATA_DIR` 覆盖）。重启后凭持久化数据与新逻辑时间继续，无需后台定时器补写事件。

## 逻辑时间模型

- 所有时间戳 `at` 都是调用方给定的逻辑毫秒，**绝不**用系统当前时间替代。
- 时间戳不得早于最后已提交事件的时间，倒序输入返回 `ERR_TIME_REGRESSION`。
- 创建后状态为 `created`；`start` 指定先行方与起始时间戳后进入 `running`。
- 运行期间只有当前行棋方消耗时间。收到推进事件时：
  1. 以 `事件时间 - 上次有效计时起点` 从当前方余额扣除；
  2. 判断是否落旗（**余额恰好为零也算落旗**，同一时刻的 move 不能先领增益救回）；
  3. 未落旗才执行事件本身。
- 实际落旗时刻 = 本段起点 + 当时剩余时间，而不是晚到请求的提交时间。
- `move` 只接受当前行棋方：先扣本段耗时，再加固定增益，保存对方原余额并切换行棋方，以本次时间戳作为新起点。相同时间戳的连续合法换手表示零耗时，顺序由已提交事件序号确定。错方落子返回 `ERR_WRONG_SIDE`，不改变余额、事件序号与起点。
- `pause` 先结算到暂停时刻再冻结双方余额；若暂停请求晚于落旗时刻，则记录落旗（事件类型 `flag`）而非成功暂停。`resume` 仅在暂停态执行，暂停期间不扣时，新计时从恢复时刻开始。
- 暂停中拒绝 `move`（`ERR_PAUSED`，不发放增益）；重复 `start`、未暂停时 `resume`、未启动时 `move` 均有明确错误码。终局（`flagged`）后不再接受任何推进，原样保留落旗方与落旗时刻。

## 事务边界与幂等

- 每次推进在一个 SQLite `BEGIN IMMEDIATE ... COMMIT` 事务内完成：校验期望版本 → 应用领域规则 → 原子更新余额/起点/版本并追加事件。事件体非法（参数错误、错方、倒序等）整体回滚，不留痕迹。
- 每个推进请求携带 `expectedVersion` 与 `requestId`：
  - 相同 `requestId` 的重复请求返回首次的原结果（`replayed: true`），不重复记账；
  - `expectedVersion` 与当前版本不一致返回 `ERR_VERSION_CONFLICT`（HTTP 409），并发旧版本只有一个能提交。
- 区分两类"失败"：格式/规则非法 → 拒绝且不落库；格式合法但到达时已过截止 → **提交**落旗事件（真实超时）。

## 预览（preview）不写状态

`preview(at)` 是只读计算：返回给定逻辑时间下的余额（最低显示为 0）、当前行棋方、暂停状态与**预计落旗** `projectedFlag { side, flagTs }`。它不保存事件、不消耗增益、不改变后续可提交的时间边界，也不会把比赛直接变成终局——实际下一条有效推进请求才提交结果。预览不能回溯到最后提交时刻以前；历史状态请通过事件查询（每个事件都保存了 `stateAfter`，并可查 `stateBefore`）。

## API

基准地址 `http://127.0.0.1:<port>`，请求/响应均为 JSON。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/games` | 建棋钟 `{initialMs, incrementMs}` |
| GET | `/games` / `/games/:id` | 列表 / 当前状态 |
| POST | `/games/:id/start` | `{side, at, expectedVersion, requestId}` |
| POST | `/games/:id/move` | 同上 |
| POST | `/games/:id/pause` | `{at, expectedVersion, requestId}` |
| POST | `/games/:id/resume` | 同上 |
| GET | `/games/:id/preview?at=...` | 只读预览 |
| GET | `/games/:id/events` | 全部事件（含每个事件后的完整状态） |
| GET | `/games/:id/events/:seq` | 某事件及其前后状态 |
| GET | `/games/:id/export` | 导出回放 JSON（事件流 + 逐事件前后状态） |

错误响应：`{"error": {"code": "...", "message": "..."}}`。错误码：`ERR_INVALID_PARAMS`(400)、`ERR_NOT_FOUND`(404)、`ERR_VERSION_CONFLICT`/`ERR_GAME_OVER`/`ERR_TIME_REGRESSION`(409)、`ERR_WRONG_SIDE`/`ERR_PAUSED`/`ERR_NOT_PAUSED`/`ERR_NOT_STARTED`/`ERR_ALREADY_STARTED`(400)。

## CLI

```
node dist/cli.js create <initialMs> <incrementMs>
node dist/cli.js start|move <id> <white|black> <at> <expectedVersion> <requestId>
node dist/cli.js pause|resume <id> <at> <expectedVersion> <requestId>
node dist/cli.js preview <id> <at>
node dist/cli.js show <id> | events <id> | event <id> <seq> | export <id>
node dist/cli.js serve [--port N]
node dist/cli.js demo
```

## 演示场景（npm run demo 实际输出）

初始 60000ms、增益 2000ms，白方 0 时刻开始：

| 事件 | 白余 | 黑余 | 状态 |
| --- | --- | --- | --- |
| start white@0 | 60000 | 60000 | running |
| move white@10000 | 52000 | 60000 | running，黑方行棋 |
| pause @25000 | 52000 | 45000 | paused |
| resume @100000 | 52000 | 45000 | running（暂停期不扣时） |
| move black@110000 | 52000 | 37000 | running，白方行棋 |

另以初始 1000ms、增益 100ms 验证：白方恰在 1000 时刻走棋仍落旗（`flagSide=white, flagTs=1000`），增益不救回。

## 测试

`src/test/clock.test.ts` 覆盖：演示全流程手算事件表核对、恰零落旗、晚到落旗时刻、零耗时换手、错方、倒序、暂停中预览与拒绝 move、重复请求幂等、过期版本冲突、暂停晚于落旗、终局拒绝推进、参数校验、回放与逐次执行一致性、重启后凭持久化数据继续。全部使用逻辑时间，无真实等待。

## 目录结构

```
src/clock.ts   纯领域逻辑（结算、落旗、预览），无 IO
src/store.ts   SQLite 持久化：事务、版本、幂等、事件与回放
src/server.ts  node:http JSON API
src/cli.ts     命令行入口
src/demo.ts    演示场景
src/test/      node:test 测试
scripts/smoke.mjs  API 冒烟脚本
```

## 假设与限制

- 单进程本地服务；`BEGIN IMMEDIATE` 保证库内串行提交，多并发请求按到达顺序逐一提交。
- `pause`/`resume` 不携带行棋方；落旗后 `turn` 保留落旗方。
- Node.js 的 `node:sqlite` 目前标记为 experimental（启动时有警告），功能对本项目足够；如需消除警告可换 `better-sqlite3`。
- 不实现撤销历史、多阶段加时（如每 40 手加时）与真实倒计时弹窗。
