// Electron 桌面端入口：只负责窗口与 IPC 桥接，业务逻辑全部在 core.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const core = require('./core.js');

// 开发模式：数据库在项目根目录；打包后（resources/app.asar 只读）：数据库放在 exe 同级目录，方便备份与迁移
const APP_ROOT = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
const DB_FILE = path.join(APP_ROOT, 'freight-master.db');

// ---------- 窗口 ----------
async function createWindow() {
  const SQL = await initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
  core.initCore({ dbFile: DB_FILE, SQL });

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
ipcMain.handle('get-config', () => core.getConfig());

ipcMain.handle('calculate', (event, data) => {
  return core.calculateGroup(data.groupKey, { zip: data.zip, rowId: data.rowId }, data.boxes);
});

ipcMain.handle('save-group', (event, data) => core.saveGroupConfig(data));

ipcMain.handle('add-rate-row', (event, data) => {
  return core.addRateRow(data.groupKey, data.name, data.matchKey);
});

ipcMain.handle('delete-rate-row', (event, data) => {
  return core.deleteRateRow(data.groupKey, data.rowId);
});

ipcMain.handle('set-vol-divisor', (event, value) => core.setVolDivisor(value));

ipcMain.handle('reset-database', () => core.resetDatabase());

// 导出配置：弹保存对话框，写成 JSON
ipcMain.handle('export-config', async () => {
  const picked = await dialog.showSaveDialog({
    title: '导出配置',
    defaultPath: `freight-master-config-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON 配置', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(picked.filePath, JSON.stringify(core.buildExportPayload(), null, 2), 'utf8');
  return { ok: true, filePath: picked.filePath };
});

// 导入配置：弹打开对话框，读取 JSON 并整份覆盖
ipcMain.handle('import-config', async () => {
  const picked = await dialog.showOpenDialog({
    title: '导入配置',
    properties: ['openFile'],
    filters: [{ name: 'JSON 配置', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePaths || !picked.filePaths.length) {
    return { ok: false, canceled: true };
  }
  const raw = fs.readFileSync(picked.filePaths[0], 'utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error('不是有效的 JSON 文件');
  }
  const config = core.applyImportPayload(payload);
  return { ok: true, filePath: picked.filePaths[0], config };
});
