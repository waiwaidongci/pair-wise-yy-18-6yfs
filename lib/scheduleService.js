'use strict';

// 状态判断层：档期/箱位占用、替换候选、返场闭环等全部业务规则。
// 不直接碰 HTTP，所有写操作由路由在 store.txn 中调用，保证原子性。

const SCHEDULE = 'tourSchedules';
const HEAD = 'puppetHead';
const ACCESSORY = 'accessory';

const STATUS = {
  DRAFT: '草稿',
  REPLACEABLE: '待替换',
  LOCKED: '已锁定',
  ON_TOUR: '巡演中',
  CHECKING: '返场清点中',
  CLOSED: '已闭环',
  CANCELLED: '已取消'
};

// 持锁的活动状态（锁表 JOIN 档案时的一致口径）
const ACTIVE_STATUSES = [STATUS.REPLACEABLE, STATUS.LOCKED, STATUS.ON_TOUR, STATUS.CHECKING];
const ON_STAGE_STATUSES = [STATUS.ON_TOUR, STATUS.CHECKING];
const OPEN_LOSS_STATUSES = ['待处理', '修复中'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function normalizeEntries(store, play, body = {}) {
  const headInput = body.headEntries || (Array.isArray(body.headIds)
    ? body.headIds.map((headId) => ({ headId }))
    : []);
  const accessoryInput = body.accessoryEntries || (Array.isArray(body.accessoryIds)
    ? body.accessoryIds.map((accessoryId) => ({ accessoryId }))
    : []);

  const headEntries = headInput.map((entry, index) => {
    const raw = typeof entry === 'string' ? { headId: entry } : { ...entry };
    if (raw.headId) {
      const head = store.findRecord('puppetHeads', raw.headId);
      if (head) {
        return {
          entryIndex: index,
          headId: head.id,
          role: raw.role || head.role,
          boxNo: raw.boxNo || head.boxNo
        };
      }
      return { entryIndex: index, headId: raw.headId, role: raw.role || '', boxNo: raw.boxNo || '' };
    }
    return { entryIndex: index, headId: null, role: raw.role || '', boxNo: raw.boxNo || '' };
  });

  const accessoryEntries = accessoryInput.map((entry, index) => {
    const raw = typeof entry === 'string' ? { accessoryId: entry } : { ...entry };
    if (raw.accessoryId) {
      const item = store.findRecord('accessories', raw.accessoryId);
      if (item) {
        return {
          entryIndex: index,
          accessoryId: item.id,
          name: raw.name || item.name,
          role: raw.role || item.role
        };
      }
      return { entryIndex: index, accessoryId: raw.accessoryId, name: raw.name || '', role: raw.role || '' };
    }
    return { entryIndex: index, accessoryId: null, name: raw.name || '', role: raw.role || '' };
  });

  return { headEntries, accessoryEntries };
}

function validateDates(startDate, endDate) {
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw new HttpError(400, 'BAD_DATE', '日期格式应为 YYYY-MM-DD');
  }
  if (startDate > endDate) {
    throw new HttpError(400, 'BAD_DATE', '起始日期不得晚于结束日期');
  }
}

// 单个候选偶头/配件在指定档期是否仍可被占用
function candidateBlockers(store, itemType, itemId, startDate, endDate, boxNo, selfScheduleId) {
  const blockers = [];
  for (const lock of store.activeLocks()) {
    if (lock.scheduleId === selfScheduleId) continue;
    const s = lock.schedule;
    const hitOverlap = overlap(startDate, endDate, s.startDate, s.endDate);
    if (lock.itemType === itemType && lock.itemId === itemId) {
      if (ON_STAGE_STATUSES.includes(lock.scheduleStatus) && s.endDate < startDate) {
        blockers.push({ code: 'RETURN_NOT_CLOSED', schedule: s });
      } else if (hitOverlap) {
        blockers.push({ code: 'SCHEDULE_OVERLAP', schedule: s });
      }
    }
    if (itemType === HEAD && lock.itemType === HEAD && boxNo && lock.boxNo === boxNo && hitOverlap) {
      blockers.push({ code: 'BOX_OVERLAP', schedule: s, boxNo });
    }
  }
  return blockers;
}

