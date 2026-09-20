/**
 * 档期状态判断层：纯函数。输入档案快照与锁快照，输出可占用状态、冲突、替换候选。
 * 不读取数据库、不感知 HTTP，便于复用与测试。
 */

const SCHEDULE_STATUSES = ['草稿', '已锁档', '演出待开场', '巡演中', '返场清点中', '已闭环'];

// 锁会持续到返场清点闭环：只有已闭环/草稿（提交失败不留锁）不挡下一档
const LOCKING_SCHEDULE_STATUSES = ['已锁档', '演出待开场', '巡演中', '返场清点中'];

// 允许的状态流转（演出待开场是已锁档的自动派生态，二者都可出发巡演）
const TRANSITIONS = {
  草稿: ['已锁档'],
  已锁档: ['演出待开场', '巡演中'],
  演出待开场: ['巡演中', '已锁档'],
  巡演中: ['返场清点中'],
  返场清点中: ['已闭环'],
  已闭环: []
};

const HEAD_USABLE_STATUS = '可演出';
const ACCESSORY_USABLE_STATUS = '在库';

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

function datesOf(scheduleData) {
  return (scheduleData.showDates || []).slice().sort();
}

function todayDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** 已过首个演出日且尚未出发 => 演出待开场（刷新后自动推进） */
function deriveStatus(schedule, now = new Date()) {
  const base = schedule.status || '草稿';
  if (base !== '已锁档') return base;
  const dates = datesOf(schedule);
  if (dates.length && dates[0] <= todayDate(now)) return '演出待开场';
  return base;
}

function unique(list) {
  return [...new Set(list)];
}

function isUsableHead(head) {
  return !!head && head.status === HEAD_USABLE_STATUS && head.currentUsable !== false;
}

function isUsableAccessory(accessory) {
  return !!accessory && accessory.status === ACCESSORY_USABLE_STATUS;
}

/**
 * 占用情况：把全部活动锁拍平成 Map，供下面各查询共用，
 * 保证列表视图、单场履历、刷新后状态出自同一份快照。
 */
function buildLockIndex(activeLocks) {
  const byItemDate = new Map();   // itemId + '|' + date -> lock
  const byDateBox = new Map();    // date + '|' + boxNo -> [lock]
  for (const lock of activeLocks) {
    byItemDate.set(lock.itemId + '|' + lock.showDate, lock);
    const key = lock.showDate + '|' + lock.boxNo;
    if (!byDateBox.has(key)) byDateBox.set(key, []);
    byDateBox.get(key).push(lock);
  }
  return { byItemDate, byDateBox };
}

/**
 * 评估一个档期的拟锁清单。
 * @param {object} ctx
 *   heads: Map<id, headRecord>, accessories: Map<id, accessoryRecord>
 *   activeLocks: 当前所有活动锁（含本档期旧版清单）
 *   scheduleId: 本档期 id（草稿首次提交时为 null）
 * @returns {conflicts, unavailable, candidates, entries}
 *   conflicts   硬冲突：同件同日 / 同箱同档被别的档期占用
 *   unavailable 缺件、待修等不可用项
 *   candidates  每个不可用项的替换候选（只在提交/预检此刻计算）
 *   entries     最终可锁清单（已应用候选替换）
 */
