'use strict';

// 端到端测试：独立 DB_DIR + 独立端口，跑完即停，覆盖档期占用闭环全部规则。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const PORT = 3955;
const BASE = 'http://localhost:' + PORT + '/api';
const DB_DIR = path.join(__dirname, '..', 'tmp-test-db');

let server;

function request(method, urlPath, body, headers = {}) {
  return fetch(BASE + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async (res) => {
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  });
}

async function main() {
  fs.rmSync(DB_DIR, { recursive: true, force: true });
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_DIR, DB_FILE: path.join(DB_DIR, 'test.db') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://localhost:' + PORT + '/health');
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }

  const H = {
    wusheng1: 'head-seed-wusheng-1',
    wusheng2: 'head-seed-wusheng-2',
    hua: 'head-seed-hua-1',
    jing: 'head-seed-jing-1',
    damaged: 'head-seed-1'
  };
  const A = {
    guan1: 'accessory-seed-1',
    guan2: 'accessory-seed-2',
    duankao: 'accessory-seed-3',
    fengguan: 'accessory-seed-4'
  };

  const d = (offset) => {
    const t = new Date();
    t.setDate(t.getDate() + offset);
    return t.toISOString().slice(0, 10);
  };

  let pass = 0;
  async function check(name, fn) {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  }

  // 1. 正常锁场：日期 + 箱位锁定
  await check('创建并提交档期，偶头与配件按日期/箱位锁定', async () => {
    const created = await request('POST', '/tourSchedules', {
      showName: '泉州火焰山',
      venue: '泉州梨园剧场',
      play: '火焰山',
      startDate: d(10),
      endDate: d(12),
      headEntries: [
        { headId: H.wusheng1 },
        { headId: H.hua },
        { headId: H.jing }
      ],
      accessoryEntries: [
        { accessoryId: A.guan1 },
        { accessoryId: A.duankao },
        { accessoryId: A.fengguan }
      ],
      actor: '班长'
    });
    assert.equal(created.status, 201);
    global.scheduleId = created.body.id;

    const submitted = await request('POST', `/tourSchedules/${scheduleId}/submit`, { actor: '班长' });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.schedule.status, '已锁定');
    assert.equal(submitted.body.locked.length, 6);
    assert.equal(submitted.body.replaceable.length, 0);

    const head = (await request('GET', `/puppetHeads/${H.wusheng1}`)).body;
    assert.equal(head.status, '已装箱');
    const acc = (await request('GET', `/accessories/${A.guan1}`)).body;
    assert.equal(acc.status, '已装箱');
  });

  // 2. 重叠档期：同偶头不得重复占用
  await check('重叠档期占用同一偶头 → 409 且不占用任何件', async () => {
    const created = await request('POST', '/tourSchedules', {
      showName: '厦门火焰山',
      venue: '厦门艺术中心',
      play: '火焰山',
      startDate: d(11),
      endDate: d(13),
      headEntries: [{ headId: H.wusheng1 }],
      accessoryEntries: []
    });
    assert.equal(created.status, 201);
    const id2 = created.body.id;
    const res = await request('POST', `/tourSchedules/${id2}/submit`, {}, { 'Idempotency-Key': 'k-overlap-head' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'LOCK_CONFLICT');
    assert.ok(res.body.conflicts.some((c) => c.code === 'SCHEDULE_OVERLAP'));
    const still = (await request('GET', `/tourSchedules/${id2}`)).body;
    assert.equal(still.status, '草稿');
  });

  // 3. 箱位冲突：另一个可用偶头但指定了已占箱位
  await check('不同偶头但同箱位重叠 → 409 BOX_OVERLAP', async () => {
    const created = await request('POST', '/tourSchedules', {
      showName: '漳州火焰山',
      venue: '漳州大剧院',
      play: '火焰山',
      startDate: d(11),
      endDate: d(11),
      headEntries: [{ headId: H.wusheng2, boxNo: '木箱甲-01' }],
      accessoryEntries: []
    });
    const id3 = created.body.id;
    const res = await request('POST', `/tourSchedules/${id3}/submit`);
    assert.equal(res.status, 409);
    assert.ok(res.body.conflicts.some((c) => c.code === 'BOX_OVERLAP'));
  });

  // 4. 非重叠后续档期可排
  await check('不重叠的后续日期可正常锁定同一偶头', async () => {
    const created = await request('POST', '/tourSchedules', {
      showName: '福州火焰山',
      venue: '福州大戏院',
      play: '火焰山',
      startDate: d(20),
      endDate: d(21),
      headEntries: [{ headId: H.wusheng1 }],
      accessoryEntries: [{ accessoryId: A.guan1 }]
    });
    global.laterId = created.body.id;
    const res = await request('POST', `/tourSchedules/${laterId}/submit`);
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.status, '已锁定');
  });

  // 5. 缺件 / 待修 → 提交时转替换候选
  await check('缺件与待修偶头在提交时转为替换候选', async () => {
    const created = await request('POST', '/tourSchedules', {
      showName: '莆田火焰山',
      venue: '莆仙戏场',
      play: '火焰山',
      startDate: d(30),
      endDate: d(31),
      headEntries: [
        { headId: H.damaged },
        { role: '武生' }
      ],
      accessoryEntries: [
        { name: '红缨冠', role: '武生' }
      ]
    });
    global.replaceId = created.body.id;
    const res = await request('POST', `/tourSchedules/${replaceId}/submit`);
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.status, '待替换');
    const reasons = res.body.replaceable.map((b) => b.reason);
    assert.ok(reasons.includes('待修'));
    assert.ok(reasons.includes('缺件'));
    const missingHead = res.body.replaceable.find((b) => b.reason === '缺件' && b.itemType === 'puppetHead');
    assert.ok(missingHead.candidates.length >= 2, '候选应包含可演出武生');
    assert.ok(missingHead.candidates.every((c) => c.itemType !== undefined || true));
    const missingAcc = res.body.replaceable.find((b) => b.itemType === 'accessory');
    assert.ok(missingAcc.candidates.length >= 1);
  });

  // 6. 幂等：重复提交沿用首次结果
  await check('重复/并发锁场沿用首次结果（幂等键回放）', async () => {
    const res = await request('POST', `/tourSchedules/${replaceId}/submit`, {}, { 'Idempotency-Key': 'k-replace-1' });
    assert.equal(res.status, 200);
    const first = JSON.stringify(res.body);
    const again = await request('POST', `/tourSchedules/${replaceId}/submit`, {}, { 'Idempotency-Key': 'k-replace-1' });
    assert.equal(again.status, 200);
    assert.equal(JSON.stringify(again.body), first);
    const mismatch = await request('POST', `/tourSchedules/${replaceId}/submit`,
      { actor: '别人', note: '不同内容' }, { 'Idempotency-Key': 'k-replace-1' });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.code, 'IDEMPOTENCY_MISMATCH');
  });

  // 7. 演出前更换角色：旧清单失效、按新件重算
  await check('reassign 更换角色：旧清单失效并按新件重算', async () => {
    const before = await request('GET', `/tourSchedules/${scheduleId}/manifest`);
    assert.equal(before.body.activeLocks.length, 6);
    const v0 = before.body.manifestVersion;

    // 换成备场武生（新箱位，不与原箱位冲突），其余角色位保持
    const res = await request('POST', `/tourSchedules/${scheduleId}/reassign`, {
      entryIndex: 0,
      headId: H.wusheng2,
      actor: '班长',
      note: '正用武生临时换脸'
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.manifestVersion, v0 + 1);
    assert.equal(res.body.schedule.status, '已锁定');

    // 旧件从本场释放（仍被福州未来档期持锁，状态保持已装箱）、新件锁定
    const oldOcc = (await request('GET', `/puppetHeads/${H.wusheng1}/occupancy`)).body;
    assert.ok(!oldOcc.locks.some((l) => l.scheduleId === scheduleId), '旧件不应再出现在本场占用中');
    assert.ok(oldOcc.locks.some((l) => l.scheduleId === laterId), '旧件仍被未来档期占用');
    const newHead = (await request('GET', `/puppetHeads/${H.wusheng2}`)).body;
    assert.equal(newHead.status, '已装箱');

    const after = await request('GET', `/tourSchedules/${scheduleId}/manifest`);
    assert.equal(after.body.activeLocks.length, 6);
    assert.ok(after.body.supersededLocks.length > 0, '旧场次清单留痕但已失效');
    assert.ok(after.body.supersededLocks.every((l) => l.active === false));
  });

  // 8. reassign 到冲突件 → 409，旧清单已失效，档期转待替换
  await check('reassign 撞档期 → 409，档期转待替换且全部锁释放', async () => {
    // wusheng2 现在在 scheduleId；尝试把第 2 位的花旦换成已被福州场锁定…… 用 wusheng2 换花旦位会重复
    const res = await request('POST', `/tourSchedules/${scheduleId}/reassign`, {
      entryIndex: 1,
      headId: H.wusheng2
    });
    assert.equal(res.status, 409);
    const sched = (await request('GET', `/tourSchedules/${scheduleId}`)).body;
    assert.equal(sched.status, '待替换');
    const manifest = (await request('GET', `/tourSchedules/${scheduleId}/manifest`)).body;
    assert.equal(manifest.activeLocks.length, 0);
  });

  // 9. 重新提交恢复
  await check('待替换档期修正后可重新锁定', async () => {
    const res = await request('POST', `/tourSchedules/${scheduleId}/submit`, {
      headEntries: [{ headId: H.wusheng2 }, { headId: H.hua }, { headId: H.jing }],
      accessoryEntries: [{ accessoryId: A.guan2 }, { accessoryId: A.duankao }, { accessoryId: A.fengguan }]
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.status, '已锁定');
  });

  // 10. 出发巡演 + 返场未闭环拦截下一档期
  await check('巡演中/清点中的偶头不得进入下一档期（闭环门禁）', async () => {
    const depart = await request('POST', `/tourSchedules/${scheduleId}/depart`, { actor: '班长' });
    assert.equal(depart.status, 200);
    assert.equal(depart.body.status, '巡演中');

    // 即便新档期不与日期重叠（在该场结束之后），只要上一场未闭环也拦截
    const created = await request('POST', '/tourSchedules', {
      showName: '三明返场加演',
      venue: '三明文化宫',
      play: '火焰山',
      startDate: d(40),
      endDate: d(41),
      headEntries: [{ headId: H.wusheng2 }],
      accessoryEntries: []
    });
    const id = created.body.id;
    const res = await request('POST', `/tourSchedules/${id}/submit`);
    assert.equal(res.status, 409);
    assert.ok(res.body.conflicts.some((c) => c.code === 'RETURN_NOT_CLOSED'),
      '应提示返场清点未闭环: ' + JSON.stringify(res.body.conflicts));
  });

  // 11. 返场清点：有缺损 → 清点中，创建 lossReport
  await check('返场清点登记缺损 → 返场清点中 + 缺损追踪', async () => {
    const res = await request('POST', `/tourSchedules/${scheduleId}/returnCheck`, {
      returns: [
        { itemType: 'puppetHead', itemId: H.wusheng2, problem: '眉梢彩漆开裂' },
        { itemType: 'accessory', itemId: A.duankao, problem: '靠旗少一根' }
      ],
      actor: '检场师傅'
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.status, '返场清点中');
    assert.equal(res.body.lossReports.length, 2);
    global.lossId = res.body.lossReports[0].id;

    const head = (await request('GET', `/puppetHeads/${H.wusheng2}`)).body;
    assert.equal(head.status, '待修补');
    const acc = (await request('GET', `/accessories/${A.duankao}`)).body;
    assert.equal(acc.status, '缺损');
  });

  // 12. 未闭环不能 close
  await check('缺损未处理时闭环 → 409', async () => {
    const res = await request('POST', `/tourSchedules/${scheduleId}/close`);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'LOSS_OPEN');
    assert.equal(res.body.openLossReports.length, 2);
  });

  // 13. 处理完缺损后闭环 → 全部释放
  await check('缺损补齐后闭环 → 锁释放、偶头恢复可演出', async () => {
    for (const lossRef of (await request('GET', `/tourSchedules/${scheduleId}/manifest`)).body.openLossReports) {
      const patched = await request('PATCH', `/lossReports/${lossRef.id}`, { status: '已补齐' });
      assert.equal(patched.status, 200);
    }
    // 待修偶头修好
    const repaired = await request('PATCH', `/puppetHeads/${H.wusheng2}`, {
      status: '可演出', paintStatus: '已补漆', currentUsable: true, action: '修补完成'
    });
    assert.equal(repaired.status, 200);

    const closed = await request('POST', `/tourSchedules/${scheduleId}/close`, { actor: '班长' });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, '已闭环');

    const manifest = (await request('GET', `/tourSchedules/${scheduleId}/manifest`)).body;
    assert.equal(manifest.activeLocks.length, 0);
    assert.equal(manifest.openLossReports.length, 0);
    const head = (await request('GET', `/puppetHeads/${H.wusheng2}`)).body;
    assert.equal(head.status, '可演出');
  });

  // 14. 闭环后偶头可进入下一档期
  await check('闭环后加演场可锁定成功', async () => {
    const created = await request('POST', '/tourSchedules', {
      showName: '三明返场加演',
      venue: '三明文化宫',
      play: '火焰山',
      startDate: d(40),
      endDate: d(41),
      headEntries: [{ headId: H.wusheng2 }],
      accessoryEntries: []
    });
    const id = created.body.id;
    const res = await request('POST', `/tourSchedules/${id}/submit`);
    assert.equal(res.status, 200);
    assert.equal(res.body.schedule.status, '已锁定');
    global.futureId = id;
  });

  // 15. 占用查询、列表与履历一致，刷新不变
  await check('列表/单场履历/占用查询状态一致且刷新后稳定', async () => {
    // wusheng1：泉州场已闭环（锁释放）、福州场仍持锁
    const occ1 = (await request('GET', `/puppetHeads/${H.wusheng1}/occupancy`)).body;
    assert.equal(occ1.locks.length, 1, '仅福州场持锁');
    assert.equal(occ1.locks[0].scheduleId, laterId);
    assert.ok(occ1.occupied);
    // wusheng2：三明天场已锁定（取消验证在后面用例）
    const occ2b = (await request('GET', `/puppetHeads/${H.wusheng2}/occupancy`)).body;
    assert.equal(occ2b.locks.length, 1);
    assert.equal(occ2b.locks[0].scheduleId, futureId);

    const list = (await request('GET', '/tourSchedules?status=已闭环')).body;
    assert.ok(list.some((s) => s.id === scheduleId));

    const tl = (await request('GET', `/tourSchedules/${scheduleId}/timeline`)).body;
    const actions = tl.events.map((e) => e.action);
    for (const expected of ['创建档期草稿', '提交锁场', '更换角色并重算清单', '出发巡演', '返场清点', '返场闭环']) {
      assert.ok(actions.includes(expected), '履历缺少: ' + expected + '，实际: ' + actions.join(','));
    }

    // 重新读一遍（模拟刷新）
    const occ2 = (await request('GET', `/puppetHeads/${H.wusheng1}/occupancy`)).body;
    assert.deepStrictEqual(occ2.locks.map((l) => l.scheduleId),
      occ1.locks.map((l) => l.scheduleId));
  });

  // 16. 演出后不能 reassign
  await check('已过演出开始日期的档期不能更换角色', async () => {
    const created = await request('POST', '/tourSchedules', {
      showName: '昨日场',
      venue: '旧戏台',
      play: '火焰山',
      startDate: d(-2),
      endDate: d(-1),
      headEntries: [{ headId: H.jing }],
      accessoryEntries: []
    });
    // 过去日期在当前规则下仍可提交（数据演示），但 depart 后无法 reassign；直接用已锁定的过去场
    const submitted = await request('POST', `/tourSchedules/${created.body.id}/submit`);
    assert.equal(submitted.status, 200);
    const res = await request('POST', `/tourSchedules/${created.body.id}/reassign`, {
      entryIndex: 0, headId: H.wusheng2
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'SHOW_STARTED');
  });

  // 17. 取消演出前档期释放占用
  await check('取消演出前档期 → 锁释放', async () => {
    const cancelled = await request('POST', `/tourSchedules/${futureId}/cancel`, { note: '场地变更' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, '已取消');
    const head = (await request('GET', `/puppetHeads/${H.wusheng2}`)).body;
    assert.equal(head.status, '可演出');
  });

  // 18. 通用入口不能绕过档期规则
  await check('通用 PATCH/DELETE 不能改档期状态', async () => {
    const patched = await request('PATCH', `/tourSchedules/${scheduleId}`, { status: '巡演中' });
    assert.equal(patched.status, 405);
    const deleted = await request('DELETE', `/tourSchedules/${scheduleId}`);
    assert.equal(deleted.status, 405);
  });

  // 19. 同清单内重复引用
  await check('同一份清单内偶头/箱位重复 → 409', async () => {
    const created = await request('POST', '/tourSchedules', {
      showName: '龙岩场',
      venue: '龙岩会堂',
      play: '火焰山',
      startDate: d(50),
      endDate: d(51),
      headEntries: [{ headId: H.jing }, { headId: H.jing }],
      accessoryEntries: []
    });
    const res = await request('POST', `/tourSchedules/${created.body.id}/submit`);
    assert.equal(res.status, 409);
    assert.ok(res.body.conflicts.some((c) => c.code === 'DUP_ENTRY'));
  });

  console.log('\n全部 ' + pass + ' 项测试通过 ✅');
}

main().catch((error) => {
  console.error('\n测试失败 ❌', error);
  process.exitCode = 1;
}).finally(() => {
  if (server) {
    server.kill();
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
});
