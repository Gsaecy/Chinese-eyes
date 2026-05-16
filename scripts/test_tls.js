/**
 * TLS 连接测试 —— 测试不同密码套件层级
 * 
 * 重点测试 CBC vs GCM 的 BAD_DECRYPT 问题
 * 
 * 用法：node scripts/test_tls.js
 *       $env:OPENSSL_ia32cap="~0x200000200000000"; node scripts/test_tls.js
 *       $env:LOCAL_PROXY="http://127.0.0.1:8080"; node scripts/test_tls.js
 */

const https = require('https');
const http = require('http');
const tls = require('tls');

// ============================================================
//  密码套件定义（与 src/tlsCompat.ts 保持一致）
// ============================================================

const CIPHERS_CBC = [
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'ECDHE-RSA-AES128-SHA256',
  'ECDHE-RSA-AES256-SHA384',
  'AES128-SHA',
  'AES256-SHA',
  'AES128-SHA256',
  'AES256-SHA256',
];

const CIPHERS_CHACHA20 = [
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
];

const CIPHERS_GCM = [
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
];

const CIPHERS_ALL = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  ...CIPHERS_CBC,
  ...CIPHERS_CHACHA20,
  ...CIPHERS_GCM,
];

// ============================================================
//  测试配置
// ============================================================

const TEST_URL = 'https://marketplace.visualstudio.com/';

const TEST_CASES = [
  {
    name: 'Level 1: AES-CBC 优先（推荐）',
    ciphers: [...CIPHERS_CBC, ...CIPHERS_CHACHA20, ...CIPHERS_GCM].join(':'),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
  },
  {
    name: 'Level 2: 仅 CBC + ChaCha20（避免 GCM）',
    ciphers: [...CIPHERS_CBC, ...CIPHERS_CHACHA20].join(':'),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
  },
  {
    name: 'Level 3: 仅 CBC（最保守）',
    ciphers: CIPHERS_CBC.join(':'),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
  },
  {
    name: 'Level 4: CBC + GCM（标准）',
    ciphers: [...CIPHERS_CBC, ...CIPHERS_CHACHA20, ...CIPHERS_GCM].join(':'),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
  },
  {
    name: 'Level 5: 系统默认',
    ciphers: undefined,
    minVersion: 'TLSv1',
    maxVersion: undefined,
  },
];

// ============================================================
//  环境信息
// ============================================================

console.log('='.repeat(70));
console.log('  CHINESE EYES - TLS 密码套件兼容性测试');
console.log('='.repeat(70));
console.log();
console.log('Node.js 版本:', process.version);
console.log('OpenSSL 版本:', process.versions.openssl);
console.log('平台:', process.platform, process.arch);
console.log('OPENSSL_ia32cap:', process.env.OPENSSL_ia32cap || '(未设置)');
console.log('NODE_OPTIONS:', process.env.NODE_OPTIONS || '(未设置)');
console.log('LOCAL_PROXY:', process.env.LOCAL_PROXY || '(未设置)');
console.log();

// ============================================================
//  测试函数
// ============================================================

function testHttps(url, options) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = https.get(url, {
      timeout: 10000,
      rejectUnauthorized: false,
      ...options,
    }, (res) => {
      const elapsed = Date.now() - start;
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          success: true,
          statusCode: res.statusCode,
          elapsed: elapsed + 'ms',
          tlsVersion: res.socket && res.socket.getProtocol ? res.socket.getProtocol() : 'unknown',
          cipher: res.socket && res.socket.getCipher ? res.socket.getCipher().name : 'unknown',
        });
      });
    });
    req.on('error', (err) => {
      resolve({ success: false, error: err.message, code: err.code });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'timeout', code: 'TIMEOUT' });
    });
  });
}

function testWithSecureContext(url, name, ciphers, minVersion, maxVersion) {
  return new Promise(async (resolve) => {
    console.log();
    console.log('-'.repeat(70));
    console.log(`  [${name}]`);
    console.log('-'.repeat(70));
    console.log(`  密码: ${(ciphers || '系统默认').substring(0, 60)}...`);
    console.log(`  TLS: ${minVersion || '默认'} ~ ${maxVersion || '默认'}`);

    try {
      const ctx = tls.createSecureContext({
        ciphers: ciphers,
        honorCipherOrder: true,
        minVersion: minVersion,
        maxVersion: maxVersion,
      });
      console.log('  安全上下文: ✅ 创建成功');

      const agent = new https.Agent({
        secureContext: ctx,
        keepAlive: true,
      });

      const result = await testHttps(url, { agent });
      if (result.success) {
        console.log(`  ✅ 连接成功 | HTTP ${result.statusCode} | ${result.elapsed} | ${result.tlsVersion} | ${result.cipher}`);
      } else {
        console.log(`  ❌ 连接失败 | ${result.error} (${result.code})`);
        console.log('  ⚠ 如果出现 BAD_DECRYPT 错误，请尝试更低级别的密码套件');
      }

      agent.destroy();
      resolve(result);
    } catch (e) {
      console.log(`  ❌ 安全上下文创建失败: ${e.message}`);
      resolve({ success: false, error: e.message });
    }
  });
}

// ============================================================
//  运行测试
// ============================================================

async function runTests() {
  // 测试所有层级
  for (const testCase of TEST_CASES) {
    await testWithSecureContext(
      TEST_URL,
      testCase.name,
      testCase.ciphers,
      testCase.minVersion,
      testCase.maxVersion
    );
  }

  // 汇总
  console.log();
  console.log('='.repeat(70));
  console.log('  测试完成 - 结果总结');
  console.log('='.repeat(70));
  console.log();
  console.log('  如果 Level 1 失败但 Level 2/3 成功，说明是 GCM BAD_DECRYPT 问题。');
  console.log('  扩展应自动降级到兼容的密码套件。');
  console.log();
  console.log('  如果所有层级都失败：');
  console.log('    1. 检查网络连接');
  console.log('    2. 尝试 $env:LOCAL_PROXY="http://127.0.0.1:8080"');
  console.log('    3. 运行 scripts/fix-tls.ps1');
  console.log();
}

runTests().catch(console.error);