function planLocks(scheduleData, ctx) {
  const { heads, accessories, activeLocks, scheduleId } = ctx;
  const dates = datesOf(scheduleData);
  const desiredBox = scheduleData.boxNo || null;
  const index = buildLockIndex(activeLocks.filter((l) => l.scheduleId !== scheduleId));

  const wanted = [];
  for (const headId of scheduleData.headIds || []) {
    wanted.push({ itemType: 'head', itemId: headId });
  }
  for (const accessoryId of scheduleData.accessoryIds || []) {
    wanted.push({ itemType: 'accessory', itemId: accessoryId });
  }

  const conflicts = [];
  const unavailable = [];
  const candidates = [];
  const chosen = new Map(); // 原始 itemId -> 替换后的记录

  for (const item of wanted) {
    const record = item.itemType === 'head' ? heads.get(item.itemId) : accessories.get(item.itemId);
    const usable = item.itemType === 'head' ? isUsableHead(record) : isUsableAccessory(record);
    if (!record) {
      unavailable.push({ ...item, reason: '缺件', detail: '档案不存在' });
      continue;
    }
    if (!usable) {
      unavailable.push({
        ...item,
        reason: item.itemType === 'head' ? '待修或不可演出' : '配件不在库',
        detail: record.status
      });
    }

    // 同件同日：别的档期已占
    for (const date of dates) {
      const other = index.byItemDate.get(item.itemId + '|' + date);
      if (other) {
        conflicts.push({
          ...item,
          showDate: date,
          reason: '同件同日已被占用',
          boxNo: other.boxNo,
          otherScheduleId: other.scheduleId
        });
      }
    }

    if (!usable) {
      const boxNo = desiredBox || (record && record.boxNo) || '';
      const replacement = pickCandidate({
        itemType: item.itemType,
        role: record && record.role,
        play: scheduleData.play || (record && record.play),
        boxNo,
        dates,
        heads,
        accessories,
        index,
        exclude: new Set()
      });
      candidates.push({
        itemType: item.itemType,
        itemId: item.itemId,
        name: record ? (record.name || record.role) : item.itemId,
        reason: record ? record.status : '缺件',
        replacement
      });
    }
  }

  // 同箱同档：本档期每个 (日期, 箱位) 上若已有别的档期的锁
  const slots = unique(dates.map((d) => d + '|' + (desiredBox || '')));
  for (const key of slots) {
    const [date, boxNo] = key.split('|');
    if (!boxNo) continue;
    const occupants = index.byDateBox.get(date + '|' + boxNo) || [];
    for (const other of occupants) {
      conflicts.push({
        itemType: other.itemType,
        itemId: other.itemId,
        showDate: date,
        boxNo,
        reason: '同箱同档已被占用',
        otherScheduleId: other.scheduleId
      });
    }
  }

  // 生成最终锁清单：可用件用原件，不可用且有候选的按“确认替换”名单替换
  const confirmed = new Map();
  for (const c of scheduleData.confirmedReplacements || []) {
    confirmed.set(c.itemType + '|' + c.itemId, c.replacementId);
  }
  const entries = [];
  for (const item of wanted) {
    const record = item.itemType === 'head' ? heads.get(item.itemId) : accessories.get(item.itemId);
    const usable = item.itemType === 'head' ? isUsableHead(record) : isUsableAccessory(record);
    let lockRecord = record;
    let lockId = item.itemId;
    const replacementId = confirmed.get(item.itemType + '|' + item.itemId);
    if (replacementId) {
      const alt = item.itemType === 'head' ? heads.get(replacementId) : accessories.get(replacementId);
      if (alt) {
        lockRecord = alt;
        lockId = replacementId;
      }
    }
    if (!usable && !replacementId) continue; // 未确认替换的不可用件不进锁清单
    if (!lockRecord) continue;
    const boxNo = desiredBox || lockRecord.boxNo;
    for (const date of dates) {
      if (index.byItemDate.get(lockId + '|' + date)) continue; // 硬冲突，跳过
      entries.push({
        itemType: item.itemType,
        itemId: lockId,
        role: lockRecord.role || '',
        play: lockRecord.play || scheduleData.play || '',
        showDate: date,
        boxNo
      });
    }
  }
  // 同档期同件同箱重复去重
  const dedup = new Map();
  for (const e of entries) {
    dedup.set([e.itemType, e.itemId, e.showDate, e.boxNo].join('|'), e);
  }

  return {
    conflicts,
    unavailable,
    candidates,
    entries: [...dedup.values()]
  };
}

/**
 * 找替换候选：同剧目、同角色、状态可用、且在所有演出日期都没被别的档期锁。
 * 缺件（档案不存在）时按提交档期的 play 与请求里给的 role 匹配。
 */
function pickCandidate({ itemType, role, play, boxNo, dates, heads, accessories, index, exclude }) {
  const pool = itemType === 'head' ? [...heads.values()] : [...accessories.values()];
  for (const record of pool) {
    if (exclude && exclude.has(record.id)) continue;
    if (itemType === 'head' ? !isUsableHead(record) : !isUsableAccessory(record)) continue;
    if (role && record.role !== role) continue;
    if (play && record.play !== play) continue;
    const busy = dates.some((d) => index.byItemDate.has(record.id + '|' + d));
    if (busy) continue;
    return {
      itemType,
      replacementId: record.id,
      name: record.name || record.role,
      role: record.role,
      play: record.play,
      boxNo: boxNo || record.boxNo,
      status: record.status
    };
  }
  return null;
}

/**
 * 单件占用状态（列表 / 刷新 / 履历共用同一判断）。
 * 返回 { status, blockers }：
 *   可演出 / 在库：未被任何未闭环档期占用
 *   返场未闭环：被“返场清点中”的档期占用，不得进入下一档期
 *   档期占用：被其余锁定档期占用
 */
function itemOccupancy(itemId, activeLocks, scheduleStatusById) {
  const blockers = activeLocks
    .filter((l) => l.itemId === itemId && LOCKING_SCHEDULE_STATUSES.includes(scheduleStatusById.get(l.scheduleId)))
    .map((l) => ({
      scheduleId: l.scheduleId,
      scheduleStatus: scheduleStatusById.get(l.scheduleId),
      showDate: l.showDate,
      boxNo: l.boxNo
    }));
  if (!blockers.length) return { status: '空闲', blockers: [] };
  if (blockers.some((b) => b.scheduleStatus === '返场清点中')) {
    return { status: '返场未闭环', blockers };
  }
  return { status: '档期占用', blockers };
}

module.exports = {
  SCHEDULE_STATUSES,
  LOCKING_SCHEDULE_STATUSES,
  HEAD_USABLE_STATUS,
  ACCESSORY_USABLE_STATUS,
  canTransition,
  deriveStatus,
  datesOf,
  todayDate,
  isUsableHead,
  isUsableAccessory,
  buildLockIndex,
  planLocks,
  pickCandidate,
  itemOccupancy
};