function headCandidates(store, role, play, startDate, endDate, boxNo, selfScheduleId) {
  return store.listRecords('puppetHeads')
    .filter((head) => ['可演出', '已装箱'].includes(head.status) && head.role === role && (!play || head.play === play))
    .map((head) => {
      const blockers = candidateBlockers(store, HEAD, head.id, startDate, endDate, boxNo || head.boxNo, selfScheduleId);
      return {
        headId: head.id,
        role: head.role,
        play: head.play,
        boxNo: head.boxNo,
        lockable: blockers.length === 0,
        blockers: blockers.map((b) => ({ code: b.code, scheduleId: b.schedule.id, showName: b.schedule.showName }))
      };
    });
}

function accessoryCandidates(store, name, role, play, startDate, endDate, selfScheduleId) {
  return store.listRecords('accessories')
    .filter((item) => ['在库', '已装箱'].includes(item.status) && item.name === name && item.role === role && (!play || item.play === play))
    .map((item) => {
      const blockers = candidateBlockers(store, ACCESSORY, item.id, startDate, endDate, null, selfScheduleId);
      return {
        accessoryId: item.id,
        name: item.name,
        role: item.role,
        play: item.play,
        boxNo: item.boxNo,
        lockable: blockers.length === 0,
        blockers: blockers.map((b) => ({ code: b.code, scheduleId: b.schedule.id, showName: b.schedule.showName }))
      };
    });
}

// 核心判定：把清单分成 可锁项 / 缺件待修项（提交时才转候选）/ 硬冲突项
function evaluate(store, schedule, { headEntries, accessoryEntries }) {
  const { startDate, endDate, play } = schedule;
  const bad = [];
  const conflicts = [];
  const lockableHeads = [];
  const lockableAccessories = [];

  const seenHead = new Set();
  const seenBox = new Set();

  headEntries.forEach((entry) => {
    const head = entry.headId ? store.findRecord('puppetHeads', entry.headId) : null;
    if (!head) {
      bad.push({
        itemType: HEAD,
        entryIndex: entry.entryIndex,
        role: entry.role,
        reason: '缺件',
        candidates: headCandidates(store, entry.role, play, startDate, endDate, entry.boxNo, schedule.id)
      });
      return;
    }
    // 同一清单内重复引用同一偶头/同一箱位也算硬冲突，最先判定
    if (seenHead.has(head.id)) {
      conflicts.push({ itemType: HEAD, entryIndex: entry.entryIndex, headId: head.id, code: 'DUP_ENTRY', reason: '清单内偶头重复' });
      return;
    }
    if (entry.boxNo && seenBox.has(entry.boxNo)) {
      conflicts.push({ itemType: HEAD, entryIndex: entry.entryIndex, headId: head.id, boxNo: entry.boxNo, code: 'DUP_BOX', reason: '清单内箱位重复' });
      return;
    }
    // 档期/箱位重叠与返场门禁是硬冲突，优先于件自身状态判定
    const blockers = candidateBlockers(store, HEAD, head.id, startDate, endDate, entry.boxNo, schedule.id);
    if (blockers.length) {
      for (const blocker of blockers) {
        conflicts.push({
          itemType: HEAD,
          entryIndex: entry.entryIndex,
          headId: head.id,
          boxNo: entry.boxNo,
          code: blocker.code,
          reason: blocker.code === 'RETURN_NOT_CLOSED' ? '返场清点未闭环，不得进入下一档期' : '重叠档期不得重复占用',
          scheduleId: blocker.schedule.id,
          showName: blocker.schedule.showName,
          box: blocker.boxNo
        });
      }
      return;
    }
    if (!['可演出', '已装箱'].includes(head.status)) {
      bad.push({
        itemType: HEAD,
        entryIndex: entry.entryIndex,
        headId: head.id,
        role: entry.role,
        reason: '待修',
        headStatus: head.status,
        candidates: headCandidates(store, entry.role, play, startDate, endDate, entry.boxNo, schedule.id)
      });
      return;
    }
    seenHead.add(head.id);
    if (entry.boxNo) seenBox.add(entry.boxNo);
    lockableHeads.push({ entry, head });
  });

  const seenAccessory = new Set();
  accessoryEntries.forEach((entry) => {
    const item = entry.accessoryId ? store.findRecord('accessories', entry.accessoryId) : null;
    if (!item) {
      bad.push({
        itemType: ACCESSORY,
        entryIndex: entry.entryIndex,
        name: entry.name,
        role: entry.role,
        reason: '缺件',
        candidates: accessoryCandidates(store, entry.name, entry.role, play, startDate, endDate, schedule.id)
      });
      return;
    }
    if (seenAccessory.has(item.id)) {
      conflicts.push({ itemType: ACCESSORY, entryIndex: entry.entryIndex, accessoryId: item.id, code: 'DUP_ENTRY', reason: '清单内配件重复' });
      return;
    }
    const blockers = candidateBlockers(store, ACCESSORY, item.id, startDate, endDate, null, schedule.id);
    if (blockers.length) {
      for (const blocker of blockers) {
        conflicts.push({
          itemType: ACCESSORY,
          entryIndex: entry.entryIndex,
          accessoryId: item.id,
          code: blocker.code,
          reason: blocker.code === 'RETURN_NOT_CLOSED' ? '返场清点未闭环，不得进入下一档期' : '重叠档期不得重复占用',
          scheduleId: blocker.schedule.id,
          showName: blocker.schedule.showName
        });
      }
      return;
    }
    if (!['在库', '已装箱'].includes(item.status)) {
      bad.push({
        itemType: ACCESSORY,
        entryIndex: entry.entryIndex,
        accessoryId: item.id,
        name: entry.name,
        role: item.role,
        reason: '待修',
        itemStatus: item.status,
        candidates: accessoryCandidates(store, entry.name, entry.role, play, startDate, endDate, schedule.id)
      });
      return;
    }
    seenAccessory.add(item.id);
    lockableAccessories.push({ entry, item });
  });

  return { bad, conflicts, lockableHeads, lockableAccessories };
}

