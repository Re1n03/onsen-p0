/**
 * serve.js — 零依赖本地静态服务器（只用 Node 自带模块）
 *
 * 运行：node serve.js
 * 打开：http://localhost:8080
 *
 * 作用：ES 模块（<script type="module">）不能直接用 file:// 打开，所以需要这个小服务器。
 * 端口读 config.UI.PORT（可用环境变量 PORT 覆盖）。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI } from './config.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url)); // 以本文件所在目录为网站根目录
const PORT = Number(process.env.PORT) || UI.PORT;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = resolve(ROOT, relative);

    // 防止 ../ 跳出网站根目录
    if (!filePath.startsWith(ROOT)) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('403');
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch (error) {
    const status = error.code === 403 ? 403 : 404;
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(String(status));
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用：可能已经有一个 node serve.js 在跑了。`);
    console.error(`直接打开 http://localhost:${PORT} 即可；要换端口可以用 PORT=8081 node serve.js。`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, () => {
  console.log(`温泉馆开门了：http://localhost:${PORT}`);
});
