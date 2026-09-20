const express = require('express');
const config = require('./project.config');
const { createStore, now } = require('./lib/db');
const service = require('./lib/scheduleService');
const tourScheduleRouter = require('./routes/tourSchedules');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function findCollection(store, name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter((field) => data[field] === undefined || data[field] === '');
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

async function main() {
  const store = await createStore(config);

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

  // 请求入口（档期闭环专项路由）：必须挂在通用集合路由之前
  app.use('/api/tourSchedules', tourScheduleRouter(store));

  // 偶头/配件档期占用查询：列表、单场履历与刷新后状态都以 tour_locks 为唯一数据源
  app.get('/api/puppetHeads/:id/occupancy', (req, res, next) => {
    try {
      res.json(service.itemOccupancy(store, service.HEAD, req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/accessories/:id/occupancy', (req, res, next) => {
    try {
      res.json(service.itemOccupancy(store, service.ACCESSORY, req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/:collection', (req, res, next) => {
    try {
      findCollection(store, req.params.collection);
      const filtered = applyQuery(store.listRecords(req.params.collection), req.query);
      const limit = Number(req.query.limit || 0);
      res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/:collection', (req, res, next) => {
    try {
      const collectionConfig = findCollection(store, req.params.collection);
      if (req.params.collection === service.SCHEDULE) {
        return res.status(405).json({
          error: '巡演档期请使用 /api/tourSchedules 专项入口',
          code: 'USE_DEDICATED_ROUTER'
        });
      }
      const data = { ...collectionConfig.defaults, ...req.body };
      const status = data.status || collectionConfig.defaultStatus || '';
      data.status = status;
      validate(collectionConfig, data);
      const record = store.txn(() => {
        const created = store.insertRecord({ collection: req.params.collection, status, data });
        store.insertEvent({
          recordId: created.id,
          collection: req.params.collection,
          action: req.body.action || '创建',
          status,
          actor: req.body.actor || '',
          note: req.body.note || '',
          data
        });
        return store.findRecord(req.params.collection, created.id);
      });
      res.status(201).json(record);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/:collection/:id', (req, res, next) => {
    try {
      findCollection(store, req.params.collection);
      const record = store.findRecord(req.params.collection, req.params.id);
      if (!record) return res.status(404).json({ error: 'not found' });
      res.json(record);
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/:collection/:id', (req, res, next) => {
    try {
      findCollection(store, req.params.collection);
      if (req.params.collection === service.SCHEDULE) {
        return res.status(405).json({
          error: '巡演档期状态流转必须使用专项入口（submit/reassign/depart/returnCheck/close/cancel）',
          code: 'USE_DEDICATED_ROUTER'
        });
      }
      const record = store.findRecord(req.params.collection, req.params.id);
      if (!record) return res.status(404).json({ error: 'not found' });
      const nextData = { ...record, ...req.body };
      delete nextData.id;
      delete nextData.collection;
      delete nextData.createdAt;
      delete nextData.updatedAt;
      const status = nextData.status || record.status;
      nextData.status = status;
      const updated = store.txn(() => {
        store.updateRecord(req.params.collection, req.params.id, nextData, status);
        store.insertEvent({
          recordId: req.params.id,
          collection: req.params.collection,
          action: req.body.action || '更新',
          status,
          actor: req.body.actor || '',
          note: req.body.note || '',
          data: req.body
        });
        return store.findRecord(req.params.collection, req.params.id);
      });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/:collection/:id/events', (req, res, next) => {
    try {
      const collectionConfig = findCollection(store, req.params.collection);
      if (req.params.collection === service.SCHEDULE) {
        return res.status(405).json({
          error: '巡演档期履历由专项操作自动记录',
          code: 'USE_DEDICATED_ROUTER'
        });
      }
      const record = store.findRecord(req.params.collection, req.params.id);
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
      const updated = store.txn(() => {
        store.updateRecord(req.params.collection, req.params.id, nextData, status);
        store.insertEvent({
          recordId: req.params.id,
          collection: req.params.collection,
          action: req.body.action || status || '记录',
          status,
          actor: req.body.actor || '',
          note: req.body.note || '',
          data: req.body
        });
        return store.findRecord(req.params.collection, req.params.id);
      });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/:collection/:id/timeline', (req, res, next) => {
    try {
      findCollection(store, req.params.collection);
      const record = store.findRecord(req.params.collection, req.params.id);
      if (!record) return res.status(404).json({ error: 'not found' });
      res.json({ record, events: store.listEvents(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/:collection/:id', (req, res, next) => {
    try {
      findCollection(store, req.params.collection);
      if (req.params.collection === service.SCHEDULE) {
        return res.status(405).json({
          error: '巡演档期不能直接删除，请使用 cancel；闭环记录需保留用于履历',
          code: 'USE_DEDICATED_ROUTER'
        });
      }
      store.txn(() => store.deleteRecord(req.params.collection, req.params.id));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({ error: error.message || 'server error', code: error.code });
  });

  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
    console.log('database: ' + store.dbFile);
  });
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

module.exports = { app, sqlValue, now };
