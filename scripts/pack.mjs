import path from 'node:path';
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 相对 app 根目录的忽略规则（正则匹配的是 “/” 开头的相对路径）
const ignore = [
  /^\/dist($|\/)/, // 旧 electron-builder 产物
  /^\/dist-pack($|\/)/, // 当前打包输出目录
  /^\/build($|\/)/,
  /^\/start\.log$/,
  /^\/\.git($|\/)/,
];

const appPaths = await packager({
  dir: root,
  name: '运费大师',
  platform: 'win32',
  arch: 'x64',
  out: path.join(root, 'dist-pack'),
  overwrite: true,
  prune: true, // 只保留生产依赖，剔除 electron 等开发依赖
  ignore,
  appVersion: '1.0.0',
  win32metadata: {
    CompanyName: 'Freight Master',
    FileDescription: '运费大师 - 美国/欧洲海运运费计算器',
    ProductName: '运费大师',
  },
  // 准备好 icon.ico 后可启用下面一行（必须是 256x256 的 .ico）
  // icon: path.join(root, 'assets', 'icon.ico'),
});

// 首次打包时把现有数据库复制到 exe 同级目录，保留已改过的价格（已存在则不覆盖）
const dbSource = path.join(root, 'freight-master.db');
for (const p of appPaths) {
  const dbTarget = path.join(p, 'freight-master.db');
  if (existsSync(dbSource) && !existsSync(dbTarget)) {
    copyFileSync(dbSource, dbTarget);
    console.log('已带入现有数据库：' + dbTarget);
  }
}

console.log('\n打包完成，输出目录：');
for (const p of appPaths) {
  console.log('  ' + p);
}