// ---- 档案状态联动 -------------------------------------------------------
function setItemStatus(store, itemType, id, status, extra = {}, actor = 'system', note = '') {
  const collection = itemType === HEAD ? 'puppetHeads' : 'accessories';
  const record = store.findRecord(collection, id);
  if (!record) return;
  const data = { ...record, ...extra, status };
  delete data.id;
  delete data.collection;
  delete data.createdAt;
  delete data.updatedAt;
  store.updateRecord(collection, id, data, status);
  store.insertEvent({ recordId: id, collection, action: '状态变更', status, actor, note, data: { status, ...extra } });
}

function restoreHeldItems(store, scheduleId) {
  const stillHeld = new Set(
    store.activeLocks()
      .filter((lock) => lock.scheduleId !== scheduleId)
      .map((lock) => lock.itemType + ':' + lock.itemId)
  );
  for (const lock of store.locksForSchedule(scheduleId)) {
    if (lock.released_at) continue;
    const key = lock.item_type + ':' + lock.item_id;
    if (stillHeld.has(key)) continue;
    const collection = lock.item_type === HEAD ? 'puppetHeads' : 'accessories';
    const record = store.findRecord(collection, lock.item_id);
    if (!record) continue;
    if (record.status !== '已装箱') continue;
    const status = lock.item_type === HEAD ? '可演出' : '在库';
    const data = { ...record, status, ...(lock.item_type === HEAD ? { currentUsable: true } : {}) };
    delete data.id;
    delete data.collection;
    delete data.createdAt;
    delete data.updatedAt;
    store.updateRecord(collection, record.id, data, status);
    store.insertEvent({
      recordId: record.id,
      collection,
      action: '释放档期占用',
      status,
      actor: 'system',
      note: '随巡演档期 ' + scheduleId + ' 释放',
      data: { scheduleId, status }
    });
  }
}

function persistSchedule(store, schedule, data, status, actor, action, note, eventData = {}) {
  const next = { ...schedule, ...data, status };
  delete next.id;
  delete next.collection;
  delete next.createdAt;
  delete next.updatedAt;
  store.updateRecord(SCHEDULE, schedule.id, next, status);
  store.insertEvent({
    recordId: schedule.id,
    collection: SCHEDULE,
    action,
    status,
    actor: actor || '',
    note: note || '',
    data: { status, ...eventData }
  });
  return store.findRecord(SCHEDULE, schedule.id);
}

function loadSchedule(store, id) {
  const schedule = store.findRecord(SCHEDULE, id);
  if (!schedule) throw new HttpError(404, 'NOT_FOUND', '巡演档期不存在');
  return schedule;
}

function requireStatus(schedule, allowed, message) {
  if (!allowed.includes(schedule.status)) {
    throw new HttpError(409, 'BAD_STATUS', message || '当前状态不允许该操作：' + schedule.status, { scheduleStatus: schedule.status });
  }
}

