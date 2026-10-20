// 局域网开发服务：把同一套页面与业务逻辑用 HTTP 暴露出来，同事直接用浏览器访问即可
// 用法：npm run serve [-- --host 0.0.0.0 --port 5173]
//       node server.mjs --port 8080 --db ./freight-master.db
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';

const require = createRequire(import.meta.url);
const core = require('./core.js');
const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---------- 启动参数 ----------
const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return !next || next.startsWith('--') ? fallback : next;
}

const HOST = argValue('host', process.env.HOST || '0.0.0.0');
const PORT = Number(argValue('port', process.env.PORT || 5173));
const DB_FILE = path.resolve(argValue('db', process.env.FM_DB || path.join(ROOT, 'freight-master.db')));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

// ---------- 接口 ----------
const API = {
  getConfig: () => core.getConfig(),
  calculate: p => core.calculateGroup(p.groupKey, { zip: p.zip, rowId: p.rowId }, p.boxes),
  saveGroup: p => core.saveGroupConfig(p),
  addRateRow: p => core.addRateRow(p.groupKey, p.name, p.matchKey),
  deleteRateRow: p => core.deleteRateRow(p.groupKey, p.rowId),
  setVolDivisor: p => core.setVolDivisor(p.value),
  resetDatabase: () => core.resetDatabase(),
  exportConfig: () => core.buildExportPayload(),
  importConfig: p => ({ ok: true, config: core.applyImportPayload(p) }),
};

// ---------- 工具 ----------
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 20 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// 只放行页面真正需要的文件，其它一律 404（避免把 main.js / package.json 等源码暴露到局域网）
const STATIC_FILES = new Set(['index.html', 'styles.css', 'renderer.js', 'web-api.js']);

function serveStatic(req, res, pathname) {
  if (pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, rel);
  // 目录穿越防护：必须在项目目录内，且只允许放行清单里的文件
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('403 Forbidden');
    return;
  }
  if (!STATIC_FILES.has(path.relative(ROOT, filePath))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
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
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address);
}

// ---------- 启动 ----------
const SQL = await initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
core.initCore({ dbFile: DB_FILE, SQL });

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (pathname.startsWith('/api/')) {
    const name = pathname.slice('/api/'.length);
    const handler = API[name];
    if (!handler) return sendJson(res, 404, { error: `未知接口：${name}` });
    if (req.method !== 'POST') return sendJson(res, 405, { error: '请使用 POST' });
    try {
      const payload = await readBody(req);
      return sendJson(res, 200, handler(payload));
    } catch (err) {
      return sendJson(res, 400, { error: err.message || '请求处理失败' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }).end('405 Method Not Allowed');
    return;
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  const lines = [
    '运费大师 · 局域网开发服务已启动',
    `数据库：${DB_FILE}`,
    `本机访问：http://localhost:${PORT}`,
  ];
  lanAddresses().forEach(ip => lines.push(`同事访问：http://${ip}:${PORT}`));
  lines.push('', '提示：', '  - 同事打不开请检查 Windows 防火墙是否放行该端口（或临时关闭防火墙验证）');
  lines.push('  - 多人同时改价格会互相覆盖（单文件数据库，最后写入胜出），开发联调够用');
  console.log(lines.join('\n'));
});
