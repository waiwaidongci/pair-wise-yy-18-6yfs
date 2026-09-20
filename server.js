const express = require('express');
const { randomUUID } = require('crypto');
const config = require('./project.config');
const db = require('./lib/db');
const store = require('./lib/scheduleStore');
const scheduleService = require('./lib/scheduleService');
const state = require('./lib/scheduleState');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter(
    (field) => data[field] === undefined || data[field] === ''
  );
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

/* ---------------- 通用档案入口（偶头/配件/修补/装箱/缺损） ---------------- */

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

app.get('/api/:collection', (req, res, next) => {
  if (!config.collections[req.params.collection]) return next();
  try {
    let rows = db.listRecords(req.params.collection);
    if (req.params.collection === 'tourSchedules') {
      rows = rows.map((r) => scheduleService.scheduleView(r));
    }
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', (req, res, next) => {
  if (!config.collections[req.params.collection]) return next();
  try {
    const collectionConfig = findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    validate(collectionConfig, data);
    const id = randomUUID();
    db.insertRecord({
      id,
      collection: req.params.collection,
      status,
      data,
      createdAt: db.now(),
      eventAction: req.body.action || '创建',
      actor: req.body.actor || '',
      note: req.body.note || ''
    });
    db.flush();
    res.status(201).json(db.getRecord(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  if (!config.collections[req.params.collection]) return next();
  try {
    const record = db.getRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(req.params.collection === 'tourSchedules' ? scheduleService.scheduleView(record) : record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', (req, res, next) => {
  if (!config.collections[req.params.collection]) return next();
  try {
    const record = db.getRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    db.updateRecord(req.params.collection, req.params.id, nextData, status);
    db.addEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || '更新',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    db.flush();
    res.json(db.getRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  if (!config.collections[req.params.collection]) return next();
  try {
    const collectionConfig = findCollection(req.params.collection);
    const record = db.getRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    db.updateRecord(req.params.collection, req.params.id, nextData, status);
    db.addEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || status || '记录',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    db.flush();
    res.json(db.getRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  if (!config.collections[req.params.collection]) return next();
  try {
    const record = db.getRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json({ record, events: db.getEvents(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  if (!config.collections[req.params.collection]) return next();
  try {
    if (req.params.collection === 'tourSchedules') {
      return res.status(405).json({ error: '档期不支持删除，使用闭环结束占用' });
    }
    db.deleteRecord(req.params.collection, req.params.id);
    db.flush();
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/* ---------------- 巡演档期专用入口（请求层：只做收参/幂等键/出参） ---------------- */

function idemKey(req, action, scheduleId) {
  const key = req.get('Idempotency-Key') || req.body.idempotencyKey;
  return key ? 'schedule:' + action + ':' + (scheduleId || 'new') + ':' + key : null;
}

function runHandler(res, next, promise) {
  promise
    .then((result) => res.status(result.status).json(result.body))
    .catch((error) => {
      if (error instanceof scheduleService.DomainError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.conflicts ? { conflicts: error.conflicts } : {}),
          ...(error.unavailable ? { unavailable: error.unavailable } : {}),
          ...(error.candidates ? { candidates: error.candidates } : {}),
          ...(error.busyDates ? { busyDates: error.busyDates } : {}),
          ...(error.slotConflicts ? { slotConflicts: error.slotConflicts } : {})
        });
      }
      next(error);
    });
}

// 创建档期草稿
app.post('/api/tourSchedules', (req, res, next) => {
  const rawKey = req.get('Idempotency-Key') || req.body.idempotencyKey;
  const key = rawKey ? 'schedule:create:' + rawKey : null;
  runHandler(res, next, scheduleService.withIdempotency(key, 'create', null, () =>
    scheduleService.createDraft(req.body, req.body.actor || '')
  ));
});

// 提交前预检：冲突与替换候选（不落锁）
app.get('/api/tourSchedules/:id/conflicts', (req, res, next) => {
  try {
    const result = scheduleService.preview(req.params.id);
    res.json(result.body);
  } catch (error) {
    next(error);
  }
});

// 提交锁场：按日期+箱位锁定偶头与配件
app.post('/api/tourSchedules/:id/submit', (req, res, next) => {
  runHandler(res, next, scheduleService.withIdempotency(
    idemKey(req, 'submit', req.params.id), 'submit', req.params.id,
    () => scheduleService.submit(req.params.id, req.body || {}, req.body.actor || '')
  ));
});

// 演出前更换任一角色/偶头：旧清单立即失效并按新件重算
app.post('/api/tourSchedules/:id/swap', (req, res, next) => {
  runHandler(res, next, scheduleService.withIdempotency(
    idemKey(req, 'swap', req.params.id), 'swap', req.params.id,
    () => scheduleService.swap(req.params.id, req.body || {}, req.body.actor || '')
  ));
});

// 状态推进（演出待开场由刷新自动派生，也可显式推进 巡演中）
app.post('/api/tourSchedules/:id/dispatch', (req, res, next) => {
  runHandler(res, next, scheduleService.withIdempotency(
    idemKey(req, 'dispatch', req.params.id), 'dispatch', req.params.id,
    () => scheduleService.transition(req.params.id, '巡演中', req.body.actor || '', req.body.note)
  ));
});

// 返场清点（可带缺损/遗失清单）；清点未闭环前锁不释放
app.post('/api/tourSchedules/:id/checkin', (req, res, next) => {
  runHandler(res, next, scheduleService.withIdempotency(
    idemKey(req, 'checkin', req.params.id), 'checkin', req.params.id,
    () => scheduleService.checkIn(req.params.id, req.body || {}, req.body.actor || '')
  ));
});

// 返场清点闭环：释放占用，相关偶头才能进入下一档期
app.post('/api/tourSchedules/:id/close', (req, res, next) => {
  runHandler(res, next, scheduleService.withIdempotency(
    idemKey(req, 'close', req.params.id), 'close', req.params.id,
    () => scheduleService.closeOut(req.params.id, req.body || {}, req.body.actor || '')
  ));
});

// 单场履历：清单版本 + 全部事件（提交/换角/清点/闭环）
app.get('/api/tourSchedules/:id/manifest', (req, res, next) => {
  try {
    const schedule = store.getSchedule(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'not found' });
    res.json({
      schedule: scheduleService.scheduleView(schedule),
      activeLocks: store.getActiveLocks(req.params.id),
      timeline: store.getTimeline(req.params.id).events
    });
  } catch (error) {
    next(error);
  }
});

/* ---------------- 占用查询入口：列表与单件状态同一判断来源 ---------------- */

function occupancyContext() {
  const activeLocks = store.getAllActiveLocks();
  const statusById = new Map(
    db.listRecords('tourSchedules').map((s) => [s.id, state.deriveStatus(s)])
  );
  return { activeLocks, statusById };
}

// 偶头/配件占用列表（支持 ?itemType=head&date=YYYY-MM-DD）
app.get('/api/occupancy/:itemType', (req, res, next) => {
  try {
    const itemType = req.params.itemType === 'head' ? 'puppetHeads'
      : req.params.itemType === 'accessory' ? 'accessories' : null;
    if (!itemType) return res.status(400).json({ error: 'itemType 需为 head 或 accessory' });
    const { activeLocks, statusById } = occupancyContext();
    let locks = activeLocks;
    if (req.query.date) locks = locks.filter((l) => l.showDate === req.query.date);
    const result = db.listRecords(itemType).map((record) => {
      const occ = state.itemOccupancy(record.id, locks, statusById);
      return {
        id: record.id,
        name: record.name || record.role,
        role: record.role,
        play: record.play,
        boxNo: record.boxNo,
        recordStatus: record.status,
        occupancy: occ.status,
        blockers: occ.blockers
      };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 单件当前占用状态 + 档期履历（刷新前后一致；未闭环时显示返场未闭环）
app.get('/api/occupancy/:itemType/:id', (req, res, next) => {
  try {
    const itemType = req.params.itemType === 'head' ? 'puppetHeads'
      : req.params.itemType === 'accessory' ? 'accessories' : null;
    if (!itemType) return res.status(400).json({ error: 'itemType 需为 head 或 accessory' });
    const record = db.getRecord(itemType, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const { activeLocks, statusById } = occupancyContext();
    res.json({
      item: record,
      occupancy: state.itemOccupancy(record.id, activeLocks, statusById),
      scheduleHistory: store.getItemLockHistory(req.params.id)
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message || 'server error' });
});

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
});
