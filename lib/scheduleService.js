const { randomUUID } = require('crypto');
const db = require('./db');
const store = require('./scheduleStore');
const state = require('./scheduleState');

/**
 * 档期服务层：编排“档案快照 → 状态判断 → 锁/记录持久化”。
 * 写操作经单进程互斥链串行化；同一 requestKey 的重复/并发请求直接沿用首次结果。
 */

let chain = Promise.resolve();

function serialize(task) {
  const run = chain.then(task, task);
  // 不让单次失败中断后续任务链
  chain = run.catch(() => {});
  return run;
}

class DomainError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

function loadMaps() {
  const heads = new Map(db.listRecords('puppetHeads').map((r) => [r.id, r]));
  const accessories = new Map(db.listRecords('accessories').map((r) => [r.id, r]));
  return { heads, accessories };
}

function assertSchedule(id) {
  const schedule = store.getSchedule(id);
  if (!schedule) throw new DomainError(404, 'NOT_FOUND', '档期不存在');
  return schedule;
}

function scheduleView(schedule) {
  const fresh = state.deriveStatus(schedule);
  return { ...schedule, status: fresh, manifestVersion: schedule.manifestVersion || 1 };
}

/**
 * 幂等包装：
 *  - 首次请求：在互斥链 + 事务内执行，结果（含错误体）落 schedule_idempotency
 *  - 重复/并发请求：不重算，原样返回首次的状态码与响应体
 */
function withIdempotency(requestKey, action, scheduleId, task) {
  return serialize(() => {
    if (requestKey) {
      const hit = store.getIdempotent(requestKey);
      if (hit) return hit;
    }
    let result;
    try {
      result = db.transaction(() => task());
    } catch (error) {
      if (error instanceof DomainError && requestKey) {
        // 事务已回滚；在事务外把首次错误结果持久化，后续重复请求沿用
        store.saveIdempotent(requestKey, action, scheduleId, error.status, {
          error: error.message,
          code: error.code,
          ...(error.conflicts ? { conflicts: error.conflicts } : {}),
          ...(error.unavailable ? { unavailable: error.unavailable } : {}),
          ...(error.candidates ? { candidates: error.candidates } : {}),
          ...(error.busyDates ? { busyDates: error.busyDates } : {})
        });
        db.flush();
      }
      throw error;
    }
    if (requestKey) {
      store.saveIdempotent(requestKey, action, scheduleId, result.status, result.body);
    }
    return result;
  });
}

/* ---------------- 草稿 ---------------- */

function createDraft(body, actor) {
  const required = ['showName', 'venue', 'play', 'showDates', 'boxNo'];
  const missing = required.filter((f) => !body[f] || (Array.isArray(body[f]) && !body[f].length));
  if (missing.length) throw new DomainError(400, 'VALIDATION_ERROR', '缺少必填字段: ' + missing.join(', '));
  const showDates = state.datesOf(body);
  if (showDates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
    throw new DomainError(400, 'VALIDATION_ERROR', 'showDates 需为 YYYY-MM-DD');
  }
  const id = randomUUID();
  const data = {
    showName: body.showName,
    venue: body.venue,
    play: body.play,
    showDates,
    boxNo: body.boxNo,
    headIds: body.headIds || [],
    accessoryIds: body.accessoryIds || [],
    roleAssignments: body.roleAssignments || [],
    confirmedReplacements: [],
    replacementHistory: [],
    lockHistory: [],
    manifestVersion: 0,
    note: body.note || ''
  };
  const created = store.createSchedule({ id, data, status: '草稿', actor, note: body.note || '' });
  return { status: 201, body: scheduleView(created) };
}

/* ---------------- 预检：只算冲突与替换候选，不落锁 ---------------- */

