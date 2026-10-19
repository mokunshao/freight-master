const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

// 开发模式：数据库在项目根目录；打包后（resources/app.asar 只读）：数据库放在 exe 同级目录，方便备份与迁移
const APP_ROOT = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
const DB_FILE = path.join(APP_ROOT, 'freight-master.db');

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

// 规则类型
const KIND_LABELS = {
  fee: '附加费（可叠加）',
  oversize: '附加费（超大件，命中后不叠加其他附加费）',
  reject: '达到即不收货',
  notice: '仅提醒（不收费）',
};

// 目的地分组：mode=zip 按邮编匹配，mode=country 直接选择地区/国家
const GROUP_META = [
  { key: 'us', name: '美国', mode: 'zip', surchargeMode: 'stack' },
  { key: 'eu', name: '欧洲', mode: 'country', surchargeMode: 'max' },
  { key: 'ca', name: '加拿大', mode: 'country', surchargeMode: 'stack' },
  { key: 'uk', name: '英国', mode: 'country', surchargeMode: 'stack' },
  { key: 'au', name: '澳大利亚', mode: 'country', surchargeMode: 'stack' },
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
      { rule_group: '实重', field: 'weight', threshold: 22.5, amount: 120, exclusive: 0, enabled: 1 },
      { rule_group: '围长', field: 'girth', threshold: 265, amount: 120, exclusive: 0, enabled: 1 },
      { rule_group: '单边', field: 'longest', threshold: 120, amount: 120, exclusive: 0, enabled: 1 },
      { rule_group: '单边', field: 'second_longest', threshold: 75, amount: 120, exclusive: 0, enabled: 1 },
      { rule_group: '超大件', field: 'girth', threshold: 330, amount: 500, exclusive: 1, enabled: 1 },
      { rule_group: '超大件', field: 'volume', threshold: 283168, amount: 500, exclusive: 1, enabled: 1 },
      { rule_group: '超大件', field: 'weight', threshold: 50, amount: 500, exclusive: 1, enabled: 1 },
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
      { name: 'Slovenia, Croatia, Finland, Sweden, Bulgaria 斯洛文尼亚、克罗地亚、芬兰、瑞典、保加利亚', prices: [19.5, 19.0, 19.0] },
      { name: 'Greece, Ireland, Portugal 希腊、爱尔兰、葡萄牙', prices: [21.0, 21.0, 20.0] },
    ],
    rules: [
      { rule_group: '围长330', field: 'girth', threshold: 330, amount: 350, exclusive: 0, enabled: 1 },
      { rule_group: '围长300', field: 'girth', threshold: 300, amount: 300, exclusive: 0, enabled: 1 },
      { rule_group: '实重30', field: 'weight', threshold: 30, amount: 300, exclusive: 0, enabled: 1 },
    ],
  },
  // 以下三个目的地暂无官方报价，单价先置 0 占位，请在「价格管理」里填写
  ca: {
    tiers: [10, 21, 101],
    rows: [{ name: '加拿大 Canada', prices: [0, 0, 0] }],
    rules: [
      { rule_group: '①实重', field: 'weight', threshold: 22, amount: 130 },
      { rule_group: '②单边', field: 'longest', threshold: 121, amount: 130 },
      { rule_group: '②单边', field: 'second_longest', threshold: 75, amount: 130 },
      { rule_group: '③围长', field: 'girth', threshold: 265, amount: 130 },
      { rule_group: '④超大件', field: 'girth', threshold: 320, amount: 700, kind: 'oversize' },
      { rule_group: '④超大件', field: 'weight', threshold: 40, amount: 700, kind: 'oversize' },
      { rule_group: '⑤不收货', field: 'weight', threshold: 68, amount: 0, kind: 'reject' },
      { rule_group: '⑤不收货', field: 'longest', threshold: 151, amount: 0, kind: 'reject' },
      { rule_group: '⑤不收货', field: 'girth', threshold: 400, amount: 0, kind: 'reject' },
    ],
  },
  uk: {
    tiers: [10, 21, 101],
    rows: [{ name: '英国 United Kingdom', prices: [0, 0, 0] }],
    rules: [
      { rule_group: '①实重30-40', field: 'weight', threshold: 30, threshold_max: 40, amount: 330 },
      // ②和③互不叠加 → 放同一规则组（组内满足任一条件只收一次）
      { rule_group: '②③尺寸', field: 'longest', threshold: 100, threshold_max: 150, amount: 300 },
      { rule_group: '②③尺寸', field: 'second_longest', threshold: 70, threshold_max: 100, amount: 300 },
      { rule_group: '②③尺寸', field: 'shortest', threshold: 60, threshold_max: 100, amount: 300 },
      { rule_group: '②③尺寸', field: 'girth', threshold: 300, threshold_max: 400, amount: 300 },
    ],
  },
  au: {
    tiers: [10, 21, 101],
    rows: [{ name: '澳大利亚 Australia', prices: [0, 0, 0] }],
    rules: [
      { rule_group: '计费重≥30', field: 'charged_weight', threshold: 30, threshold_max: 35, amount: 100 },
      { rule_group: '计费重≥35', field: 'charged_weight', threshold: 35, threshold_max: 80, amount: 300 },
      { rule_group: '计费重≥80', field: 'charged_weight', threshold: 80, amount: 300 },
      { rule_group: '单边120-199', field: 'longest', threshold: 120, threshold_max: 200, amount: 100 },
      { rule_group: '单边200-299', field: 'longest', threshold: 200, threshold_max: 300, amount: 200 },
      { rule_group: '木托盘提醒', field: 'weight', threshold: 30, amount: 0, kind: 'notice' },
    ],
  },
};

