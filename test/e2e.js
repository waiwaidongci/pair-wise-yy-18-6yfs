const BASE = 'http://localhost:3914';
let pass = 0, fail = 0;

async function req(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' -> ' + JSON.stringify(extra) : '')); }
}

async function main() {
  console.log('1) 准备档案');
  async function ensureHead(boxNo, role) {
    const found = (await req('GET', '/api/puppetHeads?status=可演出')).body.find((h) => h.boxNo === boxNo);
    if (found) return found.id;
    return (await req('POST', '/api/puppetHeads', {
      role, play: '火焰山', paintStatus: '完好', mechanism: '正常', boxNo, currentUsable: true
    })).body.id;
  }
  async function ensureAcc(name) {
    const found = (await req('GET', '/api/accessories?status=在库')).body.find((a) => a.name === name);
    if (found) return found.id;
    return (await req('POST', '/api/accessories', {
      name, role: '武生', play: '火焰山', boxNo: name === '红缨冠甲' ? '配件箱-01' : '配件箱-03'
    })).body.id;
  }
  const h1 = await ensureHead('木箱甲-01', '武生');
  const h2 = await ensureHead('木箱甲-02', '武生');
  const h3 = await ensureHead('木箱甲-03', '花旦');
  const a1 = await ensureAcc('红缨冠甲');
  const a2 = await ensureAcc('红缨冠乙');
  const broken = (await req('GET', '/api/puppetHeads?status=待修补')).body[0];
  console.log('   可演出 h1/h2/h3, 配件 a1/a2, 待修=' + broken.id);

  console.log('2) 创建档期草稿 A（10-01/10-02，箱位 木箱甲-01）');
  const draftA = await req('POST', '/api/tourSchedules', {
    showName: '国庆火焰山', venue: '泉州戏院', play: '火焰山',
    showDates: ['2026-10-01', '2026-10-02'], boxNo: '木箱甲-01',
    headIds: [h1], accessoryIds: [a1], actor: '班主'
  });
  check('草稿创建 201', draftA.status === 201, draftA.body);
  check('状态为草稿', draftA.body.status === '草稿');
  const idA = draftA.body.id;

  console.log('3) 直接提交含待修件的档期 B -> 409 + 替换候选');
  const draftB = await req('POST', '/api/tourSchedules', {
    showName: '中秋场', venue: '厦门戏台', play: '火焰山',
    showDates: ['2026-10-03'], boxNo: '木箱乙-04',
    headIds: [broken.id], accessoryIds: [], actor: '班主'
  });
  const subB = await req('POST', '/api/tourSchedules/' + draftB.body.id + '/submit', { actor: '班主' });
  check('待修件提交 409', subB.status === 409, subB.body);
  check('code=ITEMS_UNAVAILABLE', subB.body.code === 'ITEMS_UNAVAILABLE');
  check('给出同角色替换候选',
    Array.isArray(subB.body.candidates) && subB.body.candidates[0] &&
    subB.body.candidates[0].replacement && subB.body.candidates[0].replacement.role === '武生',
    subB.body.candidates);
  check('失败后仍为草稿（无锁）', (await req('GET', '/api/tourSchedules/' + draftB.body.id)).body.status === '草稿');

  console.log('4) 确认候选后重新提交 B -> 锁定');
  const replId = subB.body.candidates[0].replacement.replacementId;
  const subB2 = await req('POST', '/api/tourSchedules/' + draftB.body.id + '/submit', {
    confirmedReplacements: [{ itemType: 'head', itemId: broken.id, replacementId: replId }],
    actor: '班主'
  });
  check('替换后提交 200', subB2.status === 200, subB2.body);
  check('状态已锁档', subB2.body.status === '已锁档');
  check('履历含提交替换', subB2.body.replacementHistory.some((r) => r.stage === '提交替换'));

  console.log('5) 档期 A 提交 -> 锁定 h1/a1 在 10-01、10-02');
  const subA = await req('POST', '/api/tourSchedules/' + idA + '/submit', { idempotencyKey: 'submit-A-1', actor: '班主' });
  check('A 提交 200', subA.status === 200, subA.body);
  check('manifestVersion=1', subA.body.manifestVersion === 1);

  console.log('6) 重复提交（同幂等键）沿用首次结果');
  const subA2 = await req('POST', '/api/tourSchedules/' + idA + '/submit', { idempotencyKey: 'submit-A-1', actor: '班主' });
  check('重复提交拿到首次 200 而非 NOT_DRAFT', subA2.status === 200 && subA2.body.status === '已锁档', subA2.body);

  console.log('7) 无幂等键重复提交 -> 409 NOT_DRAFT（不重复占用）');
  const subA3 = await req('POST', '/api/tourSchedules/' + idA + '/submit', { actor: '班主' });
  check('重复提交 409', subA3.status === 409 && subA3.body.code === 'NOT_DRAFT', subA3.body);

  console.log('8) 重叠档期 C：同件 h1 同日 10-01 -> 409 SCHEDULE_CONFLICT');
  const draftC = await req('POST', '/api/tourSchedules', {
    showName: '撞期场', venue: '漳州', play: '火焰山',
    showDates: ['2026-10-01'], boxNo: '木箱丙-01', headIds: [h1], accessoryIds: []
  });
  const subC = await req('POST', '/api/tourSchedules/' + draftC.body.id + '/submit', {});
  check('同件同日冲突 409', subC.status === 409 && subC.body.code === 'SCHEDULE_CONFLICT', subC.body);
  check('冲突明细指向 A', subC.body.conflicts.some((c) => c.otherScheduleId === idA && c.itemId === h1));

  console.log('9) 同箱同档冲突：D 用别的偶头但箱位 木箱甲-01 日期 10-01 -> 409');
  const draftD = await req('POST', '/api/tourSchedules', {
    showName: '撞箱场', venue: '泉州', play: '火焰山',
    showDates: ['2026-10-01'], boxNo: '木箱甲-01', headIds: [h2], accessoryIds: []
  });
  const subD = await req('POST', '/api/tourSchedules/' + draftD.body.id + '/submit', {});
  check('同箱同档冲突 409', subD.status === 409 && subD.body.code === 'SCHEDULE_CONFLICT', subD.body);

  console.log('10) 并发提交两个档期抢 h2 同日 -> 一个成功一个冲突，无重复锁');
  const E = (await req('POST', '/api/tourSchedules', {
    showName: '并发E', venue: '地1', play: '火焰山',
    showDates: ['2026-11-01'], boxNo: '木箱丁-01', headIds: [h2], accessoryIds: []
  })).body.id;
  const F = (await req('POST', '/api/tourSchedules', {
    showName: '并发F', venue: '地2', play: '火焰山',
    showDates: ['2026-11-01'], boxNo: '木箱丁-02', headIds: [h2], accessoryIds: []
  })).body.id;
  const [rE, rF] = await Promise.all([
    req('POST', '/api/tourSchedules/' + E + '/submit', { idempotencyKey: 'e', actor: 'x' }),
    req('POST', '/api/tourSchedules/' + F + '/submit', { idempotencyKey: 'f', actor: 'x' })
  ]);
  const codes = [rE, rF].map((r) => r.status);
  check('并发一成一败', codes.sort().join(',') === '200,409', codes);
  // 同幂等键并发重放
  const [e2, e3] = await Promise.all([
    req('POST', '/api/tourSchedules/' + E + '/submit', { idempotencyKey: 'e', actor: 'x' }),
    req('POST', '/api/tourSchedules/' + E + '/submit', { idempotencyKey: 'e', actor: 'x' })
  ]);
  check('并发同键沿用首次结果', e2.status === 200 && e3.status === 200);

  console.log('11) 演出前换角：A 的 h1 -> h2，旧清单失效按新件重算');
  // h2 在 11-01 被 E 占，但 A 是 10-01/02，不冲突
  const swap = await req('POST', '/api/tourSchedules/' + idA + '/swap', {
    itemType: 'head', fromItemId: h1, toItemId: h2, reason: '演员调整', actor: '班主'
  });
  check('换角 200', swap.status === 200, swap.body);
  check('manifestVersion 升到 2', swap.body.manifestVersion === 2, swap.body.manifestVersion);
  check('履历含演前换角', swap.body.replacementHistory.some((r) => r.stage === '演前换角'));
  const manifest = await req('GET', '/api/tourSchedules/' + idA + '/manifest');
  check('活动锁已换成 h2 且无 h1',
    manifest.body.activeLocks.every((l) => l.itemType === 'head' ? l.itemId === h2 : true) &&
    manifest.body.activeLocks.some((l) => l.itemId === h2),
    manifest.body.activeLocks.map((l) => l.itemId));
  check('锁版本全部为 2', manifest.body.activeLocks.every((l) => l.manifestVersion === 2));
  // h1 现在空出来，C 再提交应成功
  const subC2 = await req('POST', '/api/tourSchedules/' + draftC.body.id + '/submit', {});
  check('换角释放 h1 后 C 可锁', subC2.status === 200, subC2.body);

  console.log('12) 占用查询：h2 被 A(10/01,02) 与 E(11/01) 占用，h1 被 C(10/01) 占用');
  const occH2 = await req('GET', '/api/occupancy/head/' + h2);
  check('h2 状态=档期占用', occH2.body.occupancy.status === '档期占用', occH2.body.occupancy);
  check('h2 两条阻挡档期', occH2.body.occupancy.blockers.length >= 3); // 6 locks: A×2 + E×1
  const occList = await req('GET', '/api/occupancy/head?date=2026-10-01');
  check('10-01 列表中 h1/h2 占用、h3 空闲',
    occList.body.find((x) => x.id === h1).occupancy === '档期占用' &&
    occList.body.find((x) => x.id === h2).occupancy === '档期占用' &&
    occList.body.find((x) => x.id === h3).occupancy === '空闲',
    occList.body.map((x) => [x.name, x.occupancy]));

  console.log('13) 未闭环件不能进下一档期：尝试把 h2 锁到 10-02 已占');
  const G = (await req('POST', '/api/tourSchedules', {
    showName: '拦截场', venue: '地', play: '火焰山',
    showDates: ['2026-10-02'], boxNo: '木箱戊-01', headIds: [h2], accessoryIds: []
  })).body.id;
  const subG = await req('POST', '/api/tourSchedules/' + G + '/submit', {});
  check('占用期拦截 409', subG.status === 409);

  console.log('14) A 返场流程：出发 -> 返场清点（h2 缺损）-> 未闭环前 h2 仍锁定');
  const disp = await req('POST', '/api/tourSchedules/' + idA + '/dispatch', { idempotencyKey: 'd1', actor: '班主' });
  check('出发巡演 200', disp.status === 200 && disp.body.status === '巡演中', disp.body);
  const ci = await req('POST', '/api/tourSchedules/' + idA + '/checkin', {
    idempotencyKey: 'ci1', actor: '班主',
    losses: [{ itemType: 'head', itemId: h2, itemName: '武生B', problem: '左颊掉彩' }]
  });
  check('返场清点 200 状态=返场清点中', ci.status === 200 && ci.body.status === '返场清点中', ci.body);
  const occH2b = await req('GET', '/api/occupancy/head/' + h2);
  check('清点未闭环 h2=返场未闭环', occH2b.body.occupancy.status === '返场未闭环', occH2b.body.occupancy);
  const subG2 = await req('POST', '/api/tourSchedules/' + G + '/submit', {});
  check('未闭环仍不能进下一档期 409', subG2.status === 409);
  // h2 档案被标记待修
  const h2rec = await req('GET', '/api/puppetHeads/' + h2);
  check('h2 档案转待修补', h2rec.body.status === '待修补', h2rec.body.status);

  console.log('15) 闭环后释放占用，h2 档案仍待修（需走修补），h1/a1 可进新档期');
  const close = await req('POST', '/api/tourSchedules/' + idA + '/close', { idempotencyKey: 'c1', actor: '班主' });
  check('闭环 200 状态=已闭环', close.status === 200 && close.body.status === '已闭环', close.body);
  const occH2c = await req('GET', '/api/occupancy/head/' + h2);
  // h2 同时是 B 的提交替换件（10-03）与 E 的锁件（11-01）；A 的 10-01/02 必须已释放
  check('A 锁释放（h2 阻挡中不再含 A 的 10-01/10-02）',
    occH2c.body.occupancy.status === '档期占用' &&
    occH2c.body.occupancy.blockers.every((b) => b.scheduleId !== idA),
    occH2c.body.occupancy);
  const subG3 = await req('POST', '/api/tourSchedules/' + G + '/submit', {});
  check('h2 待修不可直接用，给替换候选 409', subG3.status === 409 && subG3.body.code === 'ITEMS_UNAVAILABLE', subG3.body);

  console.log('16) 用 h1 走新档期 10-02 -> 成功（旧占用已清）');
  const H = (await req('POST', '/api/tourSchedules', {
    showName: '补位场', venue: '地', play: '火焰山',
    showDates: ['2026-10-02'], boxNo: '木箱戊-02', headIds: [h1], accessoryIds: [a2]
  })).body.id;
  const subH = await req('POST', '/api/tourSchedules/' + H + '/submit', {});
  check('闭环后 h1 可进新档期 200', subH.status === 200, subH.body);

  console.log('17) 履历：单件 scheduleHistory 含各版本（失效锁 active=0 也留痕）');
  const hist = await req('GET', '/api/occupancy/head/' + h2);
  const aRows = hist.body.scheduleHistory.filter((x) => x.scheduleId === idA);
  check('h2 履历含 A 的 v2 两条（10-01/10-02，均已随闭环失效）',
    aRows.length === 2 && aRows.every((x) => x.manifestVersion === 2 && x.active === 0),
    hist.body.scheduleHistory.map((x) => x.manifestVersion + ':' + x.active));
  check('h2 履历另含 B 替换锁(10-03) 与 E(11-01)',
    hist.body.scheduleHistory.some((x) => x.scheduleId === draftB.body.id && x.showDate === '2026-10-03') &&
    hist.body.scheduleHistory.some((x) => x.showDate === '2026-11-01'));
  // h1 视角应能看到 A 的 v1（失效）与 C 的锁
  const histH1 = await req('GET', '/api/occupancy/head/' + h1);
  const h1a = histH1.body.scheduleHistory.filter((x) => x.scheduleId === idA);
  check('h1 履历保留 A 旧版 v1 失效痕迹',
    h1a.length === 2 && h1a.every((x) => x.manifestVersion === 1 && x.active === 0),
    h1a.map((x) => x.manifestVersion + ':' + x.active));

  console.log('18) 刷新后状态一致：演出待开场自动派生');
  const past = (await req('POST', '/api/tourSchedules', {
    showName: '过去场', venue: '地', play: '火焰山',
    showDates: ['2026-09-19'], boxNo: '木箱己-01', headIds: [h3], accessoryIds: []
  })).body.id;
  await req('POST', '/api/tourSchedules/' + past + '/submit', {});
  const v1 = await req('GET', '/api/tourSchedules/' + past);
  const v2 = await req('GET', '/api/tourSchedules?status=' + encodeURIComponent('演出待开场'));
  check('单查自动派生演出待开场', v1.body.status === '演出待开场', v1.body.status);
  check('列表筛选同样派生', Array.isArray(v2.body) && v2.body.some((s) => s.id === past));

  console.log('19) 列表/单场/刷新视图一致（manifestVersion 与占用）');
  const lst = await req('GET', '/api/tourSchedules');
  const inList = lst.body.find((s) => s.id === idA);
  check('列表中 A=已闭环 且版本保留', inList.status === '已闭环' && inList.manifestVersion === 2);
  const mA = await req('GET', '/api/tourSchedules/' + idA + '/manifest');
  check('A 活动锁已清空', mA.body.activeLocks.length === 0);
  check('A 时间线含完整流转',
    ['创建', '提交锁场', '演出前更换', '出发巡演', '返场清点', '返场清点闭环']
      .every((a) => mA.body.timeline.some((e) => e.action === a)),
    mA.body.timeline.map((e) => e.action));

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