// ---- 提交锁场（草稿/待替换 → 已锁定/待替换） -----------------------------
function submit(store, id, body, { reassign = false } = {}) {
  const existing = loadSchedule(store, id);
  if (!reassign) {
    requireStatus(existing, [STATUS.DRAFT, STATUS.REPLACEABLE], '仅草稿或待替换档期可以提交锁场');
  } else {
    requireStatus(existing, [STATUS.LOCKED, STATUS.REPLACEABLE], '仅演出前的已锁定/待替换档期可以更换角色');
    if (existing.startDate <= today()) {
      throw new HttpError(409, 'SHOW_STARTED', '演出已开始，旧场次清单不能再更换', { scheduleStatus: existing.status });
    }
  }
  validateDates(existing.startDate, existing.endDate);

  const version = (existing.manifestVersion || 0) + 1;

  // 提交未带清单时沿用档期现有清单；显式传入则整份重算
  const payload = {
    ...body,
    headEntries: body.headEntries !== undefined
      ? body.headEntries
      : (Array.isArray(body.headIds) ? body.headIds : (existing.headEntries || [])),
    accessoryEntries: body.accessoryEntries !== undefined
      ? body.accessoryEntries
      : (Array.isArray(body.accessoryIds) ? body.accessoryIds : (existing.accessoryEntries || []))
  };
  // 旧场次清单立即失效（reassign）：先释放旧锁并归还旧件状态，再按新件重算。
  // 普通草稿提交此前没有任何已生效锁，无需释放。
  if (reassign) {
    restoreHeldItems(store, id);
    store.releaseLocks(id);
  }

  const normalized = normalizeEntries(store, existing.play, payload);
  const { bad, conflicts, lockableHeads, lockableAccessories } = evaluate(store, existing, normalized);

  if (conflicts.length) {
    // reassign：旧清单已经生效过，立即失效，档期落待替换并持久化冲突与候选；
    // 草稿首次提交：清单从未生效，保持草稿不动
    if (reassign) {
      const failed = persistSchedule(
        store, existing,
        {
          headEntries: normalized.headEntries,
          accessoryEntries: normalized.accessoryEntries,
          manifestVersion: version,
          lockedAtVersion: null,
          replaceable: bad,
          conflicts
        },
        STATUS.REPLACEABLE,
        body.actor,
        '更换角色遇冲突，旧清单已失效',
        body.note || '',
        { manifestVersion: version, conflicts, replaceable: bad.length }
      );
      throw Object.assign(new HttpError(409, 'LOCK_CONFLICT', '存在档期或箱位冲突，旧场次清单已失效，未占用任何偶头/配件', {
        conflicts,
        schedule: failed
      }), { commit: true });
    }
    store.insertEvent({
      recordId: id,
      collection: SCHEDULE,
      action: '提交锁场失败',
      status: existing.status,
      actor: body.actor || '',
      note: body.note || '',
      data: { conflicts }
    });
    throw new HttpError(409, 'LOCK_CONFLICT', '存在档期或箱位冲突，未占用任何偶头/配件', {
      conflicts,
      schedule: store.findRecord(SCHEDULE, id)
    });
  }

  // 待替换档期重新提交成功：先把上一版（可能在失败重算中残留的）锁彻底清掉
  restoreHeldItems(store, id);
  store.releaseLocks(id);

  lockableHeads.forEach(({ entry }) => {
    store.insertLock({
      scheduleId: id,
      itemType: HEAD,
      itemId: entry.headId,
      boxNo: entry.boxNo,
      role: entry.role,
      entryIndex: entry.entryIndex,
      manifestVersion: version
    });
  });
  lockableAccessories.forEach(({ entry }) => {
    store.insertLock({
      scheduleId: id,
      itemType: ACCESSORY,
      itemId: entry.accessoryId,
      boxNo: null,
      role: entry.role,
      entryIndex: entry.entryIndex,
      manifestVersion: version
    });
  });

  const lockedItems = [
    ...lockableHeads.map(({ entry }) => ({ itemType: HEAD, entryIndex: entry.entryIndex, itemId: entry.headId, boxNo: entry.boxNo, role: entry.role })),
    ...lockableAccessories.map(({ entry }) => ({ itemType: ACCESSORY, entryIndex: entry.entryIndex, itemId: entry.accessoryId, name: entry.name, role: entry.role }))
  ];

  lockableHeads.forEach(({ head }) => {
    setItemStatus(store, HEAD, head.id, '已装箱', {}, body.actor || 'system',
      (reassign ? '更换角色后' : '') + '锁入档期 ' + id + '（' + existing.startDate + '~' + existing.endDate + '）');
  });
  lockableAccessories.forEach(({ item }) => {
    setItemStatus(store, ACCESSORY, item.id, '已装箱', {}, body.actor || 'system',
      (reassign ? '更换角色后' : '') + '锁入档期 ' + id + '（' + existing.startDate + '~' + existing.endDate + '）');
  });

  const nextStatus = bad.length ? STATUS.REPLACEABLE : STATUS.LOCKED;
  const schedule = persistSchedule(
    store, existing,
    {
      headEntries: normalized.headEntries,
      accessoryEntries: normalized.accessoryEntries,
      manifestVersion: version,
      lockedAtVersion: bad.length ? (existing.lockedAtVersion || null) : version,
      replaceable: bad
    },
    nextStatus,
    body.actor,
    reassign ? '更换角色并重算清单' : '提交锁场',
    body.note || '',
    { manifestVersion: version, locked: lockedItems.length, replaceable: bad.length }
  );

  return {
    schedule,
    manifestVersion: version,
    locked: lockedItems,
    replaceable: bad
  };
}

