// Electron 主进程
//
// 为什么不起 file:// 直接打开：Electron 里 file:// 是不透明源，Chromium 会拒绝 localStorage
// （"Access is denied for this document"），而运费大师的配置全部存在 localStorage。
//
// 为什么也不用 http://127.0.0.1:<随机端口>：localStorage 是按「源（协议 + 主机 + 端口）」存的，
// 端口每次都变 → 每次启动都是一个全新的源 → 上次保存的配置全部读不到（看起来像数据丢失）。
// 所以现在用自定义协议 app://freight-master/ 提供页面：源永远不变，端口完全不参与。
// （万一 app:// 注册失败，才回退到「固定端口」的本地 HTTP 服务，见 boot()）
const { app, BrowserWindow, Menu, shell, dialog, protocol } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// 开发时 __dirname = <项目根>/electron；打包后 = <...>/resources/app.asar/electron
// 两种情况都指向「应用根目录」
const APP_ROOT = path.join(__dirname, '..');

const APP_SCHEME = 'app';
const APP_HOST = 'freight-master'; // 源固定为 app://freight-master

// registerSchemesAsPrivileged 必须在 app ready 之前调用，所以放在模块顶层执行
// standard: true 让自定义协议按标准源处理 —— localStorage 等存储 API 才能用
const usingAppScheme = registerAppScheme();
function registerAppScheme() {
  try {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: APP_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
      },
    ]);
    return true;
  } catch (err) {
    console.error('[main] 注册 app:// 协议失败，回退到本地 HTTP 服务：', err);
    return false;
  }
}

// ---------- 便携模式：数据跟 exe 所在的文件夹走 ----------
// 整个文件夹复制一份就是一套完全独立的配置，两份互不影响；
// 把 PORTABLE_DATA_FOLDER 删掉 = 恢复出厂默认数据。
const PORTABLE_DATA_FOLDER = 'data';

// 老版本（数据存在 %APPDATA% 里）升级上来时，把旧数据搬一次到便携目录
function migrateLegacyUserData(newDir, legacyDir) {
  try {
    if (!legacyDir || !fs.existsSync(legacyDir)) return;
    const src = path.join(legacyDir, 'Local Storage');
    const dst = path.join(newDir, 'Local Storage');
    if (!fs.existsSync(src) || fs.existsSync(dst)) return;
    fs.cpSync(src, dst, { recursive: true });
    console.log('[main] 已从旧位置迁移旧配置到便携目录：', legacyDir);
  } catch (err) {
    console.warn('[main] 迁移旧配置失败（不影响启动）：', err && err.message);
  }
}

function setupPortableData() {
  // 只有打包后才这么干：开发时 app.getPath('exe') 是 node_modules 里的 electron.exe，
  // 在那旁边建 data 目录会写到 node_modules 里
  if (!app.isPackaged) return app.getPath('userData');

  const target = path.join(path.dirname(app.getPath('exe')), PORTABLE_DATA_FOLDER);
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.accessSync(target, fs.constants.W_OK); // 装到 Program Files 这类只读位置时写不了
    const legacyDir = app.getPath('userData');
    app.setPath('userData', target); // 必须在 app ready 之前 / session 使用之前设置
    migrateLegacyUserData(target, legacyDir);
    console.log('[main] 便携数据目录：', target);
    return target;
  } catch (err) {
    console.warn('[main] 无法在 exe 旁创建数据目录，改用系统默认位置：', err && err.message);
    return app.getPath('userData');
  }
}

// 要在 requestSingleInstanceLock 之前执行：单实例锁是按 userData 区分的，
// 这样「复制出来的那一份」和原本那一份可以同时运行、各用自己的数据
const dataDir = setupPortableData();

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

const TEXT_TYPE = 'text/plain; charset=utf-8';