function preview(id) {
  const schedule = assertSchedule(id);
  const { heads, accessories } = loadMaps();
  const plan = state.planLocks(schedule, {
    heads,
    accessories,
    activeLocks: store.getAllActiveLocks(),
    scheduleId: id
  });
  return {
    status: 200,
    body: {
      scheduleId: id,
      status: scheduleView(schedule).status,
      conflicts: plan.conflicts,
      unavailable: plan.unavailable,
      candidates: plan.candidates,
      lockable: plan.conflicts.length === 0 &&
        plan.unavailable.every((u) =>
          plan.candidates.some((c) => c.itemType === u.itemType && c.itemId === u.itemId && c.replacement) &&
          (schedule.confirmedReplacements || []).some(
            (r) => r.itemType === u.itemType && r.itemId === u.itemId
          )
        )
    }
  };
}

/* ---------------- 提交锁场 ---------------- */

function submit(id, body = {}, actor) {
  const schedule = assertSchedule(id);
  if (schedule.status !== '草稿') {
    throw new DomainError(409, 'NOT_DRAFT', '只有草稿档期可以提交锁场，当前状态: ' + schedule.status);
  }
  // 允许提交时带上确认的替换候选
  const mergedData = {
    ...schedule,
    headIds: body.headIds || schedule.headIds,
    accessoryIds: body.accessoryIds || schedule.accessoryIds,
    confirmedReplacements: body.confirmedReplacements || schedule.confirmedReplacements || []
  };

  const { heads, accessories } = loadMaps();
  const plan = state.planLocks(mergedData, {
    heads,
    accessories,
    activeLocks: store.getAllActiveLocks(),
    scheduleId: id
  });

  if (plan.conflicts.length) {
    throw new DomainError(409, 'SCHEDULE_CONFLICT', '档期重叠，无法锁定', { conflicts: plan.conflicts });
  }

  const unresolved = plan.unavailable.filter(
    (u) => !mergedData.confirmedReplacements.some(
      (r) => r.itemType === u.itemType && r.itemId === u.itemId && r.replacementId
    )
  );
  if (unresolved.length) {
    // 缺件/待修：不自动替换，只在提交时转为替换候选返回
    throw new DomainError(409, 'ITEMS_UNAVAILABLE', '存在缺件或待修，需确认替换候选后重提', {
      unavailable: plan.unavailable,
      candidates: plan.candidates
    });
  }

  const manifestVersion = (schedule.manifestVersion || 0) + 1;
  const replacementHistory = [
    ...(schedule.replacementHistory || []),
    ...plan.candidates
      .filter((c) => c.replacement && mergedData.confirmedReplacements.some(
        (r) => r.itemType === c.itemType && r.itemId === c.itemId && r.replacementId === c.replacement.replacementId
      ))
      .map((c) => ({
        at: db.now(),
        from: c.itemId,
        fromName: c.name,
        to: c.replacement.replacementId,
        toName: c.replacement.name,
        reason: c.reason,
        manifestVersion,
        stage: '提交替换'
      }))
  ];

  store.replaceLocks(id, plan.entries, manifestVersion);
  const nextData = {
    ...mergedData,
    replacementHistory,
    manifestVersion
  };
  const saved = store.saveSchedule(id, nextData, '已锁档', {
    action: '提交锁场',
    actor,
    note: '按日期与箱位锁定 ' + plan.entries.length + ' 条占用',
    data: { entries: plan.entries, replacements: replacementHistory, manifestVersion }
  });
  return { status: 200, body: scheduleView(saved) };
}

/* ---------------- 演出前更换角色/偶头 ---------------- */

