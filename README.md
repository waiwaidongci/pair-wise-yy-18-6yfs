# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪，并对巡演档期做按日期与箱位的占用闭环。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

端到端验证（需先启动服务，会写当前库）：

```bash
npm test
```

## 分层结构

请求入口、状态判断、记录持久化分开实现：

- `server.js` — HTTP 请求入口：收参、幂等键、出参，不写业务判断。
- `lib/scheduleState.js` — 状态判断层（纯函数）：可用性、档期冲突、替换候选、单件占用、状态流转、刷新后自动派生。
- `lib/scheduleService.js` — 编排层：串行互斥 + 事务 + 幂等，串起快照、判断、落库。
- `lib/scheduleStore.js` — 档期/锁表持久化。
- `lib/db.js` — SQLite（sql.js，纯 JS，无原生依赖）记录、事件、锁表、幂等表。

## 档期闭环规则

- 每场演出按 `showDates`（多个日期）+ `boxNo`（箱位）锁定偶头与配件。
- 同件同日不得被两个档期重复占用；同一天同一箱位也只能属于一个档期。
- 缺件、待修、配件不在库不会被静默替换：提交时返回 `ITEMS_UNAVAILABLE` 与同剧目同角色的替换候选，需在 `confirmedReplacements` 中确认后重提。
- 演出前更换任一角色/偶头：旧场次清单整版失效（旧锁保留为 `active=0` 历史），按新件全量重算，清单版本 `manifestVersion` 递增。
- 返场清点中可登记缺损/遗失（自动写缺损追踪并回写档案状态）；未闭环前相关偶头/配件显示「返场未闭环」，不得进入下一档期。闭环后占用才释放。
- 重复请求或并发请求：带相同 `Idempotency-Key`（或 body 内 `idempotencyKey`）时直接沿用首次结果（含首次失败），不重复占用；无键重复提交按当前状态返回 `409`。
- 列表视图、单场履历（`/manifest`）、单件占用、刷新/重启后状态均出自同一锁快照与同一派生规则；过首个演出日的「已锁档」自动派生为「演出待开场」。

## 档期接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/tourSchedules` | 创建档期草稿（showName/venue/play/showDates/boxNo/headIds/accessoryIds） |
| GET | `/api/tourSchedules` | 档期列表（含自动派生状态） |
| GET | `/api/tourSchedules/:id/conflicts` | 预检：冲突、缺件、替换候选（不落锁） |
| POST | `/api/tourSchedules/:id/submit` | 提交锁场（可带 confirmedReplacements） |
| POST | `/api/tourSchedules/:id/swap` | 演出前更换 `{itemType, fromItemId, toItemId}` |
| POST | `/api/tourSchedules/:id/dispatch` | 出发巡演（已锁档/演出待开场 → 巡演中） |
| POST | `/api/tourSchedules/:id/checkin` | 返场清点，可带 `losses:[{itemType,itemId,problem}]` |
| POST | `/api/tourSchedules/:id/close` | 返场清点闭环，释放占用 |
| GET | `/api/tourSchedules/:id/manifest` | 单场履历：当前清单版本 + 活动锁 + 事件时间线 |
| GET | `/api/occupancy/head[?date=YYYY-MM-DD]` | 偶头占用列表（空闲/档期占用/返场未闭环） |
| GET | `/api/occupancy/accessory[?date=...]` | 配件占用列表 |
| GET | `/api/occupancy/head/:id` | 单件当前占用 + 全部档期锁履历（含失效版本） |

写操作建议带 `Idempotency-Key` 头。

## 常用档案接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

SQLite 数据库文件在首次启动时创建到 `data/app.db`。