let db = null;
let SQL = null;

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
      kind TEXT NOT NULL DEFAULT 'fee',
      exclusive INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1
    );`);
  } else {
    // 旧版表升级：补上限列与规则类型列
    const cols = db.exec('PRAGMA table_info(surcharge_rules)')[0].values.map(v => v[1]);
    if (!cols.includes('threshold_max')) {
      db.run(`ALTER TABLE surcharge_rules ADD COLUMN threshold_max REAL`);
    }
    if (!cols.includes('kind')) {
      db.run(`ALTER TABLE surcharge_rules ADD COLUMN kind TEXT NOT NULL DEFAULT 'fee'`);
      db.run(`UPDATE surcharge_rules SET kind = CASE WHEN exclusive = 1 THEN 'oversize' ELSE 'fee' END`);
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
  let kind = rule.kind;
  if (!KIND_LABELS[kind]) kind = Number(rule.exclusive) === 1 ? 'oversize' : 'fee';
  const thresholdMax =
    rule.threshold_max === '' || rule.threshold_max === null || rule.threshold_max === undefined
      ? null
      : toNum(rule.threshold_max, null);
  db.run(
    `INSERT INTO surcharge_rules (group_key, rule_group, field, threshold, threshold_max, amount, kind, exclusive, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      groupKey,
      rule.rule_group || '规则',
      FIELD_LABELS[rule.field] ? rule.field : 'weight',
      toNum(rule.threshold, 0),
      thresholdMax,
      toNum(rule.amount, 0),
      kind,
      kind === 'oversize' ? 1 : 0,
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
  });
}

function seedData() {
  setSetting('vol_divisor', DEFAULT_VOL_DIVISOR);
  GROUP_META.forEach(group => setSetting('surcharge_mode_' + group.key, group.surchargeMode));
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
  GROUP_META.forEach(group => {
    if (!db.exec(`SELECT value FROM settings WHERE key = 'surcharge_mode_${group.key}'`).length) {
      setSetting('surcharge_mode_' + group.key, group.surchargeMode);
    }
  });
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
    db.exec(`SELECT * FROM surcharge_rules WHERE group_key = '${groupKey}' ORDER BY id ASC`)
  );
}