// 把 URL 路径解析成本地文件：返回 { filePath } 或 { status, text }（目录穿越 / 隐藏文件 / 不存在都拦掉）
function resolveStaticFile(pathname) {
  let decoded = '/';
  try {
    decoded = decodeURIComponent(pathname || '/');
  } catch (err) {
    return { status: 400, text: '400 Bad Request' };
  }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (path.basename(rel).startsWith('.')) return { status: 403, text: '403 Forbidden' };
  const filePath = path.resolve(APP_ROOT, rel);
  if (filePath !== APP_ROOT && !filePath.startsWith(APP_ROOT + path.sep)) {
    return { status: 403, text: '403 Forbidden' };
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { status: 404, text: '404 Not Found' };
  }
  return { filePath };
}

function contentTypeOf(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// app://freight-master/... → 直接读本地文件，源固定不变（localStorage 才不会丢）
function registerAppHandlers() {
  protocol.handle(APP_SCHEME, req => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('405 Method Not Allowed', { status: 405, headers: { 'Content-Type': TEXT_TYPE } });
    }
    let pathname = '/';
    try {
      pathname = new URL(req.url).pathname;
    } catch (err) {
      return new Response('400 Bad Request', { status: 400, headers: { 'Content-Type': TEXT_TYPE } });
    }
    const found = resolveStaticFile(pathname);
    if (found.status) {
      return new Response(found.text, { status: found.status, headers: { 'Content-Type': TEXT_TYPE } });
    }
    const body = req.method === 'HEAD' ? null : fs.readFileSync(found.filePath);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': contentTypeOf(found.filePath), 'Cache-Control': 'no-cache' },
    });
  });
}

function createStaticServer() {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': TEXT_TYPE }).end('405 Method Not Allowed');
      return;
    }
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch (err) {
      res.writeHead(400, { 'Content-Type': TEXT_TYPE }).end('400 Bad Request');
      return;
    }
    const found = resolveStaticFile(pathname);
    if (found.status) {
      res.writeHead(found.status, { 'Content-Type': TEXT_TYPE }).end(found.text);
      return;
    }
    res.writeHead(200, { 'Content-Type': contentTypeOf(found.filePath), 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(found.filePath).pipe(res);
  });
}

// 兜底的 HTTP 服务：端口必须固定（或沿用上次那个），否则源一变 localStorage 就丢
const FALLBACK_PORT = 45731;
// app:// 注册失败时的兜底端口；务必固定，否则源每次变、数据就会丢
function portFilePath() {
  return path.join(app.getPath('userData'), 'local-server-port');
}

function preferredPort() {
  try {
    return Number(fs.readFileSync(portFilePath(), 'utf8').trim()) || FALLBACK_PORT;
  } catch (err) {
    return FALLBACK_PORT;
  }
}

function rememberPort(port) {
  try {
    fs.writeFileSync(portFilePath(), String(port));
  } catch (err) {
    /* 记不住就算了，下次从默认端口开始试 */
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(port));
  });
}

async function startServer() {
  const start = preferredPort();
  for (let offset = 0; offset < 20; offset++) {
    const port = start + offset;
    const server = createStaticServer();
    try {
      await listen(server, port);
      rememberPort(port);
      return { server, port };
    } catch (err) {
      server.close();
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`找不到可用的本地端口（从 ${start} 开始试了 20 个）`);
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
          label: '打开数据目录',
          click: () => {
            shell.openPath(dataDir); // 便携模式下就是 exe 旁边的 data 文件夹
          },
        },
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
  console.log('[main] 数据目录：', dataDir);
  buildMenu();
  if (usingAppScheme) {
    // 首选：固定源 app://freight-master（源头完全稳定，localStorage 不会丢）
    registerAppHandlers();
    await createWindow(`${APP_SCHEME}://${APP_HOST}/index.html`);
    return;
  }
  // 兜底：本地 HTTP 服务（端口固定 / 沿用上次，尽量保持源不变）
  const { port } = await startServer();
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
