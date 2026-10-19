const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

// 开发模式：数据库在项目根目录；打包后（resources/app.asar 只读）：数据库放在 exe 同级目录，方便备份与迁移
const APP_ROOT = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
const DB_FILE = path.join(APP_ROOT, 'freight-master.db');

// 出厂默认值（也用于“恢复默认数据”）
const DEFAULT_VOL_DIVISOR = 6000;
const DEFAULT_US_SURCHARGE = {
  oversize_girth: 330, // 超大件：围长 >
  oversize_volume: 283168, // 超大件：体积 >=
  oversize_weight: 50, // 超大件：实重 >
  oversize_fee: 500,
  weight_threshold: 22.5, // 实重 >
  weight_fee: 120,
  girth_threshold: 265, // 围长 >
  girth_fee: 120,
  side_long_threshold: 120, // 最长边 >
  side_second_threshold: 75, // 次长边 >
  side_fee: 120,
};
const DEFAULT_EU_RULES = [
  { rule_type: 'girth', threshold: 330, amount: 350, enabled: 1 },
  { rule_type: 'girth', threshold: 300, amount: 300, enabled: 1 },
  { rule_type: 'weight', threshold: 30, amount: 300, enabled: 1 },
];

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

// ---------- 建表与初始化 ----------
function initDb() {
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
    ensureSchema(); // 老数据库补齐新表
    saveDb();
  } else {
    db = new SQL.Database();
    seedData();
    saveDb();
  }
}

// 老库升级：缺失的表/配置项自动补齐，不影响已有的价格数据
function ensureSchema() {
  if (!tableExists('us_rates')) {
    createUsRatesTable();
    seedUsRates();
  }
  if (!tableExists('eu_rates')) {
    createEuRatesTable();
    seedEuRates();
  }
  if (!tableExists('settings')) {
    createSettingsTable();
    seedSettings();
  } else if (!db.exec(`SELECT value FROM settings WHERE key = 'vol_divisor'`).length) {
    seedSettings();
  }
  if (!tableExists('us_surcharge_config')) {
    createUsSurchargeTable();
    seedUsSurcharge();
  }
  if (!tableExists('eu_surcharge_rules')) {
    createEuRulesTable();
    seedEuRules();
  }
}