// ---- 出发巡演 -----------------------------------------------------------
function depart(store, id, body = {}) {
  const schedule = loadSchedule(store, id);
  requireStatus(schedule, [STATUS.LOCKED], '仅已锁定档期可以出发巡演');
  return persistSchedule(store, schedule, { departedAt: new Date().toISOString() }, STATUS.ON_TOUR,
    body.actor, '出发巡演', body.note || '');
}

// ---- 返场清点（锁不释放，只登记缺损） -----------------------------------
function returnCheck(store, id, body = {}) {
  const schedule = loadSchedule(store, id);
  requireStatus(schedule, [STATUS.ON_TOUR], '仅巡演中档期可以返场清点');
  const returns = Array.isArray(body.returns) ? body.returns : [];
  const lossReports = [];

  for (const item of returns) {
    if (!item.problem) continue;
    const isHead = item.itemType === HEAD;
    const collection = isHead ? 'puppetHeads' : 'accessories';
    const record = item.itemId ? store.findRecord(collection, item.itemId) : null;
    const itemName = item.itemName || record?.name || (isHead ? record?.role + '偶头' : '配件');
    const createdAt = new Date().toISOString();
    const lossData = {
      tourBoxId: id,
      scheduleId: id,
      itemType: isHead ? '偶头' : '配件',
      itemId: item.itemId || null,
      itemName,
      role: item.role || record?.role || '',
      problem: item.problem
    };
    const loss = store.insertRecord({
      collection: 'lossReports',
      status: '待处理',
      data: { ...lossData, status: '待处理' },
      createdAt
    });
    store.insertEvent({
      recordId: loss.id,
      collection: 'lossReports',
      action: '返场清点登记',
      status: '待处理',
      actor: body.actor || '',
      note: item.problem,
      data: lossData
    });
    lossReports.push(loss);

    if (isHead && record) {
      const data = { ...record, status: '待修补', currentUsable: false };
      delete data.id; delete data.collection; delete data.createdAt; delete data.updatedAt;
      store.updateRecord('puppetHeads', record.id, data, '待修补');
      store.insertEvent({
        recordId: record.id,
        collection: 'puppetHeads',
        action: '返场缺损待修',
        status: '待修补',
        actor: body.actor || '',
        note: item.problem,
        data: { scheduleId: id, problem: item.problem }
      });
    } else if (!isHead && record && record.status === '已装箱') {
      const data = { ...record, status: '缺损' };
      delete data.id; delete data.collection; delete data.createdAt; delete data.updatedAt;
      store.updateRecord('accessories', record.id, data, '缺损');
      store.insertEvent({
        recordId: record.id,
        collection: 'accessories',
        action: '返场缺损',
        status: '缺损',
        actor: body.actor || '',
        note: item.problem,
        data: { scheduleId: id, problem: item.problem }
      });
    }
  }

  const updated = persistSchedule(store, schedule, { checkedAt: new Date().toISOString() }, STATUS.CHECKING,
    body.actor, '返场清点', body.note || '', { lossReports: lossReports.map((r) => r.id) });
  return { schedule: updated, lossReports };
}

function openLossReports(store, scheduleId) {
  return store.listRecords('lossReports').filter(
    (r) => (r.tourBoxId === scheduleId || r.scheduleId === scheduleId) && OPEN_LOSS_STATUSES.includes(r.status)
  );
}

