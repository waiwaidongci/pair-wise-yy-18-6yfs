'use strict';

// 持久化层：只负责 SQLite 读写、事务与落盘，不含任何档期业务规则。
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { randomUUID } = require('crypto');

const DATA_DIR = process.env.DB_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'app.db');

function now() {
  return new Date().toISOString();
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

async function createStore(config) {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file)
  });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let db;
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }

  function persist() {
    fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
  }

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  function get(sql, params = []) {
    return all(sql, params)[0] || null;
  }

  function run(sql, params) {
    // 无参数走 sqlite3_exec（支持多语句），有参数走 prepare
    if (params === undefined) db.run(sql);
    else db.run(sql, params);
  }

  // 同步事务：Node 单线程 + sql.js 同步执行，事务体内不会被其他请求插入。
  // error.commit = true 表示错误本身携带需要保留的业务结果（如冲突后旧清单失效），
  // 此时提交事务后继续把错误抛给调用方。
  function txn(work) {
    run('BEGIN IMMEDIATE');
    let result;
    try {
      result = work();
    } catch (error) {
      if (error && error.commit) {
        run('COMMIT');
        persist();
      } else {
        run('ROLLBACK');
      }
      throw error;
    }
    run('COMMIT');
    persist();
    return result;
  }

  // ---- 建表与种子 -------------------------------------------------------
  function init() {
    run(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);
CREATE TABLE IF NOT EXISTS tour_locks (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  box_no TEXT,
  role TEXT,
  entry_index INTEGER NOT NULL DEFAULT 0,
  manifest_version INTEGER NOT NULL DEFAULT 1,
  acquired_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_locks_schedule ON tour_locks(schedule_id);
DROP INDEX IF EXISTS idx_locks_active_item;
DROP INDEX IF EXISTS idx_locks_active_headbox;
CREATE INDEX IF NOT EXISTS idx_locks_item ON tour_locks(item_type, item_id, released_at);
-- 注意：同一偶头/箱位可被多个不重叠档期持有，互斥判定（含日期重叠与返场门禁）
-- 全部在 scheduleService 内完成，这里不能加唯一索引；并发安全由 BEGIN IMMEDIATE 保证。
CREATE TABLE IF NOT EXISTS lock_requests (
  idempotency_key TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  action TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

    const count = get('SELECT COUNT(*) AS count FROM records;').count;
    if (count > 0) return;
    for (const seed of config.seed || []) {
      const collectionConfig = config.collections[seed.collection];
      const id = seed.id || randomUUID();
      const createdAt = seed.createdAt || now();
      const status = seed.status || collectionConfig.defaultStatus || '';
      const data = { ...seed.data, status };
      run(
        'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?);',
        [id, seed.collection, status, titleFor(collectionConfig, data), JSON.stringify(data), createdAt, createdAt]
      );
      insertEvent({
        recordId: id,
        collection: seed.collection,
        action: seed.eventAction || '创建',
        status,
        actor: seed.actor || 'system',
        note: seed.note || '',
        data
      });
    }
    persist();
  }

  // ---- 通用记录 ---------------------------------------------------------
  function insertRecord({ id = randomUUID(), collection, status, data, createdAt = now() }) {
    const collectionConfig = config.collections[collection];
    run(
      'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?);',
      [id, collection, status, titleFor(collectionConfig, data), JSON.stringify(data), createdAt, createdAt]
    );
    return findRecord(collection, id);
  }

  function findRecord(collection, id) {
    const row = get('SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1;', [collection, id]);
    return row ? toRecord(row) : null;
  }

  function listRecords(collection) {
    return all('SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC;', [collection]).map(toRecord);
  }

  function updateRecord(collection, id, data, status = data.status) {
    const collectionConfig = config.collections[collection];
    run(
      'UPDATE records SET status = ?, title = ?, data = ?, updated_at = ? WHERE collection = ? AND id = ?;',
      [status, titleFor(collectionConfig, data), JSON.stringify(data), now(), collection, id]
    );
    return findRecord(collection, id);
  }

  function deleteRecord(collection, id) {
    run('DELETE FROM records WHERE collection = ? AND id = ?;', [collection, id]);
    run('DELETE FROM events WHERE record_id = ?;', [id]);
  }

  function insertEvent({ recordId, collection, action, status, actor, note, data }) {
    run(
      'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (?,?,?,?,?,?,?,?,?);',
      [randomUUID(), recordId, collection, action || '记录', status || '', actor || '', note || '', JSON.stringify(data || {}), now()]
    );
  }

  function listEvents(recordId) {
    return all('SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC, rowid ASC;', [recordId]).map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
  }

  // ---- 档期锁（只做存取，判定在 service） --------------------------------
  function insertLock({ id = randomUUID(), scheduleId, itemType, itemId, boxNo, role, entryIndex, manifestVersion, at = now() }) {
    run(
      'INSERT INTO tour_locks (id, schedule_id, item_type, item_id, box_no, role, entry_index, manifest_version, acquired_at, released_at) VALUES (?,?,?,?,?,?,?,?,?,NULL);',
      [id, scheduleId, itemType, itemId, boxNo || null, role || null, entryIndex, manifestVersion, at]
    );
  }

  // 活动锁 + 所属档期信息，是所有占用判断的唯一数据源
  function activeLocks() {
    return all(`
      SELECT l.id, l.schedule_id, l.item_type, l.item_id, l.box_no, l.role,
             l.entry_index, l.manifest_version, l.acquired_at,
             r.status AS schedule_status, r.data AS schedule_data
      FROM tour_locks l
      JOIN records r ON r.id = l.schedule_id AND r.collection = 'tourSchedules'
      WHERE l.released_at IS NULL
        AND r.status IN ('待替换', '已锁定', '巡演中', '返场清点中');
    `).map((row) => ({
      id: row.id,
      scheduleId: row.schedule_id,
      itemType: row.item_type,
      itemId: row.item_id,
      boxNo: row.box_no,
      role: row.role,
      entryIndex: row.entry_index,
      manifestVersion: row.manifest_version,
      acquiredAt: row.acquired_at,
      scheduleStatus: row.schedule_status,
      schedule: toRecord({ ...row, data: row.schedule_data })
    }));
  }

  function locksForSchedule(scheduleId) {
    return all('SELECT * FROM tour_locks WHERE schedule_id = ? ORDER BY manifest_version, entry_index;', [scheduleId]);
  }

  function releaseLocks(scheduleId, at = now()) {
    run('UPDATE tour_locks SET released_at = ? WHERE schedule_id = ? AND released_at IS NULL;', [at, scheduleId]);
  }

  // ---- 幂等请求记录 ------------------------------------------------------
  function findLockRequest(key) {
    const row = get('SELECT * FROM lock_requests WHERE idempotency_key = ?;', [key]);
    if (!row) return null;
    return {
      idempotencyKey: row.idempotency_key,
      scheduleId: row.schedule_id,
      action: row.action,
      fingerprint: row.fingerprint,
      statusCode: row.status_code,
      response: JSON.parse(row.response),
      createdAt: row.created_at
    };
  }

  function putLockRequest({ key, scheduleId, action, fingerprint, statusCode, response, at = now() }) {
    run(
      'INSERT INTO lock_requests (idempotency_key, schedule_id, action, fingerprint, status_code, response, created_at) VALUES (?,?,?,?,?,?,?);',
      [key, scheduleId, action, fingerprint, statusCode, JSON.stringify(response), at]
    );
  }

  init();

  return {
    dbFile: DB_FILE,
    all,
    get,
    run,
    txn,
    insertRecord,
    findRecord,
    listRecords,
    updateRecord,
    deleteRecord,
    insertEvent,
    listEvents,
    insertLock,
    activeLocks,
    locksForSchedule,
    releaseLocks,
    findLockRequest,
    putLockRequest
  };
}

module.exports = { createStore, now };