function saveDb() {
  if (!db) return;
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function seedData() {
  createUsRatesTable();
  createEuRatesTable();
  createSettingsTable();
  createUsSurchargeTable();
  createEuRulesTable();
  seedUsRates();
  seedEuRates();
  seedSettings();
  seedUsSurcharge();
  seedEuRules();
}

function createUsRatesTable() {
  db.run(`
    CREATE TABLE us_rates (
      id INTEGER PRIMARY KEY,
      region_name TEXT NOT NULL,
      zip_prefixes TEXT NOT NULL,
      weight_10 REAL NOT NULL,
      weight_21 REAL NOT NULL,
      weight_71 REAL NOT NULL,
      weight_101 REAL NOT NULL
    );
  `);
}

function createEuRatesTable() {
  db.run(`
    CREATE TABLE eu_rates (
      id INTEGER PRIMARY KEY,
      country_name TEXT NOT NULL,
      weight_10 REAL NOT NULL,
      weight_21 REAL NOT NULL,
      weight_101 REAL NOT NULL
    );
  `);
}

function createSettingsTable() {
  db.run(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function createUsSurchargeTable() {
  db.run(`
    CREATE TABLE us_surcharge_config (
      id INTEGER PRIMARY KEY,
      oversize_girth REAL NOT NULL,
      oversize_volume REAL NOT NULL,
      oversize_weight REAL NOT NULL,
      oversize_fee REAL NOT NULL,
      weight_threshold REAL NOT NULL,
      weight_fee REAL NOT NULL,
      girth_threshold REAL NOT NULL,
      girth_fee REAL NOT NULL,
      side_long_threshold REAL NOT NULL,
      side_second_threshold REAL NOT NULL,
      side_fee REAL NOT NULL
    );
  `);
}

function createEuRulesTable() {
  db.run(`
    CREATE TABLE eu_surcharge_rules (
      id INTEGER PRIMARY KEY,
      rule_type TEXT NOT NULL,
      threshold REAL NOT NULL,
      amount REAL NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );
  `);
}

function seedUsRates() {
  const usStmt = db.prepare(`
    INSERT INTO us_rates (region_name, zip_prefixes, weight_10, weight_21, weight_71, weight_101)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  usStmt.run(['美西（邮编8,9开头）', '8,9', 16.7, 15.2, 13.2, 12.2]);
  usStmt.run(['美中（邮编4,5,6,7开头）', '4,5,6,7', 17.7, 16.2, 14.2, 13.2]);
  usStmt.run(['美东（邮编0,1,2,3开头）', '0,1,2,3', 18.7, 17.2, 15.2, 14.2]);
  usStmt.free();
}

function seedEuRates() {
  const euStmt = db.prepare(`
    INSERT INTO eu_rates (country_name, weight_10, weight_21, weight_101)
    VALUES (?, ?, ?, ?)
  `);
  euStmt.run(['Germany 德国', 15.5, 15.0, 15.0]);
  euStmt.run(['Poland, Belgium, Luxembourg 波兰、比利时、卢森堡', 18.0, 18.0, 17.0]);
  euStmt.run(['Czech Republic, Slovakia, Austria, Hungary 捷克、斯洛伐克、奥地利、匈牙利', 18.0, 18.0, 17.5]);
  euStmt.run(['France 法国', 18.5, 18.0, 17.0]);
  euStmt.run(['Netherlands, Denmark, Estonia, Lithuania, Monaco, Latvia, Spain(except islands), Italy(except islands) 荷兰、丹麦、爱沙尼亚、立陶宛、摩纳哥、拉脱维亚、西班牙(岛屿除外)、意大利(岛屿除外)', 19.0, 19.0, 18.0]);
  euStmt.run(['Slovenia, Croatia, Finland, Sweden, Bulgaria 斯洛文尼亚、克罗地亚、芬兰、瑞典、保加利亚', 19.5, 19.0, 19.0]);
  euStmt.run(['Greece, Ireland, Portugal 希腊、爱尔兰、葡萄牙', 21.0, 21.0, 20.0]);
  euStmt.free();
}

function seedSettings() {
  setSetting('vol_divisor', DEFAULT_VOL_DIVISOR);
}

function seedUsSurcharge() {
  const c = DEFAULT_US_SURCHARGE;
  db.run(
    `INSERT INTO us_surcharge_config
     (id, oversize_girth, oversize_volume, oversize_weight, oversize_fee,
      weight_threshold, weight_fee, girth_threshold, girth_fee,
      side_long_threshold, side_second_threshold, side_fee)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.oversize_girth, c.oversize_volume, c.oversize_weight, c.oversize_fee,
      c.weight_threshold, c.weight_fee, c.girth_threshold, c.girth_fee,
      c.side_long_threshold, c.side_second_threshold, c.side_fee,
    ]
  );
}

function seedEuRules() {
  const stmt = db.prepare(`
    INSERT INTO eu_surcharge_rules (rule_type, threshold, amount, enabled) VALUES (?, ?, ?, ?)
  `);
  DEFAULT_EU_RULES.forEach(r => stmt.run([r.rule_type, r.threshold, r.amount, r.enabled]));
  stmt.free();
}

// ---------- 读取配置 ----------
function getUsSurchargeConfig() {
  const rows = rowsToObjects(db.exec('SELECT * FROM us_surcharge_config WHERE id = 1'));
  return rows.length ? rows[0] : { ...DEFAULT_US_SURCHARGE };
}

function getEuRules() {
  return rowsToObjects(db.exec('SELECT * FROM eu_surcharge_rules ORDER BY amount DESC, id ASC'));
}

// ---------- 计算 ----------
function getUsRegionByZip(zip) {
  const first = String(zip).trim()[0];
  if (!/[0-9]/.test(first || '')) throw new Error('无法识别的美国邮编，请检查输入');
  const row = db.exec(`SELECT * FROM us_rates WHERE ',' || zip_prefixes || ',' LIKE '%,${first},%'`)[0];
  if (!row) return null;
  const cols = row.columns;
  return row.values[0].reduce((obj, val, i) => {
    obj[cols[i]] = val;
    return obj;
  }, {});
}

function getUsRateByWeight(region, chargedWeight) {
  let col = 'weight_10';
  if (chargedWeight >= 101) col = 'weight_101';
  else if (chargedWeight >= 71) col = 'weight_71';
  else if (chargedWeight >= 21) col = 'weight_21';
  return region[col];
}

function getEuRateByCountryAndWeight(countryId, chargedWeight) {
  const row = db.exec(`SELECT * FROM eu_rates WHERE id = ${Number(countryId)}`)[0];
  if (!row) return null;
  const data = row.values[0].reduce((obj, val, i) => {
    obj[row.columns[i]] = val;
    return obj;
  }, {});
  let col = 'weight_10';
  if (chargedWeight >= 101) col = 'weight_101';
  else if (chargedWeight >= 21) col = 'weight_21';
  return { ...data, unitPrice: data[col], tier: col };
}

function calculateGirthAndWeight(length, width, height, volDivisor) {
  const sides = [length, width, height].map(Number).sort((a, b) => a - b);
  const girth = (sides[0] + sides[1]) * 2 + sides[2];
  const volume = length * width * height;
  const chargedWeight = Math.ceil(volume / volDivisor);
  return {
    sides,
    girth,
    volume,
    chargedWeight,
    longest: sides[2],
    secondLongest: sides[1],
  };
}

// 美国附加费：命中超大件则不叠加其他项；否则逐项叠加
function calculateUsSurcharge(box, cfg) {
  const detail = [];
  const c = {
    oversize_girth: toNum(cfg.oversize_girth, DEFAULT_US_SURCHARGE.oversize_girth),
    oversize_volume: toNum(cfg.oversize_volume, DEFAULT_US_SURCHARGE.oversize_volume),
    oversize_weight: toNum(cfg.oversize_weight, DEFAULT_US_SURCHARGE.oversize_weight),
    oversize_fee: toNum(cfg.oversize_fee, DEFAULT_US_SURCHARGE.oversize_fee),
    weight_threshold: toNum(cfg.weight_threshold, DEFAULT_US_SURCHARGE.weight_threshold),
    weight_fee: toNum(cfg.weight_fee, DEFAULT_US_SURCHARGE.weight_fee),
    girth_threshold: toNum(cfg.girth_threshold, DEFAULT_US_SURCHARGE.girth_threshold),
    girth_fee: toNum(cfg.girth_fee, DEFAULT_US_SURCHARGE.girth_fee),
    side_long_threshold: toNum(cfg.side_long_threshold, DEFAULT_US_SURCHARGE.side_long_threshold),
    side_second_threshold: toNum(cfg.side_second_threshold, DEFAULT_US_SURCHARGE.side_second_threshold),
    side_fee: toNum(cfg.side_fee, DEFAULT_US_SURCHARGE.side_fee),
  };

  // 三个条件满足任一即为超大件，此时不再叠加下列项目
  const isOversize =
    box.girth >= c.oversize_girth ||
    box.volume >= c.oversize_volume ||
    box.actualWeight >= c.oversize_weight;
  if (isOversize) {
    detail.push(
      `超大件附加费 +${c.oversize_fee} 元（围长≥${c.oversize_girth} 或 体积≥${c.oversize_volume} 或 实重≥${c.oversize_weight}KG）`
    );
    return { surcharge: c.oversize_fee, detail };
  }

  let surcharge = 0;
  if (box.actualWeight >= c.weight_threshold) {
    surcharge += c.weight_fee;
    detail.push(`实重≥${c.weight_threshold}KG +${c.weight_fee} 元`);
  }
  if (box.girth >= c.girth_threshold) {
    surcharge += c.girth_fee;
    detail.push(`围长≥${c.girth_threshold} +${c.girth_fee} 元`);
  }
  if (box.longest >= c.side_long_threshold || box.secondLongest >= c.side_second_threshold) {
    surcharge += c.side_fee;
    detail.push(
      `最长边≥${c.side_long_threshold}CM 或 次长边≥${c.side_second_threshold}CM +${c.side_fee} 元`
    );
  }
  return { surcharge, detail };
}

// 欧洲附加费：不叠加，命中多条取金额最高的一条
function calculateEuSurcharge(box, rules) {
  let best = null;
  rules
    .filter(r => Number(r.enabled) === 1)
    .forEach(r => {
      const value = r.rule_type === 'girth' ? box.girth : box.actualWeight;
      if (value >= toNum(r.threshold, 0) && (!best || toNum(r.amount, 0) > toNum(best.amount, 0))) {
        best = r;
      }
    });
  if (!best) return { surcharge: 0, detail: [] };
  const label = best.rule_type === 'girth' ? `围长≥${best.threshold}` : `实重≥${best.threshold}KG`;
  return { surcharge: toNum(best.amount, 0), detail: [`${label} +${best.amount} 元`] };
}

function summarize(items) {
  const sum = key => round2(items.reduce((acc, item) => acc + item[key], 0));
  return {
    boxCount: items.length,
    totalActualWeight: sum('actualWeight'),
    totalChargedWeight: items.reduce((acc, item) => acc + item.chargedWeight, 0),
    totalVolume: items.reduce((acc, item) => acc + item.volume, 0),
    totalBaseFreight: sum('baseFreight'),
    totalSurcharge: sum('surcharge'),
    total: sum('total'),
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
    .filter(
      box =>
        box.length > 0 && box.width > 0 && box.height > 0 && !isNaN(box.weight)
    );
  if (!result.length) throw new Error('请至少填写一个完整的箱子（长、宽、高、实重）');
  return result;
}

function calculateUs(zip, rawBoxes) {
  const region = getUsRegionByZip(zip);
  if (!region) throw new Error('无法识别的美国邮编，请检查输入');

  const boxes = normalizeBoxes(rawBoxes);
  const volDivisor = toNum(getSetting('vol_divisor', DEFAULT_VOL_DIVISOR), DEFAULT_VOL_DIVISOR) || DEFAULT_VOL_DIVISOR;
  const cfg = getUsSurchargeConfig();

  const items = boxes.map((box, index) => {
    const m = calculateGirthAndWeight(box.length, box.width, box.height, volDivisor);
    const actualWeight = box.weight;
    const unitPrice = getUsRateByWeight(region, m.chargedWeight);
    const baseFreight = m.chargedWeight * unitPrice;
    const { surcharge, detail } = calculateUsSurcharge({ ...m, actualWeight }, cfg);

    return {
      index: index + 1,
      sides: `${box.length}×${box.width}×${box.height}`,
      girth: m.girth,
      volume: m.volume,
      actualWeight,
      chargedWeight: m.chargedWeight,
      unitPrice,
      baseFreight: round2(baseFreight),
      surcharge: round2(surcharge),
      surchargeDetail: detail,
      total: round2(baseFreight + surcharge),
    };
  });

  return {
    region: region.region_name,
    zip,
    boxes: items,
    summary: summarize(items),
  };
}

function calculateEu(countryId, rawBoxes) {
  const rate = getEuRateByCountryAndWeight(countryId, 0);
  if (!rate) throw new Error('请选择有效的欧洲国家');

  const boxes = normalizeBoxes(rawBoxes);
  const volDivisor = toNum(getSetting('vol_divisor', DEFAULT_VOL_DIVISOR), DEFAULT_VOL_DIVISOR) || DEFAULT_VOL_DIVISOR;
  const rules = getEuRules();

  const items = boxes.map((box, index) => {
    const m = calculateGirthAndWeight(box.length, box.width, box.height, volDivisor);
    const actualWeight = box.weight;
    const rateInfo = getEuRateByCountryAndWeight(countryId, m.chargedWeight);
    const baseFreight = m.chargedWeight * rateInfo.unitPrice;
    const { surcharge, detail } = calculateEuSurcharge({ ...m, actualWeight }, rules);

    return {
      index: index + 1,
      sides: `${box.length}×${box.width}×${box.height}`,
      girth: m.girth,
      volume: m.volume,
      actualWeight,
      chargedWeight: m.chargedWeight,
      unitPrice: rateInfo.unitPrice,
      baseFreight: round2(baseFreight),
      surcharge: round2(surcharge),
      surchargeDetail: detail,
      total: round2(baseFreight + surcharge),
    };
  });

  return {
    country: rate.country_name,
    boxes: items,
    summary: summarize(items),
  };
}

// ---------- 窗口 ----------
async function createWindow() {
  SQL = await initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
  initDb();

  const win = new BrowserWindow({
    width: 1180,
    height: 900,
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
ipcMain.handle('get-us-rates', () => {
  const rows = db.exec('SELECT * FROM us_rates ORDER BY id');
  if (!rows.length) return [];
  return rows[0].values.map(v =>
    v.reduce((obj, val, i) => {
      obj[rows[0].columns[i]] = val;
      return obj;
    }, {})
  );
});

ipcMain.handle('get-eu-rates', () => {
  const rows = db.exec('SELECT * FROM eu_rates ORDER BY id');
  if (!rows.length) return [];
  return rows[0].values.map(v =>
    v.reduce((obj, val, i) => {
      obj[rows[0].columns[i]] = val;
      return obj;
    }, {})
  );
});

ipcMain.handle('calculate-us', (event, data) => {
  return calculateUs(data.zip, data.boxes);
});

ipcMain.handle('calculate-eu', (event, data) => {
  return calculateEu(data.countryId, data.boxes);
});

ipcMain.handle('update-us-rate', (event, data) => {
  const stmt = db.prepare(`
    UPDATE us_rates SET weight_10 = ?, weight_21 = ?, weight_71 = ?, weight_101 = ? WHERE id = ?
  `);
  stmt.run([data.weight_10, data.weight_21, data.weight_71, data.weight_101, data.id]);
  stmt.free();
  saveDb();
  return true;
});

ipcMain.handle('update-eu-rate', (event, data) => {
  const stmt = db.prepare(`
    UPDATE eu_rates SET weight_10 = ?, weight_21 = ?, weight_101 = ? WHERE id = ?
  `);
  stmt.run([data.weight_10, data.weight_21, data.weight_101, data.id]);
  stmt.free();
  saveDb();
  return true;
});

ipcMain.handle('get-settings', () => {
  return {
    volDivisor: toNum(getSetting('vol_divisor', DEFAULT_VOL_DIVISOR), DEFAULT_VOL_DIVISOR),
    usSurcharge: getUsSurchargeConfig(),
    euRules: getEuRules(),
  };
});

ipcMain.handle('update-settings', (event, data) => {
  const c = data.usSurcharge || {};
  setSetting('vol_divisor', toNum(data.volDivisor, DEFAULT_VOL_DIVISOR));

  const stmt = db.prepare(`
    UPDATE us_surcharge_config SET
      oversize_girth = ?, oversize_volume = ?, oversize_weight = ?, oversize_fee = ?,
      weight_threshold = ?, weight_fee = ?, girth_threshold = ?, girth_fee = ?,
      side_long_threshold = ?, side_second_threshold = ?, side_fee = ?
    WHERE id = 1
  `);
  stmt.run([
    toNum(c.oversize_girth, DEFAULT_US_SURCHARGE.oversize_girth),
    toNum(c.oversize_volume, DEFAULT_US_SURCHARGE.oversize_volume),
    toNum(c.oversize_weight, DEFAULT_US_SURCHARGE.oversize_weight),
    toNum(c.oversize_fee, DEFAULT_US_SURCHARGE.oversize_fee),
    toNum(c.weight_threshold, DEFAULT_US_SURCHARGE.weight_threshold),
    toNum(c.weight_fee, DEFAULT_US_SURCHARGE.weight_fee),
    toNum(c.girth_threshold, DEFAULT_US_SURCHARGE.girth_threshold),
    toNum(c.girth_fee, DEFAULT_US_SURCHARGE.girth_fee),
    toNum(c.side_long_threshold, DEFAULT_US_SURCHARGE.side_long_threshold),
    toNum(c.side_second_threshold, DEFAULT_US_SURCHARGE.side_second_threshold),
    toNum(c.side_fee, DEFAULT_US_SURCHARGE.side_fee),
  ]);
  stmt.free();
  saveDb();
  return true;
});

ipcMain.handle('add-eu-rule', () => {
  db.run(`INSERT INTO eu_surcharge_rules (rule_type, threshold, amount, enabled) VALUES ('girth', 300, 300, 1)`);
  saveDb();
  return getEuRules();
});

ipcMain.handle('update-eu-rule', (event, data) => {
  const stmt = db.prepare(`
    UPDATE eu_surcharge_rules SET rule_type = ?, threshold = ?, amount = ?, enabled = ? WHERE id = ?
  `);
  stmt.run([
    data.rule_type === 'weight' ? 'weight' : 'girth',
    toNum(data.threshold, 0),
    toNum(data.amount, 0),
    Number(data.enabled) === 1 ? 1 : 0,
    data.id,
  ]);
  stmt.free();
  saveDb();
  return getEuRules();
});

ipcMain.handle('delete-eu-rule', (event, data) => {
  db.run(`DELETE FROM eu_surcharge_rules WHERE id = ?`, [data.id]);
  saveDb();
  return getEuRules();
});

ipcMain.handle('reset-database', () => {
  db.close();
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  db = new SQL.Database();
  seedData();
  saveDb();
  return true;
});

// 供自动化测试调用（作为 Electron 入口运行时无副作用）
module.exports = { calculateUs, calculateEu };
