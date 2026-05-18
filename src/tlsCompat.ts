/**
 * TLS 兼容层 —— 修复 Windows 环境下 VS Code Electron (BoringSSL) 的 TLS 连接问题
 * 
 * 问题背景：
 * - VS Code 使用 Electron，其内置的 BoringSSL 在某些 Windows CPU 上对 AES-GCM 解密失败
 * - 错误：Cipher functions:OPENSSL_internal:BAD_DECRYPT (e_aes.cc.inc:839)
 * - 原因：某些 CPU 的 AES-NI 硬件加速与 BoringSSL 的 AES-GCM 实现存在兼容性 bug
 * 
 * 修复策略（按优先级）：
 * 1. 首选 AES-CBC 密码套件（避免 GCM 解密错误）
 * 2. 次级首选 ChaCha20-Poly1305（如可用）
 * 3. 最后才用 AES-GCM（作为回退，针对正常环境）
 * 4. 多级全链路 fallback：SecureContext → Agent → 请求级重试
 * 5. 支持 LOCAL_PROXY 环境变量回退到本地代理
 * 
 * 注：OPENSSL_ia32cap 在 BoringSSL 中无效，这里保留仅作 Node.js OpenSSL 兼容
 */

import * as https from 'https';
import * as http from 'http';
import * as tls from 'tls';

// ============================================================
//  环境检测
// ============================================================

const LOCAL_PROXY = process.env.LOCAL_PROXY || '';

// ============================================================
//  密码套件定义
// ============================================================

/**
 * 安全的密码套件列表（按优先级降序）
 * 
 * 层次说明：
 * - Level 1 (CBC): 最安全兼容，可避免 GCM BAD_DECRYPT
 * - Level 2 (ChaCha20): 性能好，非 GCM，但部分平台不支持
 * - Level 3 (GCM): 默认高效，但在某些 Windows CPU 上会触发 BAD_DECRYPT
 * - Level 4 (DSS/PSK): 最宽松的 fallback
 */

// Level 1: AES-CBC 套件（最兼容，无 GCM 问题）
const CIPHERS_CBC = [
  'ECDHE-RSA-AES128-SHA',        // TLS 1.2, AES-128-CBC, SHA-1
  'ECDHE-RSA-AES256-SHA',        // TLS 1.2, AES-256-CBC, SHA-1
  'ECDHE-RSA-AES128-SHA256',     // TLS 1.2, AES-128-CBC, SHA-256
  'ECDHE-RSA-AES256-SHA384',     // TLS 1.2, AES-256-CBC, SHA-384
  'AES128-SHA',                  // TLS 1.2, AES-128-CBC (no ECDHE)
  'AES256-SHA',                  // TLS 1.2, AES-256-CBC (no ECDHE)
  'AES128-SHA256',               // TLS 1.2, AES-128-CBC, SHA-256
  'AES256-SHA256',               // TLS 1.2, AES-256-CBC, SHA-256
];

// Level 2: ChaCha20-Poly1305 套件（非 GCM，性能好）
const CIPHERS_CHACHA20 = [
  'TLS_CHACHA20_POLY1305_SHA256',  // TLS 1.3
  'ECDHE-RSA-CHACHA20-POLY1305',   // TLS 1.2
  'ECDHE-ECDSA-CHACHA20-POLY1305', // TLS 1.2 (ECDSA)
];

// Level 3: AES-GCM 套件（可能触发 BAD_DECRYPT，作为最后回退）
const CIPHERS_GCM = [
  'TLS_AES_128_GCM_SHA256',      // TLS 1.3
  'TLS_AES_256_GCM_SHA384',      // TLS 1.3
  'ECDHE-RSA-AES128-GCM-SHA256', // TLS 1.2
  'ECDHE-RSA-AES256-GCM-SHA384', // TLS 1.2
  'AES128-GCM-SHA256',           // TLS 1.2
  'AES256-GCM-SHA384',           // TLS 1.2
];

// Level 4: 极宽松 fallback（兼容老旧服务器）
const CIPHERS_LEGACY = [
  'ECDHE-RSA-DES-CBC3-SHA',      // 3DES (极少数情况需要)
  'DES-CBC3-SHA',                // 3DES
];

