const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const config = require('../project.config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

let db = null;

function now() {
  return new Date().toISOString();
}

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let buffer = null;
  if (fs.existsSync(DB_FILE)) buffer = fs.readFileSync(DB_FILE);
  return initSqlJs().then((SQL) => {
    db = new SQL.Database(buffer);
    db.run('PRAGMA foreign_keys = ON;');
    db.run(`
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
CREATE INDEX IF NOT EXISTS idx_events_collection ON events(collection, created_at);
`);
    db.run(`
CREATE TABLE IF NOT EXISTS schedule_locks (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('head', 'accessory')),
  item_id TEXT NOT NULL,
  role TEXT NOT NULL,
  play TEXT NOT NULL,
  show_date TEXT NOT NULL,
  box_no TEXT NOT NULL,
  manifest_version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_locks_item ON schedule_locks(item_id, active);
CREATE INDEX IF NOT EXISTS idx_locks_schedule ON schedule_locks(schedule_id, active);
CREATE INDEX IF NOT EXISTS idx_locks_slot ON schedule_locks(show_date, box_no, active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_locks_active_item_date
  ON schedule_locks(item_id, show_date) WHERE active = 1;
CREATE TABLE IF NOT EXISTS schedule_idempotency (
  request_key TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  schedule_id TEXT,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);
    seedIfEmpty();
    persist();
  });
}

function persist() {
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function seedIfEmpty() {
  const countRow = db.exec('SELECT COUNT(*) AS c FROM records;')[0];
  const count = countRow ? countRow.values[0][0] : 0;
  if (count > 0) return;
  for (const seed of config.seed || []) {
    insertRecord({
      id: seed.id,
      collection: seed.collection,
      status: seed.status || (config.collections[seed.collection] || {}).defaultStatus || '',
      data: { ...seed.data, status: seed.status },
      createdAt: seed.createdAt || now(),
      eventAction: seed.eventAction || '创建',
      actor: seed.actor || 'system',
      note: seed.note || ''
    });
  }
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    stmt.step();
  } finally {
    stmt.free();
  }
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

function queryOne(sql, params = []) {
  return query(sql, params)[0] || null;
}

/**
 * 在单个即时事务内执行 fn。fn 抛错则回滚；提交冲突（SQLITE_BUSY）由调用方按
 * “并发沿用首次结果”的幂等键处理，不在此静默重试。
 */
function transaction(fn) {
  db.run('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.run('COMMIT;');
    persist();
    return result;
  } catch (error) {
    db.run('ROLLBACK;');
    throw error;
  }
}

/** 事务外写入后手动落盘（如回滚后仍需保留的幂等首次结果） */
function flush() {
  persist();
}

function insertRecord({ id, collection, status, data, createdAt, eventAction, actor, note }) {
  const collectionConfig = config.collections[collection] || {};
  const title = (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
  run(
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?);',
    [id, collection, status, title, JSON.stringify(data), createdAt, createdAt]
  );
  addEvent({
    recordId: id,
    collection,
    action: eventAction || '创建',
    status,
    actor: actor || '',
    note: note || '',
    data
  });
}

function updateRecord(id, collection, data, status) {
  const collectionConfig = config.collections[collection] || {};
  const title = (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
  run(
    'UPDATE records SET status = ?, title = ?, data = ?, updated_at = ? WHERE id = ? AND collection = ?;',
    [status, title, JSON.stringify(data), now(), id, collection]
  );
}

function addEvent({ recordId, collection, action, status, actor, note, data }) {
  run(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (?,?,?,?,?,?,?,?,?);',
    [
      require('crypto').randomUUID(),
      recordId,
      collection,
      action || '记录',
      status || '',
      actor || '',
      note || '',
      JSON.stringify(data || {}),
      now()
    ]
  );
}

function toRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...JSON.parse(row.data || '{}')
  };
}

function getRecord(collection, id) {
  return toRecord(
    queryOne('SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1;', [collection, id])
  );
}

function listRecords(collection) {
  return query(
    'SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC;',
    [collection]
  ).map(toRecord);
}

function getEvents(recordId) {
  return query('SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC;', [recordId])
    .map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
}

function deleteRecord(collection, id) {
  run('DELETE FROM records WHERE collection = ? AND id = ?;', [collection, id]);
  run('DELETE FROM events WHERE record_id = ?;', [id]);
}

function getIdempotent(requestKey) {
  const row = queryOne(
    'SELECT response_status AS status, response_body AS body FROM schedule_idempotency WHERE request_key = ?;',
    [requestKey]
  );
  if (!row) return null;
  return { status: row.status, body: JSON.parse(row.body), replayed: true };
}

function putIdempotent(requestKey, action, scheduleId, status, body) {
  run(
    'INSERT OR IGNORE INTO schedule_idempotency (request_key, action, schedule_id, response_status, response_body, created_at) VALUES (?,?,?,?,?,?);',
    [requestKey, action, scheduleId || null, status, JSON.stringify(body), now()]
  );
}

module.exports = {
  init,
  now,
  run,
  query,
  queryOne,
  transaction,
  flush,
  insertRecord,
  updateRecord,
  addEvent,
  getRecord,
  listRecords,
  getEvents,
  deleteRecord,
  getIdempotent,
  putIdempotent
};
