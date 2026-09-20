# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱、档期占用闭环和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

SQLite 数据库（sql.js 落盘）首次启动时创建到 `data/app.db`。

## 常用接口

档案：

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

巡演档期占用闭环（`/api/tourSchedules`，状态：草稿 → 待替换/已锁定 → 巡演中 → 返场清点中 → 已闭环）：

- `POST /api/tourSchedules` 创建档期草稿（按日期 + 箱位编排清单，支持 `autoSubmit`）
- `POST /api/tourSchedules/:id/submit` 提交锁场
- `POST /api/tourSchedules/:id/reassign` 演出前更换角色，旧场次清单立即失效并按新件重算
- `POST /api/tourSchedules/:id/depart` 出发巡演
- `POST /api/tourSchedules/:id/returnCheck` 返场清点（可同时登记缺损）
- `POST /api/tourSchedules/:id/close` 缺损全部处理后闭环，释放占用
- `POST /api/tourSchedules/:id/cancel` 演出前取消
- `GET  /api/tourSchedules/:id/manifest` 单场占用履历（含已失效的历史版本锁）
- `GET  /api/puppetHeads/:id/occupancy`、`GET /api/accessories/:id/occupancy` 单件占用查询

### 占用规则

- 每场演出按 `startDate~endDate` 和偶头 `boxNo`（箱位）锁定偶头与配件；日期重叠的档期不得重复占用同一偶头、配件或箱位，不重叠的后续档期可正常排期。
- 提交锁场时，缺件或待修件不参与冲突判定，只转为**替换候选**（`待替换` 状态，候选含可用性与阻塞原因）；档期/箱位冲突为硬冲突，返回 409 且不占用任何件。
- 演出开始前 `reassign` 更换任一角色：旧版清单立即释放失效，按新件整体重算（`manifestVersion` 递增，旧锁在 manifest 中留痕）。
- 返场清点未闭环前，相关偶头/配件不得进入下一档期（即使日期不重叠也返回 `RETURN_NOT_CLOSED`）；闭环或取消后才释放。
- 重复或并发锁场沿用首次结果：支持 `Idempotency-Key`/`X-Idempotency-Key` 请求头（或 `requestId`），未显式提供时按档期+动作+请求体生成默认键；同键不同内容返回 409。
- 列表、单场 manifest、单件 occupancy 与刷新后状态共用同一份锁数据；档期状态流转不能通过通用 `PATCH /api/tourSchedules/:id` 绕过（返回 405）。

代码分三层：请求入口（`routes/`）、状态判断（`lib/scheduleService.js`）、记录持久化（`lib/db.js`）。

## 测试

```bash
npm test
```

- `test/e2e.js`：19 项端到端规则（占用冲突、替换候选、更换重算、返场闭环、幂等等）
- `test/persistence-concurrency.js`：重启持久化一致性与真并发锁场（独立临时库，端口 3960）
