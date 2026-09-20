module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。',
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      statuses: ['可演出', '待修补', '修补中', '试演中', '不可演出', '已装箱'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '已装箱', '缺损', '遗失'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['puppetHeadId', 'repairType', 'handler'],
      titleFields: ['repairType', 'handler']
    },
    tourBoxes: {
      label: '巡演装箱单',
      defaultStatus: '草稿',
      statuses: ['草稿', '已装箱', '巡演中', '返场清点中', '已闭环'],
      required: ['showName', 'venue', 'play', 'headIds', 'accessoryIds'],
      titleFields: ['showName', 'play']
    },
    tourSchedules: {
      label: '巡演档期',
      defaultStatus: '草稿',
      statuses: ['草稿', '待替换', '已锁定', '巡演中', '返场清点中', '已闭环', '已取消'],
      required: ['showName', 'venue', 'play', 'startDate', 'endDate'],
      titleFields: ['showName', 'play']
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '已补齐', '确认为遗失'],
      required: ['tourBoxId', 'itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    }
  },
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-wusheng-1',
      status: '可演出',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '开口机关顺',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱甲-01',
        currentUsable: true
      },
      note: '武生正用偶头'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-wusheng-2',
      status: '可演出',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '眼珠转动顺',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱甲-02',
        currentUsable: true
      },
      note: '武生备场偶头'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-hua-1',
      status: '可演出',
      data: {
        role: '花旦',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '水袖联动正常',
        accessories: ['凤冠', '云肩'],
        boxNo: '木箱甲-03',
        currentUsable: true
      },
      note: '花旦正用偶头'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-jing-1',
      status: '可演出',
      data: {
        role: '净角',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '摇翎机关顺',
        accessories: ['黑满', '大靠'],
        boxNo: '木箱甲-05',
        currentUsable: true
      },
      note: '净角正用偶头'
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-2',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      },
      note: '红缨冠备件'
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-3',
      status: '在库',
      data: {
        name: '短靠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-03'
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-4',
      status: '在库',
      data: {
        name: '凤冠',
        role: '花旦',
        play: '火焰山',
        boxNo: '配件箱-01'
      }
    }
  ],
  examples: [
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/tourSchedules 创建巡演档期草稿（按日期+箱位锁定）',
    'POST /api/tourSchedules/:id/submit 提交锁场，缺件/待修转替换候选',
    'POST /api/tourSchedules/:id/reassign 演出前更换角色并重算清单',
    'POST /api/tourSchedules/:id/returnCheck 返场清点登记缺损',
    'POST /api/tourSchedules/:id/close 缺损闭环后释放占用',
    'GET /api/puppetHeads/:id/occupancy 查询偶头档期占用',
    'POST /api/lossReports 登记返场缺损或遗失'
  ]
};
