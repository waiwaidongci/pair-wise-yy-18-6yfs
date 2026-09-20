'use strict';

// 请求入口层：只管 HTTP 入参、幂等键、响应码；所有状态判断委托 scheduleService，
// 所有写操作包在 store.txn 内一次落盘。
const express = require('express');
const { randomUUID, createHash } = require('crypto');
const service = require('../lib/scheduleService');

function router(store) {
  const router = express.Router();
  const SCHEDULE = service.SCHEDULE;

  function scheduleError(res, error) {
    const body = { error: error.message, code: error.code || 'ERROR' };
    for (const key of ['conflicts', 'schedule', 'openLossReports', 'scheduleStatus']) {
      if (error[key] !== undefined) body[key] = error[key];
    }
    res.status(error.status || 500).json(body);
  }

  // 重复或并发锁场沿用首次结果：同幂等键直接回放，键相同但请求体不同则拒绝
  function idempotencyKey(req, scheduleId, action) {
    const explicit = req.get('Idempotency-Key') || req.get('X-Idempotency-Key') || req.body.requestId;
    if (explicit) return 'k:' + action + ':' + explicit;
    const fingerprintBase = JSON.stringify({
      scheduleId,
      action,
      body: { ...req.body, actor: undefined, note: undefined }
    });
    return 'd:' + action + ':' + scheduleId + ':' + createHash('sha1').update(fingerprintBase).digest('hex');
  }

  function replayOrRun(req, res, scheduleId, action, run) {
    const key = idempotencyKey(req, scheduleId, action);
    const fingerprint = createHash('sha1').update(JSON.stringify(req.body || {})).digest('hex');
    const previous = store.findLockRequest(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return res.status(409).json({
          error: '同一请求键的内容与首次请求不一致',
          code: 'IDEMPOTENCY_MISMATCH',
          firstAction: previous.action
        });
      }
      return res.status(previous.statusCode).json(previous.response);
    }
    try {
      const outcome = store.txn(() => {
        // BEGIN IMMEDIATE 后再查一次，挡住并发重复请求
        const concurrent = store.findLockRequest(key);
        if (concurrent) return { replay: concurrent };
        const result = run();
        return { replay: null, result };
      });
      if (outcome.replay) {
        return res.status(outcome.replay.statusCode).json(outcome.replay.response);
      }
      const { statusCode, response } = outcome.result;
      store.txn(() => store.putLockRequest({ key, scheduleId, action, fingerprint, statusCode, response }));
      res.status(statusCode).json(response);
    } catch (error) {
      if (error && error.commit) {
        // 业务结果已随事务提交（如更换角色冲突后旧清单失效），登记幂等键后回放同一 4xx
        const statusCode = error.status || 409;
        const response = { error: error.message, code: error.code };
        for (const k of ['conflicts', 'schedule', 'openLossReports', 'scheduleStatus']) {
          if (error[k] !== undefined) response[k] = error[k];
        }
        try {
          store.txn(() => store.putLockRequest({ key, scheduleId, action, fingerprint, statusCode, response }));
        } catch { /* 并发下另一请求已登记，下面的键查询会命中 */ }
        const winner = store.findLockRequest(key);
        if (winner) return res.status(winner.statusCode).json(winner.response);
        return res.status(statusCode).json(response);
      }
      return scheduleError(res, error);
    }
  }

  // 创建档期草稿（也可 autoSubmit 直接锁场，走同一套判定）
  router.post('/', (req, res, next) => {
    try {
      const body = req.body || {};
      for (const field of ['showName', 'venue', 'play', 'startDate', 'endDate']) {
        if (!body[field]) return res.status(400).json({ error: 'missing required field: ' + field, code: 'MISSING_FIELD' });
      }
      service.validateDates(body.startDate, body.endDate);
      const normalized = service.normalizeEntries(store, body.play, body);
      const id = body.id || randomUUID();
      const createdAt = new Date().toISOString();
      const status = service.STATUS.DRAFT;
      const data = {
        showName: body.showName,
        venue: body.venue,
        play: body.play,
        startDate: body.startDate,
        endDate: body.endDate,
        headEntries: normalized.headEntries,
        accessoryEntries: normalized.accessoryEntries,
        manifestVersion: 0,
        lockedAtVersion: null,
        replaceable: [],
        status,
        remark: body.remark || ''
      };
      const schedule = store.txn(() => {
        const created = store.insertRecord({ id, collection: SCHEDULE, status, data, createdAt });
        store.insertEvent({
          recordId: id,
          collection: SCHEDULE,
          action: '创建档期草稿',
          status,
          actor: body.actor || '',
          note: body.note || '',
          data
        });
        return created;
      });
      if (body.autoSubmit) {
        return replayOrRun(req, res, id, 'submit', () => {
          const result = service.submit(store, id, body);
          return { statusCode: 201, response: { ...result, created: true } };
        });
      }
      res.status(201).json(schedule);
    } catch (error) {
      next(error);
    }
  });

  router.get('/', (req, res) => {
    let list = store.listRecords(SCHEDULE);
    const { status, play, startBefore, startAfter } = req.query;
    if (status) list = list.filter((s) => s.status === status);
    if (play) list = list.filter((s) => s.play === play);
    if (startBefore) list = list.filter((s) => s.startDate <= startBefore);
    if (startAfter) list = list.filter((s) => s.startDate >= startAfter);
    res.json(list);
  });

  router.get('/:id', (req, res) => {
    try {
      res.json(service.loadSchedule(store, req.params.id));
    } catch (error) {
      scheduleError(res, error);
    }
  });

  router.get('/:id/manifest', (req, res) => {
    try {
      res.json(service.scheduleManifest(store, req.params.id));
    } catch (error) {
      scheduleError(res, error);
    }
  });

  // 提交锁场
  router.post('/:id/submit', (req, res) => {
    replayOrRun(req, res, req.params.id, 'submit', () => {
      const result = service.submit(store, req.params.id, req.body || {});
      return { statusCode: 200, response: result };
    });
  });

  // 演出前更换角色：旧清单立即失效并按新件重算
  router.post('/:id/reassign', (req, res) => {
    replayOrRun(req, res, req.params.id, 'reassign', () => {
      const body = req.body || {};
      const current = service.loadSchedule(store, req.params.id);
      // 支持只换某个角色位，也支持整份清单替换
      if (!body.headEntries && !body.accessoryEntries && !body.accessoryIds && !body.headIds) {
        const headEntries = (current.headEntries || []).map((e) => ({ ...e }));
        if (body.entryIndex !== undefined && headEntries[body.entryIndex]) {
          headEntries[body.entryIndex] = {
            ...headEntries[body.entryIndex],
            headId: body.headId || null,
            role: body.role || headEntries[body.entryIndex].role,
            boxNo: body.boxNo || headEntries[body.entryIndex].boxNo
          };
        }
        return {
          statusCode: 200,
          response: service.submit(store, req.params.id, { ...body, headEntries }, { reassign: true })
        };
      }
      return {
        statusCode: 200,
        response: service.submit(store, req.params.id, body, { reassign: true })
      };
    });
  });

  router.post('/:id/depart', (req, res) => {
    try {
      const result = store.txn(() => service.depart(store, req.params.id, req.body || {}));
      res.json(result);
    } catch (error) {
      scheduleError(res, error);
    }
  });

  router.post('/:id/returnCheck', (req, res) => {
    try {
      const result = store.txn(() => service.returnCheck(store, req.params.id, req.body || {}));
      res.json(result);
    } catch (error) {
      scheduleError(res, error);
    }
  });

  router.post('/:id/close', (req, res) => {
    try {
      const result = store.txn(() => service.close(store, req.params.id, req.body || {}));
      res.json(result);
    } catch (error) {
      scheduleError(res, error);
    }
  });

  router.post('/:id/cancel', (req, res) => {
    try {
      const result = store.txn(() => service.cancel(store, req.params.id, req.body || {}));
      res.json(result);
    } catch (error) {
      scheduleError(res, error);
    }
  });

  return router;
}

module.exports = router;