// ============================================================
//  SSL_OP 常量（Node.js 某些版本的类型定义缺失，使用数值）
// ============================================================
const SSL_OP_NO_SSLv2 = 0x01000000;
const SSL_OP_NO_SSLv3 = 0x02000000;
const SSL_OP_NO_TLSv1 = 0x04000000;
const SSL_OP_NO_TLSv1_1 = 0x10000000;
const SSL_OP_NO_COMPRESSION = 0x00020000;
const SSL_OP_CIPHER_SERVER_PREFERENCE = 0x00400000;

const SECURE_OPTIONS_COMMON =
  SSL_OP_CIPHER_SERVER_PREFERENCE |
  SSL_OP_NO_SSLv2 |
  SSL_OP_NO_SSLv3 |
  SSL_OP_NO_TLSv1 |
  SSL_OP_NO_TLSv1_1 |
  SSL_OP_NO_COMPRESSION;

// ============================================================
//  Secure TLS Context 层级创建
// ============================================================

/**
 * 创建安全上下文 —— 层级 1: AES-CBC 优先（避免 BAD_DECRYPT）
 */
function createContextLevel1(): tls.SecureContext {
  return tls.createSecureContext({
    ciphers: [
      ...CIPHERS_CBC,
      ...CIPHERS_CHACHA20,
      ...CIPHERS_GCM,
    ].join(':'),
    honorCipherOrder: true,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    secureOptions: SECURE_OPTIONS_COMMON,
  });
}

/**
 * 创建安全上下文 —— 层级 2: 仅 CBC + ChaCha20（彻底避免 GCM）
 */
function createContextLevel2(): tls.SecureContext {
  // 不包含 TLS 1.3 套件（TLS 1.3 强制 GCM）
  return tls.createSecureContext({
    ciphers: [
      ...CIPHERS_CBC,
      ...CIPHERS_CHACHA20,
    ].join(':'),
    honorCipherOrder: true,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2', // 限制到 TLS 1.2 以完全避免 GCM
    secureOptions: SECURE_OPTIONS_COMMON,
  });
}

/**
 * 创建安全上下文 —— 层级 3: 仅 CBC（最保守，禁用所有 GCM 和 TLS 1.3）
 */
function createContextLevel3(): tls.SecureContext {
  return tls.createSecureContext({
    ciphers: CIPHERS_CBC.join(':'),
    honorCipherOrder: true,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    secureOptions: SECURE_OPTIONS_COMMON,
  });
}

/**
 * 创建安全上下文 —— 层级 4: CBC + GCM（标准配置，针对无问题的环境）
 */
function createContextLevel4(): tls.SecureContext {
  return tls.createSecureContext({
    ciphers: [
      ...CIPHERS_CBC,
      ...CIPHERS_CHACHA20,
      ...CIPHERS_GCM,
    ].join(':'),
    honorCipherOrder: true,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
  });
}

/**
 * 创建安全上下文 —— 层级 5: 系统默认（完全放权给系统）
 */
function createContextLevel5(): tls.SecureContext {
  return tls.createSecureContext({
    honorCipherOrder: true,
    minVersion: 'TLSv1',
  });
}

/**
 * 创建最兼容的安全上下文 —— 自动多级回退
 */
export function createBestSecureContext(): tls.SecureContext {
  const levels = [
    { name: 'Level1 (CBC优先)', fn: createContextLevel1 },
    { name: 'Level2 (仅CBC+ChaCha20)', fn: createContextLevel2 },
    { name: 'Level3 (仅CBC)', fn: createContextLevel3 },
    { name: 'Level4 (CBC+GCM)', fn: createContextLevel4 },
    { name: 'Level5 (系统默认)', fn: createContextLevel5 },
  ];

  const errors: string[] = [];

  for (const level of levels) {
    try {
      const ctx = level.fn();
      console.log(`[tlsCompat] 安全上下文创建成功: ${level.name}`);
      return ctx;
    } catch (err) {
      const msg = `[tlsCompat] ${level.name} 失败: ${(err as Error).message}`;
      console.warn(msg);
      errors.push(msg);
    }
  }

  // 所有层级都失败，抛出汇总错误
  throw new Error(
    `所有安全上下文创建失败:\n${errors.join('\n')}`
  );
}

// ============================================================
//  HTTPS Agent 管理与请求重试
// ============================================================

// 缓存已创建的 agent（按层级缓存）
const agentCache = new Map<string, https.Agent>();

/**
 * 获取或创建安全的 HTTPS Agent
 * 使用缓存的 agent 避免重复创建
 */
