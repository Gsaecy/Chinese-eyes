# CHINESE EYES - TLS 问题启动修复脚本
# 用法: PowerShell 中以管理员身份运行此脚本
#
# 问题: VS Code (Electron/BoringSSL) 在某些 Windows CPU 上对 AES-GCM 解密失败
# 错误: BAD_DECRYPT (e_aes.cc.inc:839)
# 
# 此脚本会:
# 1. 检测当前环境
# 2. 设置 TLS 优化的环境变量
# 3. 启动 VS Code（以使环境变量生效）

Write-Host "=" * 60 -ForegroundColor Cyan
Write-Host "  CHINESE EYES - TLS 修复启动器" -ForegroundColor Cyan
Write-Host "=" * 60 -ForegroundColor Cyan
Write-Host ""

# ---- 检测 Node.js ----
try {
    $nodeVersion = node --version
    Write-Host "  ✅ Node.js 版本: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  ❌ 未找到 Node.js，请先安装 Node.js 18+" -ForegroundColor Red
    exit 1
}

# ---- 检测 VS Code ----
try {
    $codePath = Get-Command code.cmd -ErrorAction SilentlyContinue
    if (-not $codePath) {
        $codePath = Get-Command code -ErrorAction SilentlyContinue
    }
    if ($codePath) {
        Write-Host "  ✅ 已找到 VS Code: $($codePath.Source)" -ForegroundColor Green
    } else {
        Write-Host "  ⚠️ 未找到 VS Code 命令行工具" -ForegroundColor Yellow
        Write-Host "     请确保 VS Code 已添加到 PATH" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  ⚠️ 未找到 VS Code" -ForegroundColor Yellow
}

Write-Host ""

# ---- 环境变量设置 ----
Write-Host "  正在设置 TLS 兼容环境变量..." -ForegroundColor Yellow

# OPENSSL_ia32cap: 禁用 AES-NI (对 BoringSSL 可能无效，但对 Node.js OpenSSL 有用)
# ~0x200000200000000:
#   第57位 (~0x200000000000000): 禁用 AES-NI
#   第53位 (~0x002000000000000): 禁用 PCLMULQDQ
$env:OPENSSL_ia32cap = "~0x200000200000000"
Write-Host "    ✅ OPENSSL_ia32cap = ~0x200000200000000 (禁用 AES-NI)" -ForegroundColor Green

# NODE_OPTIONS: 设置 TLS 最低版本和首选密码套件
# 注意: 这只在 Node.js 进程中生效，Electron 可能忽略部分设置
$tlsCiphers = "ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:ECDHE-RSA-AES128-SHA256:AES128-SHA:AES256-SHA"
$env:NODE_OPTIONS = "--tls-min-v1.2 --tls-cipher-list=$tlsCiphers"
Write-Host "    ✅ NODE_OPTIONS = --tls-min-v1.2 --tls-cipher-list=..." -ForegroundColor Green
Write-Host "      (密码套件: AES-CBC 优先，避免 GCM BAD_DECRYPT)" -ForegroundColor Gray

# NODE_TLS_REJECT_UNAUTHORIZED: 允许自签名证书（开发环境）
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
Write-Host "    ✅ NODE_TLS_REJECT_UNAUTHORIZED = 0" -ForegroundColor Green

Write-Host ""

# ---- 启动 VS Code ----
Write-Host "  正在启动 VS Code (带 TLS 兼容配置)..." -ForegroundColor Yellow
Write-Host ""

try {
    if ($codePath) {
        $projectPath = "d:\AI projects\Chinese eyes"
        & code.cmd $projectPath
        Write-Host "  ✅ VS Code 已启动！" -ForegroundColor Green
        Write-Host ""
        Write-Host "  📝 如果仍然遇到 BAD_DECRYPT 错误，请尝试以下方案：" -ForegroundColor Cyan
        Write-Host "   方案 A: 使用本地代理" -ForegroundColor White
        Write-Host "      `$env:LOCAL_PROXY=""http://127.0.0.1:8080""; code ." -ForegroundColor Gray
        Write-Host "      (需要先启动 HTTP 代理，如 mitmproxy、Fiddler、Charles)" -ForegroundColor Gray
        Write-Host ""
        Write-Host "   方案 B: 使用 WSL 2 或 Docker 容器" -ForegroundColor White
        Write-Host "      docker run -it -v d:\AI projects\Chinese eyes:/app node:18-alpine sh" -ForegroundColor Gray
        Write-Host "      cd /app && npm install && node scripts/test_tls.js" -ForegroundColor Gray
        Write-Host ""
        Write-Host "   方案 C: 降级 VS Code 或 Node.js 版本" -ForegroundColor White
        Write-Host "      尝试使用 VS Code 1.85.x (含 Electron 25) 或 Node.js 16.x" -ForegroundColor Gray
    } else {
        Write-Host "  ⚠️ 请手动启动 VS Code 以应用环境变量" -ForegroundColor Yellow
        Write-Host "     先运行以下命令设置环境变量，再启动 VS Code:" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "     PowerShell:" -ForegroundColor White
        Write-Host "       `$env:OPENSSL_ia32cap=""~0x200000200000000""" -ForegroundColor Gray
        Write-Host "       `$env:NODE_OPTIONS=""--tls-min-v1.2 --tls-cipher-list=ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:ECDHE-RSA-AES128-SHA256:AES128-SHA:AES256-SHA""" -ForegroundColor Gray
        Write-Host "       `$env:NODE_TLS_REJECT_UNAUTHORIZED=""0""" -ForegroundColor Gray
        Write-Host "       code ." -ForegroundColor Gray
    }
} catch {
    Write-Host "  ❌ VS Code 启动失败: $_" -ForegroundColor Red
    Write-Host "  请手动设置环境变量后启动 VS Code" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=" * 60 -ForegroundColor Cyan
Write-Host "  如果问题仍然存在，请查看:" -ForegroundColor Cyan
Write-Host "  - CHINESE EYES 输出面板 (查看 TLS 诊断)" -ForegroundColor Cyan
Write-Host "  - 运行 node scripts/tls_diagnostics.js" -ForegroundColor Cyan
Write-Host "=" * 60 -ForegroundColor Cyan