function swap(id, body, actor) {
  const schedule = assertSchedule(id);
  if (!['已锁档', '演出待开场'].includes(state.deriveStatus(schedule))) {
    throw new DomainError(409, 'SWAP_NOT_ALLOWED', '演出前更换只允许在已锁档/演出待开场进行，当前: ' + schedule.status);
  }
  const { itemType, fromItemId, toItemId } = body || {};
  if (!['head', 'accessory'].includes(itemType) || !fromItemId || !toItemId) {
    throw new DomainError(400, 'VALIDATION_ERROR', '需要 itemType(head|accessory)、fromItemId、toItemId');
  }

  const { heads, accessories } = loadMaps();
  const target = itemType === 'head' ? heads.get(toItemId) : accessories.get(toItemId);
  const usable = itemType === 'head' ? state.isUsableHead(target) : state.isUsableAccessory(target);
  if (!target) throw new DomainError(404, 'ITEM_NOT_FOUND', '替换件不存在');
  if (!usable) throw new DomainError(409, 'TARGET_UNAVAILABLE', '替换件状态不可用: ' + target.status, { status: target.status });

  // 旧场次清单立即失效：用全量锁快照（含本档期旧锁，但 planLocks 会按 scheduleId 排除）
  const activeLocks = store.getAllActiveLocks();
  const index = state.buildLockIndex(activeLocks.filter((l) => l.scheduleId !== id));
  const dates = state.datesOf(schedule);
  const busyDates = dates.filter((d) => index.byItemDate.has(toItemId + '|' + d));
  if (busyDates.length) {
    throw new DomainError(409, 'TARGET_BUSY', '替换件在以下演出日期已被占用', { busyDates });
  }

  // 同箱同档校验（沿用本档期箱位）
  const slotConflicts = [];
  for (const d of dates) {
    for (const lock of index.byDateBox.get(d + '|' + schedule.boxNo) || []) {
      slotConflicts.push({ showDate: d, boxNo: schedule.boxNo, otherScheduleId: lock.scheduleId });
    }
  }
  if (slotConflicts.length) {
    throw new DomainError(409, 'SLOT_CONFLICT', '箱位在演出日期被其他档期占用', { slotConflicts });
  }

  // 在当前清单里换掉旧件，整体重算
  const nextData = { ...schedule };
  if (itemType === 'head') {
    nextData.headIds = (schedule.headIds || []).map((h) => (h === fromItemId ? toItemId : h));
    if (!nextData.headIds.includes(toItemId)) nextData.headIds.push(toItemId);
  } else {
    nextData.accessoryIds = (schedule.accessoryIds || []).map((a) => (a === fromItemId ? toItemId : a));
    if (!nextData.accessoryIds.includes(toItemId)) nextData.accessoryIds.push(toItemId);
  }
  nextData.confirmedReplacements = [
    ...(schedule.confirmedReplacements || []).filter(
      (r) => !(r.itemType === itemType && r.itemId === fromItemId)
    ),
    { itemType, itemId: fromItemId, replacementId: toItemId }
  ];

  const plan = state.planLocks(nextData, { heads, accessories, activeLocks, scheduleId: id });
  if (plan.conflicts.length) {
    throw new DomainError(409, 'SCHEDULE_CONFLICT', '更换后产生档期冲突，旧清单已失效需重算', { conflicts: plan.conflicts });
  }

  const manifestVersion = (schedule.manifestVersion || 1) + 1;
  const fromRecord = itemType === 'head' ? heads.get(fromItemId) : accessories.get(fromItemId);
  nextData.replacementHistory = [
    ...(schedule.replacementHistory || []),
    {
      at: db.now(),
      from: fromItemId,
      fromName: fromRecord ? fromRecord.name || fromRecord.role : fromItemId,
      to: toItemId,
      toName: target.name || target.role,
      reason: body.reason || '演出前更换',
      manifestVersion,
      stage: '演前换角'
    }
  ];
  nextData.manifestVersion = manifestVersion;

  store.replaceLocks(id, plan.entries, manifestVersion);
  const saved = store.saveSchedule(id, nextData, state.deriveStatus(schedule), {
    action: '演出前更换',
    actor,
    note: (fromRecord ? fromRecord.name || fromRecord.role : fromItemId) + ' -> ' + (target.name || target.role) + '，旧场次清单失效并重算',
    data: { itemType, fromItemId, toItemId, entries: plan.entries, manifestVersion }
  });
  return { status: 200, body: scheduleView(saved) };
}

/* ---------------- 状态推进 / 返场闭环 ---------------- */