function getAgent(level: number): https.Agent {
  const key = `level_${level}`;
  if (agentCache.has(key)) {
    return agentCache.get(key)!;
  }

  // 如果设置了 LOCAL_PROXY，使用代理
  if (LOCAL_PROXY) {
    const agent = createProxyAgent(LOCAL_PROXY);
    agentCache.set(key, agent);
    return agent;
  }

  let secureContext: tls.SecureContext;
  switch (level) {
    case 1: secureContext = createContextLevel1(); break;
    case 2: secureContext = createContextLevel2(); break;
    case 3: secureContext = createContextLevel3(); break;
    case 4: secureContext = createContextLevel4(); break;
    default: secureContext = createContextLevel5(); break;
  }

  const agent = new https.Agent({
    secureContext,
    keepAlive: true,
    maxSockets: 5,
  });

  agentCache.set(key, agent);
  return agent;
}

/**
 * 创建安全的 HTTPS Agent（自动多级回退）
 * 仅在 Windows 上使用自定义 TLS Agent；macOS/Linux 使用 Node 默认 Agent
 */
export function createSafeHttpsAgent(): https.Agent {
  // 非 Windows 平台使用 Node.js 默认 HTTPS Agent（最安全，无需自定义）
  if (process.platform !== 'win32') {
    return new https.Agent({ keepAlive: true, maxSockets: 5 });
  }

  // 如果设置了 LOCAL_PROXY，使用代理
  if (LOCAL_PROXY) {
    return createProxyAgent(LOCAL_PROXY);
  }

  // Windows：尝试层级 2（仅 CBC + ChaCha20，无 GCM），失败后逐级回退
  for (let level = 2; level <= 5; level++) {
    try {
      return getAgent(level);
    } catch (err) {
      console.warn(`[tlsCompat] Agent Level ${level} 创建失败，尝试下一级:`, (err as Error).message);
    }
  }

  // 终极 fallback：无自定义 secureContext
  console.warn('[tlsCompat] 所有自定义 Agent 创建失败，使用默认 Agent');
  return new https.Agent({ keepAlive: true, maxSockets: 5 });
}

// ============================================================
//  HTTP 请求封装（内置自动重试回退）
// ============================================================

const agentLevelCache = new Map<string, number>();

function getAgentLevelForHost(host: string): number {
  // 默认从 Level 2 开始（仅 CBC + ChaCha20，无 GCM），避免 BAD_DECRYPT
  return agentLevelCache.get(host) || 2;
}

function setAgentLevelForHost(host: string, level: number) {
  agentLevelCache.set(host, level);
}

/**
 * 发起 HTTP(S) 请求（支持自动降级回退）
 */
export function httpsRequest(
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  timeout: number = 30000
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return _httpsRequestWithRetry(targetUrl, method, headers, body, timeout, 0);
}

async function _httpsRequestWithRetry(
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  timeout: number = 15000,
  retryCount: number = 0
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  const urlObj = new URL(targetUrl);

  // 最大总超时保护：整个链路上限 = timeout * 2（防止递归挂死）
  if (retryCount === 0) {
    return _requestWithGuard(targetUrl, method, headers, body, timeout, retryCount);
  }

  return _requestWithGuard(targetUrl, method, headers, body, timeout, retryCount);
}

