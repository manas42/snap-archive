#!/usr/bin/env node
'use strict';

/**
 * tools/serve-https.mjs —— 为 V1 探针提供一个「安全上下文」的托管环境。
 *
 * 为什么需要它：File System Access API（showDirectoryPicker 等）是 [SecureContext] API，
 * 在 http://<局域网IP> 下 API 根本不存在，探针会给出**假阴性**（把路线 A 误杀）。
 * 本脚本用自签证书起一个最小 HTTPS 静态服务器，让手机能真正测试 FSA。
 *
 * 用法：
 *   node tools/serve-https.mjs            # 默认端口 8443
 *   PORT=8443 node tools/serve-https.mjs
 *
 * 手机侧：浏览器打开 https://<这台电脑的局域网IP>:8443/tools/phone-probe.html
 *        证书自签 → 会警告"不安全"，选择「继续访问/高级 → 继续」即可。
 *        注意：点击继续后 isSecureContext 仍为 true，FSA 可以正常测试。
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = path.join(ROOT, '.certs');
const KEY = path.join(CERT_DIR, 'key.pem');
const CRT = path.join(CERT_DIR, 'cert.pem');
const PORT = Number(process.env.PORT || 8443);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

/** 列出本机所有非回环 IPv4，方便手机访问 */
function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function ensureCert(ip) {
  if (fs.existsSync(KEY) && fs.existsSync(CRT)) return;
  fs.mkdirSync(CERT_DIR, { recursive: true });
  console.log('· 正在生成自签证书（含 SAN: ' + ['localhost', '127.0.0.1', ...lanIPs()].join(', ') + '）…');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', KEY, '-out', CRT, '-days', '365',
      '-subj', '/CN=snap-archive-probe',
      '-addext', `subjectAltName=DNS:localhost,IP:127.0.0.1${lanIPs().map((i) => `,IP:${i}`).join('')}`,
    ], { stdio: 'inherit' });
    fs.chmodSync(KEY, 0o600);
  } catch (e) {
    console.error('❌ 生成证书失败（需要 openssl）：', e.message);
    console.error('   Debian/Ubuntu: sudo apt install openssl');
    process.exit(1);
  }
}

ensureCert();

const server = https.createServer(
  { key: fs.readFileSync(KEY), cert: fs.readFileSync(CRT) },
  (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'https://x').pathname); }
    catch { res.writeHead(400).end('Bad Request'); return; }
    if (pathname === '/') pathname = '/tools/phone-probe.html';

    const filePath = path.normalize(path.join(ROOT, pathname));
    if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
      res.writeHead(403).end('Forbidden'); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      }).end(data);
    });
  },
);

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('\n✅ 探针 HTTPS 服务已启动（安全上下文，FSA 可正常测试）');
  console.log('   本机：  https://localhost:' + PORT + '/tools/phone-probe.html');
  for (const ip of ips) console.log('   手机：  https://' + ip + ':' + PORT + '/tools/phone-probe.html');
  if (ips.length === 0) console.log('   ⚠️ 没找到局域网 IPv4 地址，手机可能访问不到');
  console.log('\n   手机首次打开会提示证书不受信任 → 选「高级 / 继续访问」。');
  console.log('   按 Ctrl+C 停止。\n');
});