function transition(id, toStatus, actor, note, fields = {}) {
  const schedule = assertSchedule(id);
  const current = state.deriveStatus(schedule);
  if (!state.canTransition(current, toStatus)) {
    throw new DomainError(409, 'INVALID_TRANSITION', current + ' 不能转为 ' + toStatus);
  }
  const nextData = { ...schedule, ...fields };
  const saved = store.saveSchedule(id, nextData, toStatus, {
    action: {
      演出待开场: '演出日到达',
      巡演中: '出发巡演',
      返场清点中: '返场清点',
      已闭环: '返场清点闭环'
    }[toStatus] || '状态推进',
    actor,
    note: note || '',
    data: { from: current, to: toStatus, ...fields }
  });
  return { status: 200, body: scheduleView(saved) };
}

/**
 * 返场清点：可登记缺损/遗失（写 lossReports）。清点未闭环前锁不释放。
 */
function checkIn(id, body = {}, actor) {
  const schedule = assertSchedule(id);
  const current = state.deriveStatus(schedule);
  if (!['巡演中', '返场清点中'].includes(current)) {
    throw new DomainError(409, 'INVALID_TRANSITION', '仅巡演中档期可返场清点，当前: ' + current);
  }
  const losses = [];
  for (const item of body.losses || []) {
    const lossId = randomUUID();
    const lossData = {
      tourBoxScheduleId: id,
      showName: schedule.showName,
      itemType: item.itemType === 'head' ? '偶头' : '配件',
      itemId: item.itemId || '',
      itemName: item.itemName || item.itemId,
      problem: item.problem,
      status: '待处理'
    };
    db.insertRecord({
      id: lossId,
      collection: 'lossReports',
      status: '待处理',
      data: lossData,
      createdAt: db.now(),
      eventAction: '返场登记',
      actor: actor || '',
      note: schedule.showName
    });
    // 缺损/遗失的件在档案上同步状态，闭环后也不会被误当可用
    if (item.itemId) {
      const collection = item.itemType === 'head' ? 'puppetHeads' : 'accessories';
      const record = db.getRecord(collection, item.itemId);
      if (record) {
        const nextStatus = item.problem === '遗失'
          ? (item.itemType === 'head' ? '不可演出' : '遗失')
          : (item.itemType === 'head' ? '待修补' : '缺损');
        const updated = { ...record, status: nextStatus, currentUsable: item.problem === '遗失' ? false : record.currentUsable };
        db.updateRecord(item.itemId, collection, updated, nextStatus);
        db.addEvent({
          recordId: item.itemId,
          collection,
          action: '返场清点标记',
          status: nextStatus,
          actor: actor || '',
          note: schedule.showName + ': ' + item.problem,
          data: { scheduleId: id, problem: item.problem }
        });
      }
    }
    losses.push(lossId);
  }
  const saved = store.saveSchedule(id, {
    ...schedule,
    checkIn: { at: db.now(), losses, note: body.note || '' }
  }, '返场清点中', {
    action: '返场清点',
    actor,
    note: body.note || '',
    data: { losses }
  });
  return { status: 200, body: scheduleView(saved) };
}

/** 闭环：释放本档期全部活动锁，偶头/配件才允许进入下一档期 */
function closeOut(id, body = {}, actor) {
  const schedule = assertSchedule(id);
  const current = state.deriveStatus(schedule);
  if (current !== '返场清点中') {
    throw new DomainError(409, 'INVALID_TRANSITION', '返场清点未完成，不能闭环，当前: ' + current);
  }
  const manifestVersion = schedule.manifestVersion || 1;
  db.run('UPDATE schedule_locks SET active = 0 WHERE schedule_id = ? AND active = 1;', [id]);
  const saved = store.saveSchedule(id, {
    ...schedule,
    closedAt: db.now(),
    closeNote: body.note || ''
  }, '已闭环', {
    action: '返场清点闭环',
    actor,
    note: body.note || '占用全部释放',
    data: { manifestVersion, releasedAt: db.now() }
  });
  return { status: 200, body: scheduleView(saved) };
}

module.exports = {
  DomainError,
  serialize,
  withIdempotency,
  scheduleView,
  createDraft,
  preview,
  submit,
  swap,
  transition,
  checkIn,
  closeOut
};