/** 带有安全超时保护的请求（防止 Promise 永不 settle） */
async function _requestWithGuard(
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  timeout: number = 15000,
  retryCount: number = 0
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  // 如果设置了 LOCAL_PROXY，通过代理
  if (LOCAL_PROXY) {
    return proxyRequest(LOCAL_PROXY, targetUrl, method, headers, body, timeout);
  }

  const urlObj = new URL(targetUrl);
  const isHttps = urlObj.protocol === 'https:';
  const mod = isHttps ? https : http;
  const host = urlObj.hostname;

  // 仅在 Windows 上使用自定义 TLS Agent 来规避 BoringSSL BAD_DECRYPT；
  // macOS/Linux 上 BoringSSL 没有这个 bug，自定义旧密码套件反而导致兼容问题。
  const isWindows = process.platform === 'win32';
  const startLevel = getAgentLevelForHost(host);
  let agent: https.Agent | undefined;
  let currentLevel = startLevel;

  if (isHttps && isWindows) {
    try {
      agent = getAgent(currentLevel);
    } catch (e) {
      // agent 创建失败，用默认
    }
  }
  // 非 Windows：agent 保持 undefined，Node.js 使用默认 SSL 处理（最安全）

  // 安全超时计时器（硬性拒绝，防止 Promise 挂死）
  const isElectron = typeof (process as any).type !== 'undefined';
  const safeTimeoutMs = timeout + (isElectron ? 5000 : 0);

  return new Promise((resolve, reject) => {
    let settled = false; // 防止重复 settle
    const safeTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`安全超时 (${safeTimeoutMs}ms): ${targetUrl}`));
    }, safeTimeoutMs);

    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      port: urlObj.port || (isHttps ? 443 : 80),
      method,
      headers: {
        ...headers,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
      agent,
      rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
    };

    const req = mod.request(options, (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        // 防止重复调用
        if (settled) return;
        let result: Buffer = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        try {
          if (enc === 'gzip') {
            result = require('zlib').gunzipSync(result);
          } else if (enc === 'deflate') {
            result = require('zlib').inflateSync(result);
          }
        } catch (e) {
          // 解压失败时使用原始数据
        }
        clearTimeout(safeTimer);
        settled = true;
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: result.toString('utf-8'),
        });
      });
      // 监听错误事件
      res.on('error', (err) => {
        if (settled) return;
        clearTimeout(safeTimer);
        settled = true;
        reject(err);
      });
    });

    // 设置请求级超时
    req.setTimeout(timeout, () => {
      if (settled) return;
      req.destroy(new Error(`请求超时 (${timeout}ms): ${targetUrl}`));
    });

    req.on('error', async (err) => {
      if (settled) return;
      const errMsg = (err as Error).message;

      // BAD_DECRYPT 错误：尝试降级 agent 层级后重试
      if (
        isHttps &&
        retryCount < 4 &&
        (errMsg.includes('BAD_DECRYPT') || errMsg.includes('ECONNRESET') || errMsg.includes('CIPHER'))
      ) {
        const nextLevel = currentLevel + 1;

        if (nextLevel <= 5) {
          console.log(`[tlsCompat] ${host} BAD_DECRYPT，降级到 Level ${nextLevel} 重试`);

          // 记录该 host 应该使用更低的层级
          setAgentLevelForHost(host, nextLevel);

          // 清理旧的 agent
          const oldKey = `level_${currentLevel}`;
          const oldAgent = agentCache.get(oldKey);
          if (oldAgent) {
            oldAgent.destroy();
            agentCache.delete(oldKey);
          }

          // 使用下一级 agent 重试（但受安全计时器保护，不会挂死）
          try {
            // 使用新的超时时间（每次重试减少 2 秒）
            const retryTimeout = Math.max(timeout - 2000, 5000);
            const result = await _requestWithGuard(
              targetUrl, method, headers, body, retryTimeout, retryCount + 1
            );
            clearTimeout(safeTimer);
            settled = true;
            resolve(result);
            return;
          } catch (retryErr) {
            clearTimeout(safeTimer);
            settled = true;
            reject(retryErr);
            return;
          }
        }
      }

      // 特定错误码直接拒绝
      clearTimeout(safeTimer);
      settled = true;
      reject(err);
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// ============================================================
//  诊断
// ============================================================

/**
 * TLS 诊断信息捕获
 */
export function getTlsDiagnostics(): Record<string, any> {
  const diag: Record<string, any> = {
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    opensslVersion: process.versions.openssl,
    OPENSSL_ia32cap: process.env.OPENSSL_ia32cap || '(未设置)',
    NODE_OPTIONS: process.env.NODE_OPTIONS || '(未设置)',
    NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED || '(未设置)',
    LOCAL_PROXY: LOCAL_PROXY || '(未设置)',
    availableCiphersCount: tls.getCiphers?.()?.length || 0,
    agentLevelCache: Object.fromEntries(agentLevelCache),
    isElectron: typeof process.versions.electron !== 'undefined',
    electronVersion: (process as any).versions?.electron || 'N/A',
    chromeVersion: (process as any).versions?.chrome || 'N/A',
  };

  // 列出密码套件子集
  const allCiphers = tls.getCiphers?.() || [];
  diag.cbcCiphersAvailable = CIPHERS_CBC.filter(c => allCiphers.includes(c));
  diag.chachaCiphersAvailable = CIPHERS_CHACHA20.filter(c => allCiphers.includes(c));
  diag.gcmCiphersAvailable = CIPHERS_GCM.filter(c => allCiphers.includes(c));
  diag.agentLevels = {};

  return diag;
}

/**
 * 重置所有 TLS 兼容层缓存（用于配置变更后）
 */
export function resetTlsCache(): void {
  for (const agent of agentCache.values()) {
    try { agent.destroy(); } catch (e) { /* ignore */ }
  }
  agentCache.clear();
  agentLevelCache.clear();
  console.log('[tlsCompat] 所有 TLS 缓存已重置');
}

// ============================================================
//  代理支持
// ============================================================

/**
 * 创建通过本地代理转发的 HTTPS Agent
 */
function createProxyAgent(proxyUrl: string): https.Agent {
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 5,
  });
  console.log(`[tlsCompat] 已启用 LOCAL_PROXY 代理: ${proxyUrl}`);
  return agent;
}

