// 核心业务逻辑：sql.js 数据库 + 运费计算 + 配置导入导出
// 不依赖 Electron，桌面端（main.js）与局域网服务（server.mjs）共用这一份实现
const fs = require('fs');

const DEFAULT_VOL_DIVISOR = 6000;

// 附加费可判断的字段
const FIELD_LABELS = {
  weight: '实重 (KG)',
  charged_weight: '计费重 (KG)',
  girth: '围长 (CM)',
  longest: '最长边 (CM)',
  second_longest: '次长边 (CM)',
  shortest: '最短边 (CM)',
  volume: '体积 (CM³)',
};

// 附加费行为（6 种，可逐条规则配置）
const COMBINE_MODE_LABELS = {
  add: '叠加（与其他 叠加 组求和）',
  not_stack: '不叠加（自身累加，但不会让 叠加 组失效）',
  max: '不叠加取最大值（命中时只收本类最高，叠加组全部不收）',
  cardispatch: '卡派（卡车派送费，独立累加，不受 max 影响）',
  notice: '提醒（不收钱，仅提示）',
  reject: '拒收（达到即不收货，结算时直接报错）',
};

// 目的地分组：mode=zip 按邮编匹配，mode=country 直接选择地区/国家
// 起算重量：单箱时按 minWeightSingle，多箱时每个箱按 minWeightPerBox
const GROUP_META = [
  { key: 'us', name: '美国', mode: 'zip', surchargeMode: 'stack', minWeightSingle: 10, minWeightPerBox: 10 },
  { key: 'eu', name: '欧洲', mode: 'country', surchargeMode: 'max', minWeightSingle: 10, minWeightPerBox: 10 },
  { key: 'ca', name: '加拿大', mode: 'country', surchargeMode: 'stack', minWeightSingle: 10, minWeightPerBox: 10 },
  { key: 'uk', name: '英国', mode: 'country', surchargeMode: 'stack', minWeightSingle: 10, minWeightPerBox: 10 },
  { key: 'au', name: '澳大利亚', mode: 'country', surchargeMode: 'stack', minWeightSingle: 10, minWeightPerBox: 10 },
];

