const { randomUUID } = require('crypto');
const db = require('./db');

const COLLECTION = 'tourSchedules';

/**
 * 档期记录持久化层：只管 tourSchedules 记录、schedule_locks 锁行与幂等结果，
 * 不做任何状态/冲突判断（判断在 lib/scheduleState.js）。
 */

function createSchedule({ id, data, status, actor, note }) {
  const createdAt = db.now();
  db.insertRecord({
    id,
    collection: COLLECTION,
    status,
    data: { ...data, status },
    createdAt,
    eventAction: '创建档期',
    actor: actor || '',
    note: note || ''
  });
  return getSchedule(id);
}

function getSchedule(id) {
  return db.getRecord(COLLECTION, id);
}

function listSchedules() {
  return db.listRecords(COLLECTION);
}

function saveSchedule(id, data, status, event) {
  db.updateRecord(id, COLLECTION, { ...data, status }, status);
  if (event) {
    db.addEvent({
      recordId: id,
      collection: COLLECTION,
      action: event.action,
      status,
      actor: event.actor || '',
      note: event.note || '',
      data: event.data || {}
    });
  }
  return getSchedule(id);
}

function getTimeline(id) {
  const record = getSchedule(id);
  return { record, events: db.getEvents(id) };
}

/**
 * 写入一版新的锁清单：旧活动锁全部置为失效（保留历史），再按清单重新插入。
 * manifestVersion 每次提交/更换角色递增，旧场次清单随即失效。
 */
function replaceLocks(scheduleId, entries, manifestVersion, createdAt = db.now()) {
  db.run('UPDATE schedule_locks SET active = 0 WHERE schedule_id = ? AND active = 1;', [scheduleId]);
  for (const entry of entries) {
    db.run(
      `INSERT INTO schedule_locks
        (id, schedule_id, item_type, item_id, role, play, show_date, box_no, manifest_version, active, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,1,?);`,
      [
        randomUUID(),
        scheduleId,
        entry.itemType,
        entry.itemId,
        entry.role,
        entry.play,
        entry.showDate,
        entry.boxNo,
        manifestVersion,
        createdAt
      ]
    );
  }
}

/** 同件同日冲突：同一件偶头/配件不能在同一天进入别的档期（无论箱位）。 */
function findItemConflicts(itemIds, showDates, excludeScheduleId = null) {
  if (!itemIds.length || !showDates.length) return [];
  const itemPlaceholders = itemIds.map(() => '?').join(',');
  const datePlaceholders = showDates.map(() => '?').join(',');
  const params = [...itemIds, ...showDates];
  let sql =
    'SELECT item_id AS itemId, item_type AS itemType, show_date AS showDate, box_no AS boxNo, schedule_id AS scheduleId ' +
    'FROM schedule_locks WHERE active = 1 AND item_id IN (' + itemPlaceholders + ') ' +
    'AND show_date IN (' + datePlaceholders + ')';
  if (excludeScheduleId) {
    sql += ' AND schedule_id <> ?';
    params.push(excludeScheduleId);
  }
  return db.query(sql, params);
}

/** 同箱同档冲突：同一天同一个箱位只能放同一场演出的东西。 */
function findSlotConflicts(slots, excludeScheduleId = null) {
  if (!slots.length) return [];
  const conditions = [];
  const params = [];
  for (const slot of slots) {
    conditions.push('(show_date = ? AND box_no = ?)');
    params.push(slot.showDate, slot.boxNo);
  }
  let sql =
    'SELECT DISTINCT item_id AS itemId, item_type AS itemType, show_date AS showDate, box_no AS boxNo, schedule_id AS scheduleId ' +
    'FROM schedule_locks WHERE active = 1 AND (' + conditions.join(' OR ') + ')';
  if (excludeScheduleId) {
    sql += ' AND schedule_id <> ?';
    params.push(excludeScheduleId);
  }
  return db.query(sql, params);
}

function getActiveLocks(scheduleId) {
  return db.query(
    'SELECT item_type AS itemType, item_id AS itemId, role, play, show_date AS showDate, box_no AS boxNo, manifest_version AS manifestVersion ' +
    'FROM schedule_locks WHERE schedule_id = ? AND active = 1 ORDER BY show_date ASC, box_no ASC;',
    [scheduleId]
  );
}

function getAllActiveLocks() {
  return db.query(
    'SELECT schedule_id AS scheduleId, item_type AS itemType, item_id AS itemId, role, play, show_date AS showDate, box_no AS boxNo ' +
    'FROM schedule_locks WHERE active = 1 ORDER BY show_date ASC;'
  );
}

/** 未闭环档期持有的全部活动锁，用于判断偶头能否进入下一档期。 */
function locksBlockingItem(itemId) {
  return db.query(
    `SELECT l.schedule_id AS scheduleId, l.show_date AS showDate, l.box_no AS boxNo, r.status AS scheduleStatus
     FROM schedule_locks l
     JOIN records r ON r.id = l.schedule_id
     WHERE l.active = 1 AND l.item_id = ?
       AND r.status IN ('已锁档', '演出待开场', '巡演中', '返场清点中')
     ORDER BY l.show_date ASC;`,
    [itemId]
  );
}

/** 单件履历：偶头/配件被哪些档期锁过（含已失效的旧版清单）。 */
function getItemLockHistory(itemId) {
  return db.query(
    `SELECT l.schedule_id AS scheduleId, l.item_type AS itemType, l.role, l.play,
            l.show_date AS showDate, l.box_no AS boxNo, l.manifest_version AS manifestVersion,
            l.active, l.created_at AS lockedAt, r.status AS scheduleStatus,
            json_extract(r.data, '$.showName') AS showName,
            json_extract(r.data, '$.venue') AS venue
     FROM schedule_locks l
     JOIN records r ON r.id = l.schedule_id
     WHERE l.item_id = ?
     ORDER BY l.created_at ASC;`,
    [itemId]
  );
}

function getIdempotent(requestKey) {
  return db.getIdempotent(requestKey);
}

function saveIdempotent(requestKey, action, scheduleId, status, body) {
  db.putIdempotent(requestKey, action, scheduleId, status, body);
}

module.exports = {
  COLLECTION,
  createSchedule,
  getSchedule,
  listSchedules,
  saveSchedule,
  getTimeline,
  replaceLocks,
  findItemConflicts,
  findSlotConflicts,
  getActiveLocks,
  getAllActiveLocks,
  locksBlockingItem,
  getItemLockHistory,
  getIdempotent,
  saveIdempotent
};