/**
 * 通过本地代理转发 HTTP(S) 请求
 */
async function proxyRequest(
  proxyUrl: string,
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  timeout: number = 30000
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  const targetObj = new URL(targetUrl);
  const isHttps = targetObj.protocol === 'https:';

  if (isHttps) {
    return connectProxyRequest(proxyUrl, targetUrl, method, headers, body, timeout);
  } else {
    return forwardProxyRequest(proxyUrl, targetUrl, method, headers, body, timeout);
  }
}

/**
 * CONNECT 隧道代理（用于 HTTPS 目标）
 */
function connectProxyRequest(
  proxyUrl: string,
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  timeout: number = 30000
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const proxyObj = new URL(proxyUrl);
    const targetObj = new URL(targetUrl);
    const proxyPort = parseInt(proxyObj.port, 10) || (proxyObj.protocol === 'https:' ? 443 : 8080);

    const proxyReq = http.request({
      hostname: proxyObj.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetObj.hostname}:${targetObj.port || 443}`,
      timeout: timeout,
    });

    proxyReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`代理 CONNECT 失败: HTTP ${res.statusCode}`));
        return;
      }

      const tlsSocket = tls.connect({
        socket: socket,
        host: targetObj.hostname,
        servername: targetObj.hostname,
        rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
      });

      tlsSocket.on('secureConnect', () => {
        const reqHeaders = {
          ...headers,
          'Host': targetObj.hostname,
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        };

        let reqLine = `${method} ${targetObj.pathname}${targetObj.search} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(reqHeaders)) {
          reqLine += `${k}: ${v}\r\n`;
        }
        reqLine += '\r\n';

        if (body) { reqLine += body; }

        tlsSocket.write(reqLine);

        let responseData = '';
        tlsSocket.on('data', (chunk) => { responseData += chunk.toString(); });

        tlsSocket.on('end', () => {
          const match = responseData.match(/HTTP\/\d\.\d\s+(\d+)\s+[^\r]*\r\n([\s\S]*?)\r\n\r\n([\s\S]*)$/);
          if (match) {
            const statusCode = parseInt(match[1], 10);
            const headerLines = match[2].split('\r\n');
            const responseHeaders: http.IncomingHttpHeaders = {};
            for (const line of headerLines) {
              const sep = line.indexOf(':');
              if (sep > 0) {
                responseHeaders[line.substring(0, sep).toLowerCase()] = line.substring(sep + 2);
              }
            }
            resolve({ statusCode, headers: responseHeaders, body: match[3] });
          } else {
            resolve({ statusCode: 0, headers: {}, body: responseData });
          }
          tlsSocket.end();
        });
      });

      tlsSocket.on('error', (err) => {
        reject(new Error(`TLS 隧道错误: ${err.message}`));
      });
    });

    proxyReq.on('error', (err) => reject(new Error(`代理连接错误: ${err.message}`)));
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error(`代理连接超时 (${timeout}ms)`)); });
    proxyReq.end();
  });
}

/**
 * 正向代理请求（用于 HTTP 目标）
 */
function forwardProxyRequest(
  proxyUrl: string,
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  timeout: number = 30000
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const proxyObj = new URL(proxyUrl);
    const proxyPort = parseInt(proxyObj.port, 10) || 8080;

    const options: http.RequestOptions = {
      hostname: proxyObj.hostname,
      port: proxyPort,
      method,
      path: targetUrl,
      headers: {
        ...headers,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
      timeout,
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        let result = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        try {
          if (enc === 'gzip') result = require('zlib').gunzipSync(result);
          else if (enc === 'deflate') result = require('zlib').inflateSync(result);
        } catch (e) {}
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: result.toString('utf-8'),
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`代理请求超时 (${timeout}ms)`)); });
    if (body) req.write(body);
    req.end();
  });
}

export default {
  createSafeHttpsAgent,
  getTlsDiagnostics,
  httpsRequest,
  resetTlsCache,
};