// 出厂默认数据（新库写入，也用于“恢复默认数据”）
const DEFAULT_DATA = {
  us: {
    tiers: [10, 21, 71, 101],
    rows: [
      { name: '美西（邮编8,9开头）', matchKey: '8,9', prices: [16.7, 15.2, 13.2, 12.2] },
      { name: '美中（邮编4,5,6,7开头）', matchKey: '4,5,6,7', prices: [17.7, 16.2, 14.2, 13.2] },
      { name: '美东（邮编0,1,2,3开头）', matchKey: '0,1,2,3', prices: [18.7, 17.2, 15.2, 14.2] },
    ],
    rules: [
      { rule_group: '实重', field: 'weight', threshold: 22.5, amount: 120, combine_mode: 'add', enabled: 1 },
      { rule_group: '围长', field: 'girth', threshold: 265, amount: 120, combine_mode: 'add', enabled: 1 },
      { rule_group: '单边', field: 'longest', threshold: 120, amount: 120, combine_mode: 'add', enabled: 1 },
      { rule_group: '单边', field: 'second_longest', threshold: 75, amount: 120, combine_mode: 'add', enabled: 1 },
      { rule_group: '超大件', field: 'girth', threshold: 330, amount: 500, combine_mode: 'max', enabled: 1 },
      { rule_group: '超大件', field: 'volume', threshold: 283168, amount: 500, combine_mode: 'max', enabled: 1 },
      { rule_group: '超大件', field: 'weight', threshold: 50, amount: 500, combine_mode: 'max', enabled: 1 },
    ],
  },
  eu: {
    tiers: [10, 21, 101],
    rows: [
      { name: 'Germany 德国', prices: [15.5, 15.0, 15.0] },
      { name: 'Poland, Belgium, Luxembourg 波兰、比利时、卢森堡', prices: [18.0, 18.0, 17.0] },
      { name: 'Czech Republic, Slovakia, Austria, Hungary 捷克、斯洛伐克、奥地利、匈牙利', prices: [18.0, 18.0, 17.5] },
      { name: 'France 法国', prices: [18.5, 18.0, 17.0] },
      { name: 'Netherlands, Denmark, Estonia, Lithuania, Monaco, Latvia, Spain(except islands), Italy(except islands) 荷兰、丹麦、爱沙尼亚、立陶宛、摩纳哥、拉脱维亚、西班牙(岛屿除外)、意大利(岛屿除外)', prices: [19.0, 19.0, 18.0] },
      { name: 'Slovenia, Croatia, Finland, Sweden, Bulgaria 斯洛文利亚、克罗地亚、芬兰、瑞典、保加利亚', prices: [19.5, 19.0, 19.0] },
      { name: 'Greece, Ireland, Portugal 希腊、爱尔兰、葡萄牙', prices: [21.0, 21.0, 20.0] },
    ],
    rules: [
      { rule_group: '围长330', field: 'girth', threshold: 330, amount: 350, combine_mode: 'max', enabled: 1 },
      { rule_group: '围长300', field: 'girth', threshold: 300, amount: 300, combine_mode: 'max', enabled: 1 },
      { rule_group: '实重30', field: 'weight', threshold: 30, amount: 300, combine_mode: 'max', enabled: 1 },
    ],
  },
  ca: {
    tiers: [10, 21, 101],
    rows: [{ name: '加拿大 Canada', prices: [0, 0, 0] }],
    rules: [
      { rule_group: '①实重', field: 'weight', threshold: 22, amount: 130, combine_mode: 'add' },
      { rule_group: '②单边', field: 'longest', threshold: 121, amount: 130, combine_mode: 'add' },
      { rule_group: '②单边', field: 'second_longest', threshold: 75, amount: 130, combine_mode: 'add' },
      { rule_group: '③围长', field: 'girth', threshold: 265, amount: 130, combine_mode: 'add' },
      { rule_group: '④超大件', field: 'girth', threshold: 320, amount: 700, combine_mode: 'max' },
      { rule_group: '④超大件', field: 'weight', threshold: 40, amount: 700, combine_mode: 'max' },
      { rule_group: '⑤不收货', field: 'weight', threshold: 68, amount: 0, combine_mode: 'reject' },
      { rule_group: '⑤不收货', field: 'longest', threshold: 151, amount: 0, combine_mode: 'reject' },
      { rule_group: '⑤不收货', field: 'girth', threshold: 400, amount: 0, combine_mode: 'reject' },
    ],
  },
  uk: {
    tiers: [10, 21, 101],
    rows: [{ name: '英国 United Kingdom', prices: [0, 0, 0] }],
    rules: [
      { rule_group: '①实重30-40', field: 'weight', threshold: 30, threshold_max: 40, amount: 330, combine_mode: 'add' },
      { rule_group: '②③尺寸', field: 'longest', threshold: 100, threshold_max: 150, amount: 300, combine_mode: 'add' },
      { rule_group: '②③尺寸', field: 'second_longest', threshold: 70, threshold_max: 100, amount: 300, combine_mode: 'add' },
      { rule_group: '②③尺寸', field: 'shortest', threshold: 60, threshold_max: 100, amount: 300, combine_mode: 'add' },
      { rule_group: '②③尺寸', field: 'girth', threshold: 300, threshold_max: 400, amount: 300, combine_mode: 'add' },
    ],
  },
  au: {
    tiers: [10, 21, 101],
    rows: [{ name: '澳大利亚 Australia', prices: [0, 0, 0] }],
    rules: [
      { rule_group: '计费重≥30', field: 'charged_weight', threshold: 30, threshold_max: 35, amount: 100, combine_mode: 'add' },
      { rule_group: '计费重≥35', field: 'charged_weight', threshold: 35, threshold_max: 80, amount: 300, combine_mode: 'add' },
      { rule_group: '计费重≥80', field: 'charged_weight', threshold: 80, amount: 300, combine_mode: 'add' },
      { rule_group: '单边120-199', field: 'longest', threshold: 120, threshold_max: 200, amount: 100, combine_mode: 'add' },
      { rule_group: '单边200-299', field: 'longest', threshold: 200, threshold_max: 300, amount: 200, combine_mode: 'add' },
      { rule_group: '木托盘提醒', field: 'weight', threshold: 30, amount: 0, combine_mode: 'notice' },
    ],
  },
};

let db = null;
let SQL = null;
let DB_FILE = null;

// 在使用前必须调用一次：传入 sql.js 的 SQL 对象与数据库文件路径
function initCore({ dbFile, SQL: sqlInstance }) {
  DB_FILE = dbFile;
  SQL = sqlInstance;
  initDb();
}

// ---------- 工具 ----------
function toNum(value, fallback) {
  const n = Number(value);
  return value === '' || value === null || value === undefined || isNaN(n) ? fallback : n;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function rowsToObjects(result) {
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(v =>
    v.reduce((obj, val, i) => {
      obj[columns[i]] = val;
      return obj;
    }, {})
  );
}

function tableExists(name) {
  return db.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${name}'`).length > 0;
}

function lastId() {
  return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
}

function getSetting(key, fallback) {
  const rows = db.exec(`SELECT value FROM settings WHERE key = '${key}'`);
  if (!rows.length) return fallback;
  const value = rows[0].values[0][0];
  return value === null || value === undefined ? fallback : value;
}

function setSetting(key, value) {
  db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}

// ---------- 建库 / 迁移 ----------
function initDb() {
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
    ensureSchema();
    ensureTiers(); // 先把报价阶梯补齐，旧数据才有地方落位
    migrateLegacy(); // 把旧版 us_rates / eu_rates / 附加费配置搬到通用表
    ensureGroupData(); // 补齐缺少的地区行与附加费规则
    ensureSurchargeDefaults(); // 给加/英/澳写入官方附加费规则（仅首次升级时）
    saveDb();
  } else {
    db = new SQL.Database();
    ensureSchema();
    seedData();
    ensureSurchargeDefaults();
    saveDb();
  }
}

// 加拿大/英国/澳大利亚的附加费规则：老库升级时一次性写入（用户后来自己改过的以 rules_v2 标记为准，不再覆盖）
function ensureSurchargeDefaults() {
  ['ca', 'uk', 'au'].forEach(key => {
    if (getSetting('rules_v2_' + key, null) !== null) return;
    if (getRules(key).length === 0) {
      DEFAULT_DATA[key].rules.forEach(rule => insertRule(key, rule));
    }
    setSetting('rules_v2_' + key, '1');
  });
}