// ---- 闭环（清点无未决缺损后释放全部占用） -------------------------------
function close(store, id, body = {}) {
  const schedule = loadSchedule(store, id);
  requireStatus(schedule, [STATUS.CHECKING], '仅返场清点中档期可以闭环');
  const open = openLossReports(store, id);
  if (open.length) {
    throw new HttpError(409, 'LOSS_OPEN', '仍有 ' + open.length + ' 条缺损未处理，不能闭环', {
      openLossReports: open.map((r) => ({ id: r.id, itemName: r.itemName, problem: r.problem, status: r.status }))
    });
  }
  restoreHeldItems(store, id);
  // 返场登记为缺损、但缺损单已全部补齐的配件恢复在库；偶头待修需走修补记录，不自动回滚
  for (const loss of store.listRecords('lossReports')) {
    if ((loss.tourBoxId !== id && loss.scheduleId !== id) || loss.itemType !== '配件') continue;
    if (loss.status !== '已补齐' || !loss.itemId) continue;
    const record = store.findRecord('accessories', loss.itemId);
    if (record && record.status === '缺损') {
      const data = { ...record, status: '在库' };
      delete data.id; delete data.collection; delete data.createdAt; delete data.updatedAt;
      store.updateRecord('accessories', record.id, data, '在库');
      store.insertEvent({
        recordId: record.id,
        collection: 'accessories',
        action: '缺损补齐回库',
        status: '在库',
        actor: body.actor || '',
        note: '档期 ' + id + ' 闭环时恢复',
        data: { scheduleId: id, lossReportId: loss.id }
      });
    }
  }
  store.releaseLocks(id);
  return persistSchedule(store, schedule, { closedAt: new Date().toISOString() }, STATUS.CLOSED,
    body.actor, '返场闭环', body.note || '全部占用已释放');
}

// ---- 取消（演出前） -----------------------------------------------------
function cancel(store, id, body = {}) {
  const schedule = loadSchedule(store, id);
  requireStatus(schedule, [STATUS.DRAFT, STATUS.REPLACEABLE, STATUS.LOCKED], '当前档期不能取消');
  if (schedule.status === STATUS.LOCKED && schedule.startDate <= today()) {
    throw new HttpError(409, 'SHOW_STARTED', '演出已开始，不能取消档期');
  }
  restoreHeldItems(store, id);
  store.releaseLocks(id);
  return persistSchedule(store, schedule, { cancelledAt: new Date().toISOString() }, STATUS.CANCELLED,
    body.actor, '取消档期', body.note || '');
}

// ---- 占用查询（列表/单场/刷新后共用同一数据源） -------------------------
function itemOccupancy(store, itemType, itemId) {
  const collection = itemType === HEAD ? 'puppetHeads' : 'accessories';
  const item = store.findRecord(collection, itemId);
  if (!item) throw new HttpError(404, 'NOT_FOUND', '档案不存在');
  const locks = store.activeLocks()
    .filter((lock) => lock.itemType === itemType && lock.itemId === itemId)
    .map((lock) => ({
      scheduleId: lock.scheduleId,
      showName: lock.schedule.showName,
      venue: lock.schedule.venue,
      play: lock.schedule.play,
      startDate: lock.schedule.startDate,
      endDate: lock.schedule.endDate,
      boxNo: lock.boxNo,
      role: lock.role,
      manifestVersion: lock.manifestVersion,
      scheduleStatus: lock.scheduleStatus,
      blockingNext: ON_STAGE_STATUSES.includes(lock.scheduleStatus)
    }));
  return { item, locks, occupied: locks.length > 0 };
}

function scheduleManifest(store, id) {
  const schedule = loadSchedule(store, id);
  const locks = store.locksForSchedule(id).map((lock) => ({
    itemType: lock.item_type,
    itemId: lock.item_id,
    boxNo: lock.box_no,
    role: lock.role,
    entryIndex: lock.entry_index,
    manifestVersion: lock.manifest_version,
    active: !lock.released_at,
    acquiredAt: lock.acquired_at,
    releasedAt: lock.released_at
  }));
  return {
    schedule,
    manifestVersion: schedule.manifestVersion || 0,
    activeLocks: locks.filter((l) => l.active),
    supersededLocks: locks.filter((l) => !l.active),
    openLossReports: openLossReports(store, id)
  };
}

module.exports = {
  SCHEDULE,
  HEAD,
  ACCESSORY,
  STATUS,
  ACTIVE_STATUSES,
  HttpError,
  today,
  normalizeEntries,
  validateDates,
  evaluate,
  submit,
  depart,
  returnCheck,
  close,
  cancel,
  itemOccupancy,
  scheduleManifest,
  openLossReports,
  loadSchedule
};
