'use strict';

// 验证：1) 重启进程后锁/状态完全一致（持久化闭环）；2) 真并发提交同一件，只有一个成功。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const PORT = 3960;
const BASE = 'http://localhost:' + PORT + '/api';
const DB_DIR = path.join('/workspace', 'tmp-concurrency-db');
const DB_FILE = path.join(DB_DIR, 'c.db');

let server;
function start() {
  server = spawn(process.execPath, ['/workspace/server.js'], {
    env: { ...process.env, PORT: String(PORT), DB_DIR, DB_FILE },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', () => {});
}
function stop() {
  return new Promise((resolve) => {
    if (!server || server.killed) return resolve();
    server.on('exit', resolve);
    server.kill();
  });
}
async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch('http://localhost:' + PORT + '/health')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server not ready');
}
async function req(method, p, body, headers = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

(async () => {
  fs.rmSync(DB_DIR, { recursive: true, force: true });
  start();
  await waitHealthy();

  const d = (o) => { const t = new Date(); t.setDate(t.getDate() + o); return t.toISOString().slice(0, 10); };

  const created = await req('POST', '/tourSchedules', {
    showName: '重启验证场', venue: '草台', play: '火焰山',
    startDate: d(5), endDate: d(6),
    headEntries: [{ headId: 'head-seed-wusheng-1' }],
    accessoryEntries: [{ accessoryId: 'accessory-seed-1' }]
  });
  const sid = created.body.id;
  const submitted = await req('POST', `/tourSchedules/${sid}/submit`);
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.schedule.status, '已锁定');

  // 重启
  await stop();
  start();
  await waitHealthy();

  // 状态一致
  const after = await req('GET', `/tourSchedules/${sid}`);
  assert.equal(after.body.status, '已锁定', '重启后档期状态一致');
  const head = await req('GET', '/puppetHeads/head-seed-wusheng-1');
  assert.equal(head.body.status, '已装箱', '重启后偶头状态一致');
  const occ = await req('GET', '/puppetHeads/head-seed-wusheng-1/occupancy');
  assert.equal(occ.body.locks.length, 1, '重启后活动锁仍在');
  assert.equal(occ.body.locks[0].scheduleId, sid);

  // 重启后重叠档期仍被拒绝
  const other = await req('POST', '/tourSchedules', {
    showName: '重叠场', venue: '草台', play: '火焰山',
    startDate: d(6), endDate: d(7),
    headEntries: [{ headId: 'head-seed-wusheng-1' }], accessoryEntries: []
  });
  const conflict = await req('POST', `/tourSchedules/${other.body.id}/submit`);
  assert.equal(conflict.status, 409);
  console.log('  ✓ 重启后状态、锁、冲突判定全部一致');

  // 真并发：同一偶头、同一天、两个新档期同时提交
  const mk = (name) => req('POST', '/tourSchedules', {
    showName: name, venue: '草台', play: '火焰山',
    startDate: d(60), endDate: d(61),
    headEntries: [{ headId: 'head-seed-hua-1' }], accessoryEntries: []
  }).then((r) => r.body.id);
  const [idA, idB] = await Promise.all([mk('并发甲'), mk('并发乙')]);
  const [ra, rb] = await Promise.all([
    req('POST', `/tourSchedules/${idA}/submit`, {}, { 'Idempotency-Key': 'conc-A' }),
    req('POST', `/tourSchedules/${idB}/submit`, {}, { 'Idempotency-Key': 'conc-B' })
  ]);
  const codes = [ra.status, rb.status].sort().join(',');
  assert.equal(codes, '200,409', '并发锁场必须一成一败，实际: ' + codes);
  const winner = ra.status === 200 ? idA : idB;
  const loser = ra.status === 200 ? idB : idA;
  assert.equal((await req('GET', `/tourSchedules/${winner}`)).body.status, '已锁定');
  assert.equal((await req('GET', `/tourSchedules/${loser}`)).body.status, '草稿');
  const huaOcc = await req('GET', '/puppetHeads/head-seed-hua-1/occupancy');
  assert.equal(huaOcc.body.locks.length, 1, '并发后只有一条活动锁');
  console.log('  ✓ 真并发锁场：一成一败，锁不重复');

  // 同一幂等键并发两次：结果完全一致且只锁一次
  const mk2 = await req('POST', '/tourSchedules', {
    showName: '并发同键', venue: '草台', play: '火焰山',
    startDate: d(70), endDate: d(71),
    headEntries: [{ headId: 'head-seed-jing-1' }], accessoryEntries: []
  });
  const idC = mk2.body.id;
  const [c1, c2] = await Promise.all([
    req('POST', `/tourSchedules/${idC}/submit`, { actor: '甲' }, { 'Idempotency-Key': 'same-key-1' }),
    req('POST', `/tourSchedules/${idC}/submit`, { actor: '甲' }, { 'Idempotency-Key': 'same-key-1' })
  ]);
  assert.equal(c1.status, 200);
  assert.equal(c2.status, 200);
  assert.equal(c1.body.schedule.manifestVersion, c2.body.schedule.manifestVersion);
  const jingOcc = await req('GET', '/puppetHeads/head-seed-jing-1/occupancy');
  assert.equal(jingOcc.body.locks.length, 1, '同键并发只产生一次锁定');
  console.log('  ✓ 同键并发沿用首次结果，只锁一次');

  await stop();
  console.log('\n持久化与并发验证全部通过 ✅');
  process.exit(0);
})().catch(async (e) => {
  console.error('失败 ❌', e);
  await stop();
  process.exit(1);
});