function ensureSchema() {
  if (!tableExists('settings')) {
    db.run(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  if (!tableExists('rate_tiers')) {
    db.run(`CREATE TABLE rate_tiers (
      id INTEGER PRIMARY KEY,
      group_key TEXT NOT NULL,
      min_weight REAL NOT NULL,
      label TEXT NOT NULL
    );`);
  }
  if (!tableExists('rate_rows')) {
    db.run(`CREATE TABLE rate_rows (
      id INTEGER PRIMARY KEY,
      group_key TEXT NOT NULL,
      row_name TEXT NOT NULL,
      match_key TEXT
    );`);
  }
  if (!tableExists('rate_values')) {
    db.run(`CREATE TABLE rate_values (
      row_id INTEGER NOT NULL,
      tier_id INTEGER NOT NULL,
      price REAL NOT NULL,
      PRIMARY KEY (row_id, tier_id)
    );`);
  }
  if (!tableExists('surcharge_rules')) {
    db.run(`CREATE TABLE surcharge_rules (
      id INTEGER PRIMARY KEY,
      group_key TEXT NOT NULL,
      rule_group TEXT NOT NULL,
      field TEXT NOT NULL,
      threshold REAL NOT NULL,
      threshold_max REAL,
      amount REAL NOT NULL,
      combine_mode TEXT NOT NULL DEFAULT 'add',
      enabled INTEGER NOT NULL DEFAULT 1
    );`);
  } else {
    // 旧库升级：补上限列，再把 kind / exclusive + 国家级叠加方式迁移成 combine_mode
    const cols = db.exec('PRAGMA table_info(surcharge_rules)')[0].values.map(v => v[1]);
    if (!cols.includes('threshold_max')) {
      db.run(`ALTER TABLE surcharge_rules ADD COLUMN threshold_max REAL`);
    }
    if (!cols.includes('combine_mode')) {
      db.run(`ALTER TABLE surcharge_rules ADD COLUMN combine_mode TEXT NOT NULL DEFAULT 'add'`);
      GROUP_META.forEach(group => {
        const legacyMode = getSetting('surcharge_mode_' + group.key, group.surchargeMode);
        rowsToObjects(
          db.exec(`SELECT id, kind, exclusive FROM surcharge_rules WHERE group_key = '${group.key}'`)
        ).forEach(r => {
          let mode = 'add';
          if (r.kind === 'reject') mode = 'reject';
          else if (r.kind === 'notice') mode = 'notice';
          else if (r.kind === 'oversize' || Number(r.exclusive) === 1) mode = 'max';
          else if (legacyMode === 'max') mode = 'max';
          db.run(`UPDATE surcharge_rules SET combine_mode = ? WHERE id = ?`, [mode, r.id]);
        });
      });
    }
  }
}

function saveDb() {
  if (!db) return;
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function insertTier(groupKey, minWeight) {
  db.run(`INSERT INTO rate_tiers (group_key, min_weight, label) VALUES (?, ?, ?)`, [
    groupKey,
    Number(minWeight),
    `${Number(minWeight)}KG+`,
  ]);
  return lastId();
}

function insertRateRow(groupKey, name, matchKey) {
  db.run(`INSERT INTO rate_rows (group_key, row_name, match_key) VALUES (?, ?, ?)`, [
    groupKey,
    name,
    matchKey || null,
  ]);
  return lastId();
}

function insertValue(rowId, tierId, price) {
  db.run(
    `INSERT INTO rate_values (row_id, tier_id, price) VALUES (?, ?, ?)
     ON CONFLICT(row_id, tier_id) DO UPDATE SET price = excluded.price`,
    [rowId, tierId, toNum(price, 0)]
  );
}

function insertRule(groupKey, rule) {
  const combineMode = COMBINE_MODE_LABELS[rule.combine_mode] ? rule.combine_mode : 'add';
  const thresholdMax =
    rule.threshold_max === '' || rule.threshold_max === null || rule.threshold_max === undefined
      ? null
      : toNum(rule.threshold_max, null);
  db.run(
    `INSERT INTO surcharge_rules (group_key, rule_group, field, threshold, threshold_max, amount, combine_mode, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      groupKey,
      rule.rule_group || '规则',
      FIELD_LABELS[rule.field] ? rule.field : 'weight',
      toNum(rule.threshold, 0),
      thresholdMax,
      toNum(rule.amount, 0),
      combineMode,
      rule.enabled === undefined ? 1 : Number(rule.enabled) === 1 ? 1 : 0,
    ]
  );
  return lastId();
}

// 补齐每个目的地的报价阶梯（缺失才补，已改过的原样保留）
function ensureTiers() {
  GROUP_META.forEach(group => {
    if (getTiers(group.key).length === 0) {
      DEFAULT_DATA[group.key].tiers.forEach(minWeight => insertTier(group.key, minWeight));
    }
  });
}

// 补齐每个目的地的地区行与附加费规则
function ensureGroupData() {
  GROUP_META.forEach(group => {
    const data = DEFAULT_DATA[group.key];
    const tiers = getTiers(group.key);

    if (getRateRows(group.key).length === 0) {
      data.rows.forEach(row => {
        const rowId = insertRateRow(group.key, row.name, row.matchKey);
        row.prices.forEach((price, i) => {
          if (tiers[i]) insertValue(rowId, tiers[i].id, price);
        });
      });
    } else {
      // 老库搬过来的行：把缺失的价格单元格补成 0，保证表格完整
      const values = getRateValues(group.key);
      getRateRows(group.key).forEach(row => {
        tiers.forEach(tier => {
          if (!values.some(v => v.row_id === row.id && v.tier_id === tier.id)) {
            insertValue(row.id, tier.id, 0);
          }
        });
      });
    }

    if (getSetting('seeded_' + group.key, null) === null) {
      if (getRules(group.key).length === 0) data.rules.forEach(rule => insertRule(group.key, rule));
      setSetting('seeded_' + group.key, '1');
    }

    // 起算重量：单箱起算 / 多箱每箱起算（缺失才写默认值）
    if (getSetting('min_weight_single_' + group.key, null) === null) {
      setSetting('min_weight_single_' + group.key, group.minWeightSingle);
    }
    if (getSetting('min_weight_per_box_' + group.key, null) === null) {
      setSetting('min_weight_per_box_' + group.key, group.minWeightPerBox);
    }
  });
}

// 最低计费重（起算）：只有一箱时用「单箱起算」，多箱时每个箱各按「多箱起算」
function getMinWeight(groupKey, boxCount) {
  const meta = GROUP_META.find(g => g.key === groupKey);
  const isMulti = boxCount > 1;
  const settingKey = 'min_weight_' + (isMulti ? 'per_box_' : 'single_') + groupKey;
  const fallback = isMulti ? meta.minWeightPerBox : meta.minWeightSingle;
  const value = toNum(getSetting(settingKey, fallback), fallback);
  return value > 0 ? value : 0;
}

function seedData() {
  setSetting('vol_divisor', DEFAULT_VOL_DIVISOR);
  ensureTiers();
  ensureGroupData();
}

// 老库升级：旧表数据搬到新表，已有的自定义价格原样保留
function migrateLegacy() {
  if (tableExists('us_rates') && getRateRows('us').length === 0) {
    const tiers = getTiers('us');
    rowsToObjects(db.exec('SELECT * FROM us_rates ORDER BY id')).forEach(r => {
      const rowId = insertRateRow('us', r.region_name, r.zip_prefixes);
      [r.weight_10, r.weight_21, r.weight_71, r.weight_101].forEach((price, i) => {
        if (tiers[i]) insertValue(rowId, tiers[i].id, price);
      });
    });
  }

  if (tableExists('eu_rates') && getRateRows('eu').length === 0) {
    const tiers = getTiers('eu');
    rowsToObjects(db.exec('SELECT * FROM eu_rates ORDER BY id')).forEach(r => {
      const rowId = insertRateRow('eu', r.country_name, null);
      [r.weight_10, r.weight_21, r.weight_101].forEach((price, i) => {
        if (tiers[i]) insertValue(rowId, tiers[i].id, price);
      });
    });
  }

  if (tableExists('us_surcharge_config') && getRules('us').length === 0) {
    const c = rowsToObjects(db.exec('SELECT * FROM us_surcharge_config WHERE id = 1'))[0];
    if (c) {
      const fee = threshold => toNum(threshold, 0);
      insertRule('us', { rule_group: '实重', field: 'weight', threshold: c.weight_threshold, amount: c.weight_fee });
      insertRule('us', { rule_group: '围长', field: 'girth', threshold: c.girth_threshold, amount: c.girth_fee });
      insertRule('us', { rule_group: '单边', field: 'longest', threshold: c.side_long_threshold, amount: c.side_fee });
      insertRule('us', { rule_group: '单边', field: 'second_longest', threshold: c.side_second_threshold, amount: c.side_fee });
      insertRule('us', { rule_group: '超大件', field: 'girth', threshold: c.oversize_girth, amount: c.oversize_fee, exclusive: 1 });
      insertRule('us', { rule_group: '超大件', field: 'volume', threshold: c.oversize_volume, amount: c.oversize_fee, exclusive: 1 });
      insertRule('us', { rule_group: '超大件', field: 'weight', threshold: fee(c.oversize_weight), amount: c.oversize_fee, exclusive: 1 });
    }
  }

  if (tableExists('eu_surcharge_rules') && getRules('eu').length === 0) {
    rowsToObjects(db.exec('SELECT * FROM eu_surcharge_rules ORDER BY id')).forEach(r => {
      insertRule('eu', {
        rule_group: `${r.rule_type === 'girth' ? '围长' : '实重'}${r.threshold}`,
        field: r.rule_type,
        threshold: r.threshold,
        amount: r.amount,
        enabled: r.enabled,
      });
    });
  }

  if (!db.exec(`SELECT value FROM settings WHERE key = 'vol_divisor'`).length) {
    setSetting('vol_divisor', DEFAULT_VOL_DIVISOR);
  }
}

// ---------- 查询 ----------
function getTiers(groupKey) {
  return rowsToObjects(
    db.exec(`SELECT * FROM rate_tiers WHERE group_key = '${groupKey}' ORDER BY min_weight ASC, id ASC`)
  );
}

function getRateRows(groupKey) {
  return rowsToObjects(db.exec(`SELECT * FROM rate_rows WHERE group_key = '${groupKey}' ORDER BY id ASC`));
}

function getRateValues(groupKey) {
  return rowsToObjects(
    db.exec(
      `SELECT v.* FROM rate_values v
       JOIN rate_rows r ON r.id = v.row_id
       WHERE r.group_key = '${groupKey}'`
    )
  );
}

function getRules(groupKey) {
  return rowsToObjects(
    db.exec(
      `SELECT id, group_key, rule_group, field, threshold, threshold_max, amount, combine_mode, enabled
       FROM surcharge_rules WHERE group_key = '${groupKey}' ORDER BY id ASC`
    )
  );
}

function getGroupConfig(groupKey) {
  const meta = GROUP_META.find(g => g.key === groupKey);
  const tiers = getTiers(groupKey);
  const rows = getRateRows(groupKey);
  const values = getRateValues(groupKey);
  return {
    ...meta,
    minWeightSingle: toNum(getSetting('min_weight_single_' + groupKey, meta.minWeightSingle), meta.minWeightSingle),
    minWeightPerBox: toNum(getSetting('min_weight_per_box_' + groupKey, meta.minWeightPerBox), meta.minWeightPerBox),
    tiers,
    rows: rows.map(row => ({
      ...row,
      prices: tiers.reduce((acc, tier) => {
        const v = values.find(x => x.row_id === row.id && x.tier_id === tier.id);
        acc[tier.id] = v ? v.price : 0;
        return acc;
      }, {}),
    })),
    rules: getRules(groupKey),
  };
}

function getConfig() {
  return {
    volDivisor: toNum(getSetting('vol_divisor', DEFAULT_VOL_DIVISOR), DEFAULT_VOL_DIVISOR),
    groups: GROUP_META.map(g => getGroupConfig(g.key)),
  };
}

// ---------- 计算 ----------
function measure(length, width, height, volDivisor) {
  const sides = [Number(length), Number(width), Number(height)].sort((a, b) => a - b);
  const volume = length * width * height;
  return {
    sides,
    volume,
    girth: (sides[0] + sides[1]) * 2 + sides[2],
    longest: sides[2],
    secondLongest: sides[1],
    shortest: sides[0],
    volWeight: Math.ceil(volume / volDivisor),
  };
}

// 报价表第一栏 = 起重；计费重 = max(起重, 体积重)
function pickTier(tiers, chargedWeight) {
  const sorted = [...tiers].sort((a, b) => a.min_weight - b.min_weight);
  let chosen = sorted[0];
  sorted.forEach(tier => {
    if (chargedWeight >= tier.min_weight) chosen = tier;
  });
  return chosen;
}

// 规则匹配：下限（≥）+ 可选上限（<）
function ruleMatches(rule, fields) {
  const value = fields[rule.field];
  if (value === undefined || value === null) return false;
  if (!(value >= toNum(rule.threshold, 0))) return false;
  const max = rule.threshold_max;
  if (max !== null && max !== undefined && max !== '' && !(value < Number(max))) return false;
  return true;
}

function formatRange(rule) {
  const max = rule.threshold_max;
  return max !== null && max !== undefined && max !== '' ? `≥${rule.threshold} 且 <${max}` : `≥${rule.threshold}`;
}

// 取一条规则的行为（兼容旧数据：kind=oversize → max、kind=notice/reject → 自身）
function ruleMode(rule) {
  if (rule.combine_mode && COMBINE_MODE_LABELS[rule.combine_mode]) return rule.combine_mode;
  if (rule.kind === 'oversize') return 'max';
  if (rule.kind === 'notice') return 'notice';
  if (rule.kind === 'reject') return 'reject';
  return 'add';
}

// 附加费计算：完全由每条规则的「行为」（combine_mode）驱动
// 叠加 / 不叠加 组：各自组内取最高、组间求和；命中「不叠加取最大值」组时只收该类最高，其余不收；卡派独立累加
function calculateSurcharge(m, rules) {
  const fields = {
    weight: m.actualWeight,
    charged_weight: m.chargedWeight,
    girth: m.girth,
    longest: m.longest,
    second_longest: m.secondLongest,
    shortest: m.shortest,
    volume: m.volume,
  };

  const enabled = rules.filter(r => Number(r.enabled) === 1);
  const note = rule => `${rule.rule_group}：${FIELD_LABELS[rule.field] || rule.field} ${formatRange(rule)}`;

  // 拒收：命中任意一条即不收货
  const rejected = enabled.find(r => ruleMode(r) === 'reject' && ruleMatches(r, fields));
  if (rejected) {
    return {
      rejected: true,
      rejectReason: `${note(rejected)}，当前值 ${fields[rejected.field]}`,
      surcharge: 0,
      detail: [],
    };
  }

  const detail = [];

  // 提醒：不收费
  enabled
    .filter(r => ruleMode(r) === 'notice' && ruleMatches(r, fields))
    .forEach(r => {
      detail.push(`提醒：${note(r)}，当前值 ${fields[r.field]}`);
    });

  // 组内满足任一条件只收一次（取组内最高），行为相同的组之间再按规则合并
  const groupsOf = mode => {
    const matched = {};
    enabled
      .filter(r => ruleMode(r) === mode && ruleMatches(r, fields))
      .forEach(r => {
        const amount = toNum(r.amount, 0);
        const current = matched[r.rule_group];
        if (!current || amount > current.amount) {
          matched[r.rule_group] = { amount, rule: r };
        }
      });
    return Object.values(matched);
  };

  const sum = list => round2(list.reduce((acc, g) => acc + g.amount, 0));
  const describe = list => list.map(g => `${note(g.rule)} → +${g.amount} 元`);

  // 卡派：独立累加，永远不受「不叠加取最大值」影响
  const dispatch = groupsOf('cardispatch');

  // 不叠加取最大值：命中即替换掉所有 叠加 / 不叠加 组
  const exclusive = groupsOf('max');
  if (exclusive.length) {
    const best = exclusive.reduce((a, b) => (b.amount > a.amount ? b : a));
    detail.push(`不叠加取最高：${note(best.rule)} → +${best.amount} 元`);
    return {
      rejected: false,
      surcharge: round2(best.amount + sum(dispatch)),
      detail: [...detail, ...describe(dispatch)],
    };
  }

  const add = groupsOf('add');
  const notStack = groupsOf('not_stack');
  return {
    rejected: false,
    surcharge: round2(sum(add) + sum(notStack) + sum(dispatch)),
    detail: [...detail, ...describe(add), ...describe(notStack), ...describe(dispatch)],
  };
}

function normalizeBoxes(boxes) {
  const list = Array.isArray(boxes) ? boxes : [];
  const result = list
    .map(box => ({
      length: Number(box.length),
      width: Number(box.width),
      height: Number(box.height),
      weight: Number(box.weight),
    }))
    .filter(box => box.length > 0 && box.width > 0 && box.height > 0 && !isNaN(box.weight));
  if (!result.length) throw new Error('请至少填写一个完整的箱规（长、宽、高、实重）');
  return result;
}

function calculateGroup(groupKey, selection, rawBoxes) {
  const meta = GROUP_META.find(g => g.key === groupKey);
  if (!meta) throw new Error('未知的目的地');

  const rows = getRateRows(groupKey);
  let row = null;
  if (meta.mode === 'zip') {
    const first = String(selection.zip || '').trim()[0];
    if (!/[0-9]/.test(first || '')) throw new Error('无法识别的美国邮编，请检查输入');
    row = rows.find(r => `,${r.match_key || ''},`.includes(`,${first},`));
    if (!row) throw new Error('无法识别的美国邮编，请检查输入');
  } else {
    row = rows.find(r => r.id === Number(selection.rowId));
    if (!row) throw new Error('请选择目的地');
  }

  const tiers = getTiers(groupKey);
  if (!tiers.length) throw new Error(`「${meta.name}」还没有设置报价阶梯`);
  const volDivisor = toNum(getSetting('vol_divisor', DEFAULT_VOL_DIVISOR), DEFAULT_VOL_DIVISOR) || DEFAULT_VOL_DIVISOR;
  const rules = getRules(groupKey);
  const values = getRateValues(groupKey).filter(v => v.row_id === row.id);

  const boxes = normalizeBoxes(rawBoxes);
  const minWeight = getMinWeight(groupKey, boxes.length); // 起算重量：一箱 / 多箱每箱
  const items = boxes.map((box, index) => {
    const m = measure(box.length, box.width, box.height, volDivisor);
    m.actualWeight = box.weight;

    // 每箱单独计算：计费重 = max(起重, 体积重)，再按该箱计费重查阶梯、单价
    const chargedWeight = Math.max(minWeight, m.volWeight);
    const tier = pickTier(tiers, chargedWeight);
    const value = values.find(v => v.tier_id === tier.id);
    const unitPrice = value ? value.price : 0;
    const baseFreight = chargedWeight * unitPrice;
    m.chargedWeight = chargedWeight;

    const { rejected, rejectReason, surcharge, detail } = calculateSurcharge(m, rules);
    if (rejected) {
      throw new Error(
        `第 ${index + 1} 箱超出「${meta.name}」承运范围，不收货 —— ${rejectReason}。请调整该箱或联系货代确认。`
      );
    }

    return {
      index: index + 1,
      sides: `${box.length}×${box.width}×${box.height}`,
      girth: m.girth,
      volume: m.volume,
      actualWeight: box.weight,
      volWeight: m.volWeight,
      chargedWeight,
      tierLabel: tier.label,
      unitPrice,
      baseFreight: round2(baseFreight),
      surcharge: round2(surcharge),
      surchargeDetail: detail,
      total: round2(baseFreight + surcharge),
    };
  });

  const sum = key => round2(items.reduce((acc, item) => acc + item[key], 0));
  return {
    groupName: meta.name,
    destination: row.row_name,
    minWeight,
    minWeightSingle: getMinWeight(groupKey, 1),
    minWeightPerBox: getMinWeight(groupKey, 2),
    minWeightMode: boxes.length > 1 ? 'per_box' : 'single',
    boxes: items,
    summary: {
      boxCount: items.length,
      totalActualWeight: sum('actualWeight'),
      totalChargedWeight: sum('chargedWeight'),
      totalVolume: sum('volume'),
      totalBaseFreight: sum('baseFreight'),
      totalSurcharge: sum('surcharge'),
      total: sum('total'),
    },
  };
}

// ---------- 报价行维护 ----------
function addRateRow(groupKey, name, matchKey) {
  if (!GROUP_META.some(g => g.key === groupKey)) throw new Error('未知的目的地');
  const rowId = insertRateRow(groupKey, name || '新增地区', matchKey);
  getTiers(groupKey).forEach(tier => insertValue(rowId, tier.id, 0));
  saveDb();
  return getGroupConfig(groupKey);
}

function deleteRateRow(groupKey, rowId) {
  if (!GROUP_META.some(g => g.key === groupKey)) throw new Error('未知的目的地');
  db.run(`DELETE FROM rate_values WHERE row_id = ?`, [Number(rowId)]);
  db.run(`DELETE FROM rate_rows WHERE id = ?`, [Number(rowId)]);
  saveDb();
  return getGroupConfig(groupKey);
}

function setVolDivisor(value) {
  setSetting('vol_divisor', toNum(value, DEFAULT_VOL_DIVISOR) || DEFAULT_VOL_DIVISOR);
  saveDb();
  return true;
}

function resetDatabase() {
  db.close();
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  db = new SQL.Database();
  ensureSchema();
  seedData();
  saveDb();
  return true;
}

// ---------- 配置保存 ----------
function saveGroupConfig(data) {
  const key = data.groupKey;
  if (!GROUP_META.some(g => g.key === key)) throw new Error('未知的目的地');

  // 起算重量：一箱起算 / 多箱每箱起算
  if (data.minWeightSingle !== undefined && data.minWeightSingle !== '') {
    setSetting('min_weight_single_' + key, Math.max(0, toNum(data.minWeightSingle, 0)));
  }
  if (data.minWeightPerBox !== undefined && data.minWeightPerBox !== '') {
    setSetting('min_weight_per_box_' + key, Math.max(0, toNum(data.minWeightPerBox, 0)));
  }

  (data.tiers || []).forEach(tier => {
    const minWeight = toNum(tier.min_weight, 0);
    db.run(`UPDATE rate_tiers SET min_weight = ?, label = ? WHERE id = ?`, [
      minWeight,
      `${minWeight}KG+`,
      Number(tier.id),
    ]);
  });

  (data.rows || []).forEach(row => {
    db.run(`UPDATE rate_rows SET row_name = ?, match_key = ? WHERE id = ?`, [
      row.name,
      row.matchKey || null,
      Number(row.id),
    ]);
    Object.keys(row.prices || {}).forEach(tierId => {
      insertValue(Number(row.id), Number(tierId), row.prices[tierId]);
    });
  });

  db.run(`DELETE FROM surcharge_rules WHERE group_key = ?`, [key]);
  (data.rules || []).forEach(rule => insertRule(key, rule));

  saveDb();
  return getGroupConfig(key);
}

// ---------- 配置导出 / 导入 ----------
const CONFIG_FORMAT = 'freight-master-config';
const CONFIG_VERSION = 1;

// 组装可导出的完整配置（体积重系数 + 五个目的地的阶梯/地区行/单价/规则/起算重量）
function buildExportPayload() {
  return {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt: new Date().toISOString(),
    volDivisor: toNum(getSetting('vol_divisor', DEFAULT_VOL_DIVISOR), DEFAULT_VOL_DIVISOR),
    groups: GROUP_META.map(meta => {
      const cfg = getGroupConfig(meta.key);
      return {
        key: cfg.key,
        name: cfg.name,
        mode: cfg.mode,
        minWeightSingle: toNum(cfg.minWeightSingle, meta.minWeightSingle),
        minWeightPerBox: toNum(cfg.minWeightPerBox, meta.minWeightPerBox),
        tiers: cfg.tiers.map(t => ({
          id: t.id,
          min_weight: toNum(t.min_weight, 0),
          label: t.label || `${toNum(t.min_weight, 0)}KG+`,
        })),
        rows: cfg.rows.map(row => ({
          id: row.id,
          name: row.row_name,
          matchKey: row.match_key || null,
          prices: Object.keys(row.prices || {}).reduce((acc, tierId) => {
            acc[tierId] = toNum(row.prices[tierId], 0);
            return acc;
          }, {}),
        })),
        rules: cfg.rules.map(r => ({
          rule_group: r.rule_group,
          field: r.field,
          threshold: toNum(r.threshold, 0),
          threshold_max:
            r.threshold_max === '' || r.threshold_max === null || r.threshold_max === undefined
              ? null
              : toNum(r.threshold_max, null),
          amount: toNum(r.amount, 0),
          combine_mode: COMBINE_MODE_LABELS[r.combine_mode] ? r.combine_mode : 'add',
          enabled: Number(r.enabled) === 1 ? 1 : 0,
        })),
      };
    }),
  };
}

// 先整份校验，通过后再落库，避免写一半失败留下脏数据
function applyImportPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('配置文件格式不正确');
  }
  if (!Array.isArray(payload.groups) || !payload.groups.length) {
    throw new Error('配置文件里没有找到目的地数据（groups 为空）');
  }

  const seen = new Set();
  const plans = payload.groups.map(item => {
    if (!item || typeof item !== 'object' || !item.key) {
      throw new Error('存在缺少 key 的目的地配置');
    }
    const meta = GROUP_META.find(m => m.key === item.key);
    if (!meta) throw new Error(`配置里有未知的目的地：${item.key}`);
    if (seen.has(item.key)) throw new Error(`配置里目的地重复：${item.key}`);
    seen.add(item.key);

    const tiers = (Array.isArray(item.tiers) ? item.tiers : []).map(t => ({
      id: toNum(t.id, 0) || 0,
      min_weight: toNum(t.min_weight, 0),
      label: t.label || `${toNum(t.min_weight, 0)}KG+`,
    }));
    if (!tiers.length) throw new Error(`「${meta.name}」缺少报价阶梯`);

    const rows = (Array.isArray(item.rows) ? item.rows : []).map(r => {
      const prices = {};
      Object.keys(r.prices || {}).forEach(k => {
        prices[k] = toNum(r.prices[k], 0);
      });
      return {
        id: toNum(r.id, 0) || 0,
        name: r.name || '未命名地区',
        matchKey: r.matchKey || null,
        prices,
      };
    });

    const rules = (Array.isArray(item.rules) ? item.rules : []).map(r => ({
      rule_group: r.rule_group || '规则',
      field: FIELD_LABELS[r.field] ? r.field : 'weight',
      threshold: toNum(r.threshold, 0),
      threshold_max:
        r.threshold_max === '' || r.threshold_max === null || r.threshold_max === undefined
          ? null
          : toNum(r.threshold_max, null),
      amount: toNum(r.amount, 0),
      combine_mode: COMBINE_MODE_LABELS[r.combine_mode] ? r.combine_mode : 'add',
      enabled: r.enabled === undefined ? 1 : Number(r.enabled) === 1 ? 1 : 0,
    }));

    return {
      key: meta.key,
      name: meta.name,
      mode: meta.mode,
      minWeightSingle: toNum(item.minWeightSingle, meta.minWeightSingle),
      minWeightPerBox: toNum(item.minWeightPerBox, meta.minWeightPerBox),
      tiers,
      rows,
      rules,
    };
  });

  plans.forEach(plan => {
    db.run(`DELETE FROM rate_values WHERE row_id IN (SELECT id FROM rate_rows WHERE group_key = ?)`, [
      plan.key,
    ]);
    db.run(`DELETE FROM rate_rows WHERE group_key = ?`, [plan.key]);
    db.run(`DELETE FROM rate_tiers WHERE group_key = ?`, [plan.key]);
    db.run(`DELETE FROM surcharge_rules WHERE group_key = ?`, [plan.key]);

    // 保留导出文件里的 id，阶梯/单价的对应关系才不会错
    const tierIdMap = {};
    plan.tiers.forEach(t => {
      const minWeight = toNum(t.min_weight, 0);
      if (t.id) {
        db.run(`INSERT INTO rate_tiers (id, group_key, min_weight, label) VALUES (?, ?, ?, ?)`, [
          t.id,
          plan.key,
          minWeight,
          t.label || `${minWeight}KG+`,
        ]);
      } else {
        insertTier(plan.key, minWeight);
      }
      tierIdMap[t.id] = t.id || lastId();
    });

    plan.rows.forEach(row => {
      let rowId;
      if (row.id) {
        db.run(`INSERT INTO rate_rows (id, group_key, row_name, match_key) VALUES (?, ?, ?, ?)`, [
          row.id,
          plan.key,
          row.name,
          row.matchKey,
        ]);
        rowId = row.id;
      } else {
        rowId = insertRateRow(plan.key, row.name, row.matchKey);
      }
      Object.keys(row.prices).forEach(oldTierId => {
        const newTierId = tierIdMap[oldTierId];
        if (newTierId) insertValue(rowId, newTierId, row.prices[oldTierId]);
      });
    });

    plan.rules.forEach(rule => insertRule(plan.key, rule));

    setSetting('min_weight_single_' + plan.key, plan.minWeightSingle);
    setSetting('min_weight_per_box_' + plan.key, plan.minWeightPerBox);
    // 标记已初始化，防止启动逻辑把导入的规则再覆盖掉
    setSetting('seeded_' + plan.key, '1');
    setSetting('rules_v2_' + plan.key, '1');
  });

  const volDivisor = toNum(payload.volDivisor, DEFAULT_VOL_DIVISOR);
  if (volDivisor > 0) setSetting('vol_divisor', volDivisor);

  saveDb();
  return getConfig();
}

module.exports = {
  initCore,
  DEFAULT_VOL_DIVISOR,
  FIELD_LABELS,
  COMBINE_MODE_LABELS,
  GROUP_META,
  getConfig,
  getGroupConfig,
  calculateGroup,
  saveGroupConfig,
  addRateRow,
  deleteRateRow,
  setVolDivisor,
  resetDatabase,
  buildExportPayload,
  applyImportPayload,
};
