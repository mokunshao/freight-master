const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

// 开发模式：数据库在项目根目录；打包后（resources/app.asar 只读）：数据库放在 exe 同级目录，方便备份与迁移
const APP_ROOT = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
const DB_FILE = path.join(APP_ROOT, 'freight-master.db');

let db = null;
let SQL = null;

function initDb() {
  if (fs.existsSync(DB_FILE)) {
    const filebuffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(filebuffer);
  } else {
    db = new SQL.Database();
    seedData();
    saveDb();
  }
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

function seedData() {
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

  db.run(`
    CREATE TABLE eu_rates (
      id INTEGER PRIMARY KEY,
      country_name TEXT NOT NULL,
      weight_10 REAL NOT NULL,
      weight_21 REAL NOT NULL,
      weight_101 REAL NOT NULL
    );
  `);

  const usStmt = db.prepare(`
    INSERT INTO us_rates (region_name, zip_prefixes, weight_10, weight_21, weight_71, weight_101)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  usStmt.run(['美西（邮编8,9开头）', '8,9', 16.7, 15.2, 13.2, 12.2]);
  usStmt.run(['美中（邮编4,5,6,7开头）', '4,5,6,7', 17.7, 16.2, 14.2, 13.2]);
  usStmt.run(['美东（邮编0,1,2,3开头）', '0,1,2,3', 18.7, 17.2, 15.2, 14.2]);
  usStmt.free();

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

function getUsRegionByZip(zip) {
  const first = String(zip).trim()[0];
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

function calculateGirthAndWeight(length, width, height) {
  const sides = [length, width, height].map(Number).sort((a, b) => a - b);
  const girth = (sides[0] + sides[1]) * 2 + sides[2];
  const volume = length * width * height;
  const chargedWeight = Math.ceil(volume / 6000);
  return {
    sides,
    girth,
    volume,
    chargedWeight,
    longest: sides[2],
    secondLongest: sides[1]
  };
}

function calculateUs(zip, length, width, height, actualWeight) {
  const region = getUsRegionByZip(zip);
  if (!region) throw new Error('无法识别的美国邮编，请检查输入');

  const { sides, girth, volume, chargedWeight, longest, secondLongest } = calculateGirthAndWeight(length, width, height);
  const unitPrice = getUsRateByWeight(region, chargedWeight);
  const baseFreight = chargedWeight * unitPrice;

  let surcharge = 0;
  let surchargeDetail = [];

  if (girth > 330 || volume >= 283168 || actualWeight > 50) {
    surcharge = 500;
    surchargeDetail.push('超大件附加费 +500 元（围长>330 或 体积≥283168 或 实重>50KG）');
  } else {
    if (actualWeight > 22.5) {
      surcharge += 120;
      surchargeDetail.push('实重超22.5KG +120 元');
    }
    if (girth > 265) {
      surcharge += 120;
      surchargeDetail.push('围长超265 +120 元');
    }
    if (longest > 120 || secondLongest > 75) {
      surcharge += 120;
      surchargeDetail.push('最长边超120CM 或 次长边超75CM +120 元');
    }
  }

  return {
    region: region.region_name,
    zip,
    sides: `${length}×${width}×${height}`,
    girth,
    volume,
    actualWeight,
    chargedWeight,
    unitPrice,
    baseFreight,
    surcharge,
    surchargeDetail,
    total: baseFreight + surcharge
  };
}

function calculateEu(countryId, length, width, height, actualWeight) {
  const rate = getEuRateByCountryAndWeight(countryId, 0);
  if (!rate) throw new Error('请选择有效的欧洲国家');

  const { sides, girth, volume, chargedWeight, longest, secondLongest } = calculateGirthAndWeight(length, width, height);
  const rateInfo = getEuRateByCountryAndWeight(countryId, chargedWeight);
  const baseFreight = chargedWeight * rateInfo.unitPrice;

  let surcharge = 0;
  let surchargeDetail = [];

  if (girth >= 330) {
    surcharge = 350;
    surchargeDetail.push('围长≥330 +350 元');
  } else if (girth >= 300) {
    surcharge = 300;
    surchargeDetail.push('围长≥300 +300 元');
  } else if (actualWeight >= 30) {
    surcharge = 300;
    surchargeDetail.push('实重≥30KG +300 元');
  }

  return {
    country: rate.country_name,
    sides: `${length}×${width}×${height}`,
    girth,
    volume,
    actualWeight,
    chargedWeight,
    unitPrice: rateInfo.unitPrice,
    baseFreight,
    surcharge,
    surchargeDetail,
    total: baseFreight + surcharge
  };
}

async function createWindow() {
  SQL = await initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
  initDb();

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: '运费大师',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-us-rates', () => {
  const rows = db.exec('SELECT * FROM us_rates ORDER BY id');
  if (!rows.length) return [];
  return rows[0].values.map(v => v.reduce((obj, val, i) => {
    obj[rows[0].columns[i]] = val;
    return obj;
  }, {}));
});

ipcMain.handle('get-eu-rates', () => {
  const rows = db.exec('SELECT * FROM eu_rates ORDER BY id');
  if (!rows.length) return [];
  return rows[0].values.map(v => v.reduce((obj, val, i) => {
    obj[rows[0].columns[i]] = val;
    return obj;
  }, {}));
});

ipcMain.handle('calculate-us', (event, data) => {
  return calculateUs(data.zip, data.length, data.width, data.height, data.weight);
});

ipcMain.handle('calculate-eu', (event, data) => {
  return calculateEu(data.countryId, data.length, data.width, data.height, data.weight);
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

ipcMain.handle('reset-database', () => {
  db.close();
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  db = new SQL.Database();
  seedData();
  saveDb();
  return true;
});
