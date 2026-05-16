/**
 * TLS 全面诊断脚本
 * 
 * 用法：node scripts/tls_diagnostics.js
 * 也支持：OPENSSL_ia32cap=~0x20000000000000 node scripts/tls_diagnostics.js
 *        NODE_OPTIONS="--tls-min-v1.0 --tls-cipher-list=..." node scripts/tls_diagnostics.js
 */

const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

const TEST_URLS = [
  'https://marketplace.visualstudio.com/',
  'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
  'https://api.github.com/',
  'https://www.google.com/',
];

function printSeparator(title) {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

function testHttps(url, options = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = https.get(url, {
      timeout: 10000,
      rejectUnauthorized: options.rejectUnauthorized !== false,
      ciphers: options.ciphers,
      ...options,
    }, (res) => {
      const elapsed = Date.now() - start;
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          success: true,
          statusCode: res.statusCode,
          elapsed,
          tlsVersion: res.socket?.getProtocol?.() || 'unknown',
          cipher: res.socket?.getCipher?.()?.name || 'unknown',
          dataLength: data.length,
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

async function runDiagnostics() {
  printSeparator('系统环境信息');
  console.log('Node.js 版本:', process.version);
  console.log('平台:', process.platform, process.arch);
  console.log('OpenSSL 版本:', process.versions.openssl);
  console.log('V8 版本:', process.versions.v8);
  console.log('OPENSSL_ia32cap:', process.env.OPENSSL_ia32cap || '(未设置)');
  console.log('NODE_OPTIONS:', process.env.NODE_OPTIONS || '(未设置)');
  console.log('NODE_TLS_REJECT_UNAUTHORIZED:', process.env.NODE_TLS_REJECT_UNAUTHORIZED || '(未设置)');

  printSeparator('TLS/密码套件信息');
  // 列出支持的密码套件
  const ciphers = tls.getCiphers?.() || [];
  console.log('可用密码套件数量:', ciphers.length);
  const relevantCiphers = ciphers.filter(c => 
    c.includes('AES') || c.includes('ECDHE') || c.includes('GCM')
  );
  console.log('相关密码套件:', relevantCiphers.join(', '));

  printSeparator('平台信息');
  console.log('可用加密后端:');
  if (process.versions.openssl) console.log('  - OpenSSL:', process.versions.openssl);
  
  try {
    const signers = crypto.getSigners();
    console.log('支持签名算法数量:', signers?.length || 0);
  } catch(e) {}
  
  try {
    const curves = crypto.getCurves();
    console.log('支持椭圆曲线数量:', curves?.length || 0);
    const relevantCurves = curves.filter(c => c.includes('25519') || c.includes('256') || c.includes('384') || c.includes('521') || c.includes('prime'));
    console.log('相关曲线:', relevantCurves.join(', '));
  } catch(e) {}
  
  // 获取默认 SSL 上下文信息
  try {
    const ctx = tls.createSecureContext({});
    console.log('默认安全上下文创建成功');
  } catch(e) {
    console.log('创建默认安全上下文失败:', e.message);
  }

  printSeparator('基本 TLS 连接测试（默认设置）');
  for (const url of TEST_URLS) {
    console.log(`\n测试: ${url}`);
    const result = await testHttps(url);
    if (result.success) {
      console.log(`  ✅ 成功 | HTTP ${result.statusCode} | ${result.elapsed}ms | TLS ${result.tlsVersion} | 密码套件: ${result.cipher} | 数据: ${result.dataLength} bytes`);
    } else {
      console.log(`  ❌ 失败 | ${result.error} (${result.code})`);
    }
  }

  printSeparator('测试禁用 AES-NI (OPENSSL_ia32cap)');
  // 注意：这个设置需要重启进程才生效，这里只是诊断信息
  console.log('当前 OPENSSL_ia32cap:', process.env.OPENSSL_ia32cap || '(未设置)');
  console.log('提示：新开终端运行以下命令测试禁用 AES-NI:');
  console.log('  SET OPENSSL_ia32cap=~0x200000200000000 && node scripts/tls_diagnostics.js');
  console.log('  或 (PowerShell): $env:OPENSSL_ia32cap="~0x200000200000000"; node scripts/tls_diagnostics.js');

  printSeparator('使用自定义密码套件测试');
  const cipherSuites = [
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES128-SHA256',
    'AES128-GCM-SHA256',
    'AES256-GCM-SHA384',
    'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384',
    // Old but compatible cipher (falls back to OpenSSL 1.x compatible)
    'ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-SHA:AES256-SHA',
  ];
  
  for (const ciphers of cipherSuites) {
    console.log(`\n密码套件: ${ciphers}`);
    const result = await testHttps('https://marketplace.visualstudio.com/', { ciphers });
    if (result.success) {
      console.log(`  ✅ 成功 | HTTP ${result.statusCode} | ${result.elapsed}ms | ${result.cipher}`);
    } else {
      console.log(`  ❌ 失败 | ${result.error}`);
    }
  }

  printSeparator('带自定义 Agent 测试');
  const customAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 3,
  });
  const result = await testHttps('https://marketplace.visualstudio.com/', { agent: customAgent });
  if (result.success) {
    console.log(`✅ 成功 | HTTP ${result.statusCode} | ${result.elapsed}ms | ${result.cipher}`);
  } else {
    console.log(`❌ 失败 | ${result.error}`);
  }
  customAgent.destroy();

  printSeparator('建议');
  console.log('如果出现 TLS 连接问题，按顺序尝试以下方案：');
  console.log('');
  console.log('方案1: 设置环境变量禁用 AES-NI');
  console.log('  $env:OPENSSL_ia32cap="~0x200000200000000"');
  console.log('  code .');
  console.log('');
  console.log('方案2: 通过 NODE_OPTIONS 设置 TLS 版本和密码');
  console.log('  $env:NODE_OPTIONS="--tls-min-v1.0 --tls-cipher-list=ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384"');
  console.log('  code .');
  console.log('');
  console.log('方案3: 两种组合');
  console.log('  $env:OPENSSL_ia32cap="~0x200000200000000";');
  console.log('  $env:NODE_OPTIONS="--tls-min-v1.0 --tls-cipher-list=ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384";');
  console.log('  code .');
}

runDiagnostics().catch(console.error);