function getGroupConfig(groupKey) {
  const meta = GROUP_META.find(g => g.key === groupKey);
  const tiers = getTiers(groupKey);
  const rows = getRateRows(groupKey);
  const values = getRateValues(groupKey);
  return {
    ...meta,
    surchargeMode: getSetting('surcharge_mode_' + groupKey, meta.surchargeMode),
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

// 规则组内满足任一条件只收一次（取组内最高金额）；规则组之间按模式叠加或取最高
function calculateSurcharge(m, rules, mode) {
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

  // 达到即不收货
  const rejected = enabled.find(r => (r.kind || 'fee') === 'reject' && ruleMatches(r, fields));
  if (rejected) {
    return {
      rejected: true,
      rejectReason: `${rejected.rule_group}：${FIELD_LABELS[rejected.field] || rejected.field} ${formatRange(rejected)}，当前值 ${fields[rejected.field]}`,
      surcharge: 0,
      detail: [],
    };
  }

  const detail = [];

  // 仅提醒（不收费）
  enabled
    .filter(r => r.kind === 'notice' && ruleMatches(r, fields))
    .forEach(r => {
      detail.push(`提醒：${r.rule_group}（${FIELD_LABELS[r.field] || r.field} ${formatRange(r)}，当前值 ${fields[r.field]}）`);
    });

  const matched = {};
  enabled
    .filter(r => {
      const kind = r.kind || 'fee';
      return kind === 'fee' || kind === 'oversize';
    })
    .forEach(r => {
      if (!ruleMatches(r, fields)) return;
      const amount = toNum(r.amount, 0);
      const current = matched[r.rule_group];
      if (!current || amount > current.amount) {
        matched[r.rule_group] = {
          amount,
          exclusive: r.kind === 'oversize',
          detail: `${r.rule_group}：${FIELD_LABELS[r.field] || r.field} ${formatRange(r)} → +${amount} 元`,
        };
      }
    });

  const groups = Object.values(matched);
  if (groups.length) {
    if (mode === 'max') {
      const best = groups.reduce((a, b) => (b.amount > a.amount ? b : a));
      return { rejected: false, surcharge: best.amount, detail: [...detail, best.detail] };
    }

    const exclusive = groups.filter(g => g.exclusive);
    if (exclusive.length) {
      // 命中超大件：只收超大件，其他附加费不再叠加
      const best = exclusive.reduce((a, b) => (b.amount > a.amount ? b : a));
      return { rejected: false, surcharge: best.amount, detail: [...detail, best.detail] };
    }

    return {
      rejected: false,
      surcharge: groups.reduce((sum, g) => sum + g.amount, 0),
      detail: [...detail, ...groups.map(g => g.detail)],
    };
  }

  return { rejected: false, surcharge: 0, detail };
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
  const minWeight = toNum(tiers[0].min_weight, 0); // 起重 = 报价表第一栏
  const volDivisor = toNum(getSetting('vol_divisor', DEFAULT_VOL_DIVISOR), DEFAULT_VOL_DIVISOR) || DEFAULT_VOL_DIVISOR;
  const mode = getSetting('surcharge_mode_' + groupKey, meta.surchargeMode);
  const rules = getRules(groupKey);
  const values = getRateValues(groupKey).filter(v => v.row_id === row.id);

  const boxes = normalizeBoxes(rawBoxes);
  const items = boxes.map((box, index) => {
    const m = measure(box.length, box.width, box.height, volDivisor);
    m.actualWeight = box.weight;

    const chargedWeight = Math.max(minWeight, m.volWeight);
    const tier = pickTier(tiers, chargedWeight);
    const value = values.find(v => v.tier_id === tier.id);
    const unitPrice = value ? value.price : 0;
    const baseFreight = chargedWeight * unitPrice;
    m.chargedWeight = chargedWeight;
    const { rejected, rejectReason, surcharge, detail } = calculateSurcharge(m, rules, mode);
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
    boxes: items,
    summary: {
      boxCount: items.length,
      totalActualWeight: sum('actualWeight'),
      totalChargedWeight: items.reduce((acc, item) => acc + item.chargedWeight, 0),
      totalVolume: items.reduce((acc, item) => acc + item.volume, 0),
      totalBaseFreight: sum('baseFreight'),
      totalSurcharge: sum('surcharge'),
      total: sum('total'),
    },
  };
}

// ---------- 窗口 ----------
async function createWindow() {
  SQL = await initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
  initDb();

  const win = new BrowserWindow({
    width: 1280,
    height: 940,
    title: '运费大师',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- 接口 ----------
ipcMain.handle('get-config', () => getConfig());

ipcMain.handle('calculate', (event, data) => {
  return calculateGroup(data.groupKey, { zip: data.zip, rowId: data.rowId }, data.boxes);
});

function saveGroupConfig(data) {
  const key = data.groupKey;
  if (!GROUP_META.some(g => g.key === key)) throw new Error('未知的目的地');

  setSetting('surcharge_mode_' + key, data.surchargeMode === 'max' ? 'max' : 'stack');

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

ipcMain.handle('save-group', (event, data) => saveGroupConfig(data));

ipcMain.handle('add-rate-row', (event, data) => {
  if (!GROUP_META.some(g => g.key === data.groupKey)) throw new Error('未知的目的地');
  const rowId = insertRateRow(data.groupKey, data.name || '新增地区', data.matchKey);
  getTiers(data.groupKey).forEach(tier => insertValue(rowId, tier.id, 0));
  saveDb();
  return getGroupConfig(data.groupKey);
});

ipcMain.handle('delete-rate-row', (event, data) => {
  db.run(`DELETE FROM rate_values WHERE row_id = ?`, [Number(data.rowId)]);
  db.run(`DELETE FROM rate_rows WHERE id = ?`, [Number(data.rowId)]);
  saveDb();
  return getGroupConfig(data.groupKey);
});

ipcMain.handle('set-vol-divisor', (event, value) => {
  setSetting('vol_divisor', toNum(value, DEFAULT_VOL_DIVISOR) || DEFAULT_VOL_DIVISOR);
  saveDb();
  return true;
});

ipcMain.handle('reset-database', () => {
  db.close();
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  db = new SQL.Database();
  ensureSchema();
  seedData();
  saveDb();
  return true;
});

// 供自动化测试调用（作为 Electron 入口运行时无副作用）
module.exports = { calculateGroup, getConfig, saveGroupConfig };
