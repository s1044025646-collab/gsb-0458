# Fischer 双人棋钟与落旗回放后端

离线、本地可运行的双人 Fischer 增益棋钟服务。只做时钟记账与事件边界：
不实现棋盘、落子合法性、网络对战、真实定时弹窗或其他计时制。
提供 HTTP API 与 CLI，全部时间使用调用方提交的显式逻辑时间戳（非负安全整数毫秒），测试不依赖真实等待。

技术栈：TypeScript + Node.js（>= 22.5，使用内置 node:sqlite，零原生依赖）+ SQLite。
Windows 本地直接运行，不需要 Docker / WSL / 外部服务。

## 快速开始

    npm install        # 仅安装 typescript 与 @types/node（开发依赖）
    npm run build      # 编译到 dist/
    npm test           # 构建并运行全部测试（node:test，纯逻辑时间）
    npm start          # 启动 HTTP 服务（默认端口 0 = 自动选择空闲端口）
    npm run demo       # 运行题目演示场景并打印每步状态

端口配置：`npm start -- --port=8080` 或环境变量 `PORT`；缺省为 `0`（系统分配空闲端口）。
数据目录：项目内 `data/`（可用环境变量 `CLOCK_DATA_DIR` 覆盖），SQLite 文件为 `<数据目录>/clocks.sqlite`。

## 核心语义

### 逻辑时间

- 所有 `at` 时间戳由调用方显式给定，服务从不读取系统时钟来替代逻辑时间。
- 时间戳必须不早于最后已提交事件的时间（anchorAt），倒序输入返回 `STALE_TIMESTAMP`。
- 相同时间戳的连续合法换手表示零耗时，先后顺序由已提交事件序号决定。

### 计段结算（事务边界）

每次推进事件（move / pause）按以下顺序在单个 SQLite 事务内完成：

1. 以 `事件时间 - 上次有效计时起点(anchorAt)` 从当前行棋方余额中扣除；
2. 判断是否落旗：剩余 <= 0 即落旗（恰好为零也算），同一时刻的 move 不能先领增益救回；
3. 未落旗才执行事件本身（move 加增益并换手 / pause 冻结余额）。

落旗时刻记录为 `flagAt = 本段起点 + 本段开始时剩余时间`，而不是晚到请求的提交时间。
余额显示最低为零，不输出负倒计时。

- `start`：仅 created 状态可调用，指定先行方与起始时间戳；重复 start 报 `INVALID_STATE`。
- `move`：仅运行中且当前行棋方；错误方落子返回 `WRONG_SIDE`，不改变任何余额、事件序号或起点。
- `pause`：先结算再冻结双方余额；若请求晚于落旗，则提交落旗事件而非成功暂停。
- `resume`：仅暂停状态；暂停期间经过的时间不扣除，新计段从恢复时间开始。
- 终局（flagged）后任何推进返回 `GAME_OVER`，落旗方与时刻原样保留。

### 预览（preview）

`preview(at)` 为只读计算：返回给定逻辑时间下的余额与预计落旗
（`status: "would-flag"`、`projectedFlagSide/At`），不保存事件、不消耗增益、
不改变后续可提交的时间边界，也不会把持久化比赛变成终局。
`at` 不能早于最后提交时刻（`PREVIEW_IN_PAST`）；历史状态请通过事件查询获得。

### 幂等与并发

- 每次推进必须携带 `requestId` 与 `expectedVersion`。
- 相同 `(gameId, requestId)` 的重复请求直接返回首次保存的结果（`replayed: true`），不重复落库。
- `expectedVersion` 与当前版本不一致返回 `VERSION_CONFLICT`；
  状态更新、事件写入、请求记录在同一事务（BEGIN IMMEDIATE）内原子提交，并发旧版本请求中只有一个能成功。
- 事件体非法（参数错误）整体拒绝且不产生任何写入；
  格式合法但到达时已过截止的走棋会提交落旗事件（真实超时），与参数错误区分。
- 重启后仅凭 SQLite 中的持久化数据与新的逻辑时间继续，不需要后台定时器补写事件。

## HTTP API

统一 JSON；错误响应为 `{ "ok": false, "error": { "code", "message" } }`。

- `POST /games` 创建 `{ id?, initialMs, incrementMs }`
- `GET /games`、`GET /games/:id` 列表 / 当前状态
- `POST /games/:id/start` `{ side, at, requestId, expectedVersion }`
- `POST /games/:id/move` 同上
- `POST /games/:id/pause` `{ at, requestId, expectedVersion }`
- `POST /games/:id/resume` 同上
- `GET /games/:id/preview?at=<ms>` 只读预览
- `GET /games/:id/events` 事件列表（含每个事件前后状态快照）
- `GET /games/:id/replay` 导出回放：初始状态 + 全部事件 + 终态

错误码：`VALIDATION_ERROR`(400)、`WRONG_SIDE`(400)、`STALE_TIMESTAMP`(400)、`PREVIEW_IN_PAST`(400)、
`NOT_FOUND`(404)、`INVALID_STATE`(409)、`GAME_OVER`(409)、`VERSION_CONFLICT`(409)。

## CLI

    node dist/src/cli.js create <id> <initialMs> <incrementMs>
    node dist/src/cli.js start  <id> <white|black> <at>
    node dist/src/cli.js move   <id> <white|black> <at>
    node dist/src/cli.js pause  <id> <at>
    node dist/src/cli.js resume <id> <at>
    node dist/src/cli.js state  <id>
    node dist/src/cli.js preview <id> <at>
    node dist/src/cli.js events <id>
    node dist/src/cli.js replay <id>
    node dist/src/cli.js list

推进命令可选 `--request-id=<rid>`、`--expected-version=<n>`（缺省自动生成 requestId，expectedVersion 取当前版本）。

## 演示场景（npm run demo 可复现）

初始 60000ms、增益 2000ms：

- start 白 @0 → 白 60000 / 黑 60000
- move 白 @10000 → 白 52000 / 黑 60000（60000-10000+2000）
- pause @25000 → 白 52000 / 黑 45000（黑扣 5000 后冻结）
- resume @100000 → 白 52000 / 黑 45000（暂停期间不计时）
- move 黑 @110000 → 白 52000 / 黑 37000（45000-10000+2000）

落旗验证：初始 1000、增益 100，白在 at=1000 走棋仍落旗，flagAt=1000。

测试另覆盖：零耗时同刻换手、错误方、倒序时间戳、暂停中预览、重复请求、过期版本、
晚到落旗、重启续走、回放事件链与逐次执行一致性。

## 项目结构

- `src/clock.ts` 纯领域逻辑（状态机、结算、落旗、预览），不依赖 IO
- `src/store.ts` SQLite 持久化：事务、版本、幂等请求、事件快照、回放导出
- `src/server.ts` HTTP API（node:http）
- `src/cli.ts` 命令行入口
- `src/demo.ts` 演示脚本
- `test/` node:test 测试（全部使用逻辑时间，无真实等待）

## 限制

- 单进程服务；并发安全依赖 SQLite 事务与单写者，未做多实例横向扩展。
- node:sqlite 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
- 无撤销历史、无多阶段加时（如每 40 手加时），终局不可再继续。
- 回放导出为 JSON 快照序列，校验方式是逐事件重放比对（测试已覆盖）。
