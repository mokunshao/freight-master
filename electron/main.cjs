// Electron 主进程
//
// 为什么不起 file:// 直接打开：Electron 里 file:// 是不透明源，Chromium 会拒绝 localStorage
// （"Access is denied for this document"），而运费大师的配置全部存在 localStorage。
// 所以这里先在本地起一个只监听 127.0.0.1 的静态服务，再让窗口加载 http://127.0.0.1:<随机端口>/。
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// 开发时 __dirname = <项目根>/electron；打包后 = <...>/resources/app.asar/electron
// 两种情况都指向「应用根目录」
const APP_ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function createStaticServer(root) {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }).end('405 Method Not Allowed');
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch (err) {
      res.writeHead(400).end('400 Bad Request');
      return;
    }
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(root, rel);
    // 目录穿越防护 + 不服务隐藏文件
    if ((filePath !== root && !filePath.startsWith(root + path.sep)) || path.basename(rel).startsWith('.')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('403 Forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// 端口传 0 = 让系统分配一个空闲端口，避免和别的服务抢占
function startServer(root) {
  return new Promise((resolve, reject) => {
    const server = createStaticServer(root);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

let mainWindow = null;

async function createWindow(url) {
  mainWindow = new BrowserWindow({
    title: '运费大师',
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#f6f8fa',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.webContents.on('did-fail-load', (event, code, desc) => {
    dialog.showErrorBox('页面加载失败', `${desc}（错误码 ${code}）`);
  });

  // 外链交给系统浏览器，别在应用里开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadURL(url);

  if (process.env.FREIGHT_OPEN_DEVTOOLS === '1') mainWindow.webContents.openDevTools();
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [{ label: '退出', accelerator: 'Alt+F4', role: 'quit' }],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'Ctrl+R', role: 'reload' },
        { label: '实际大小', accelerator: 'Ctrl+0', role: 'resetZoom' },
        { label: '放大', accelerator: 'Ctrl+=', role: 'zoomIn' },
        { label: '缩小', accelerator: 'Ctrl+-', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' },
        { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: '运费大师',
              detail: `版本 ${app.getVersion()}　·　Electron ${process.versions.electron}`,
              buttons: ['好的'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot() {
  const { port } = await startServer(APP_ROOT);
  buildMenu();
  await createWindow(`http://127.0.0.1:${port}/index.html`);
}

// 只允许一个实例：再启动一次就把已有窗口拉到前台
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(boot).catch(err => {
    dialog.showErrorBox('启动失败', String((err && err.message) || err));
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && mainWindow) mainWindow.show();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
