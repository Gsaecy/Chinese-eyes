# 🇨🇳 CHINESE EYES — 看透外文，一目了然

> **把英文 VS Code 扩展翻译成中文，让不擅长英语的用户也能轻松看懂扩展的功能和收费信息。**

![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/chinese-eyes.chinese-eyes)
![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/chinese-eyes.chinese-eyes)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## 📺 演示

| 粘贴文本 | 自动翻译 | AI 总结 |
|---------|---------|---------|
| 粘贴英文扩展描述/README | 自动翻译为中文 | 总结：有什么用 · 收不收费 · 怎么用 |

---

## ✨ 主要功能

### 1. 粘贴 → 翻译
在侧边栏粘贴任意英文文本（扩展描述、README、说明文档等），一键翻译为中文。

### 2. AI 总结（一键看懂）
翻译完成后，点击「AI 总结」按钮，自动分析原文生成三段式中文总结：

| 段落 | 说明 |
|------|------|
| 🔧 **有什么用** | 大白话说清楚这个扩展/工具的主要功能 |
| 💰 **收不收费** | 明确是否收费，多少钱，有什么限制 |
| 📖 **怎么用** | 安装后如何使用，简单几步 |

> 示例输出：
> ```
> **有什么用**
> 这是一个代码格式化工具，能自动帮你把代码排整齐，支持 JavaScript、TypeScript、CSS 等多种语言。
>
> **收不收费**
> 免费开源，无任何付费限制。
>
> **怎么用**
> 安装后在 VS Code 中按 `Ctrl+Shift+P` → 输入 "Format" 即可使用。
> ```

### 3. 多翻译源支持

| 翻译源 | 是否需要 API Key | 说明 |
|--------|-----------------|------|
| **本地词典** | ❌ 不需要 | 内置英→中词表，离线可用，适合短文本 |
| **DeepSeek** | ✅ 需要 | AI 翻译 + 智能总结（推荐） |
| **DeepL** | ✅ 需要 | 专业翻译引擎 |
| **Google** | ✅ 需要 | Google 翻译 |
| **LibreTranslate** | ✅ 可选 | 自托管翻译服务 |

### 4. 收费标识
翻译过程中自动检测原文中的付费关键词（paid、pricing、subscription、trial、premium 等），在译文末尾标注 ⚠️ 提醒。

### 5. API Key 管理
在扩展 UI 内直接输入 API Key，无需去 VS Code 设置页面翻找。

---

## 🚀 安装

### 从 VS Code 市场安装（推荐）
1. 打开 VS Code
2. 点击左侧活动栏的扩展图标（或按 `Ctrl+Shift+X`）
3. 搜索 **"CHINESE EYES"**
4. 点击「安装」

### 手动安装
1. 下载最新的 `.vsix` 文件从 [Releases](https://github.com/你的用户名/chinese-eyes/releases)
2. 在 VS Code 中执行 `Extensions: Install from VSIX...` 命令
3. 选择下载的文件

---

## 📖 快速上手

### 第一步：打开面板
- 点击左侧活动栏的 🇨🇳 **CHINESE EYES** 图标
- 或按 `Ctrl+Shift+P` → 输入「CHINESE EYES」

### 第二步：粘贴并翻译
1. 复制扩展市场的英文描述或 README
2. 粘贴到输入框
3. 点击「翻译」按钮

### 第三步：AI 总结（可选）
翻译完成后，点击「AI 总结」按钮获得三段式中文总结。

### 配置 DeepSeek API Key（推荐获取智能总结）
1. 在面板中点击「设置」按钮
2. 输入你的 DeepSeek API Key
3. 点击「保存」
4. 自动切换到 DeepSeek 翻译源

> 💡 **没有 API Key？** 没关系！本地词典模式可以直接翻译，AI 总结会用内置规则做基础总结，虽然不如 AI 精准，但也能用。

---

## ⚙️ 配置项

| 配置名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `chineseEyes.translationProvider` | string | `local` | 翻译源：`local` / `deepl` / `google` / `libretranslate` / `deepseek` |
| `chineseEyes.apiKey` | string | `""` | API 密钥（DeepSeek/DeepL/Google） |
| `chineseEyes.apiEndpoint` | string | `""` | 自定义 API 端点 |
| `chineseEyes.apiModel` | string | `""` | 自定义模型名称（如 `deepseek-chat`） |

---

## 🧩 技术架构

```
src/
├── extension.ts              # 扩展入口，注册侧边栏视图
├── extensionBrowserView.ts   # 翻译面板 UI + 消息处理 + AI 总结
├── translator.ts             # 翻译引擎（本地词典 / DeepL / Google / Libre / DeepSeek）
├── tlsCompat.ts              # TLS 兼容层（解决 Windows 证书问题）
├── marketplaceApi.ts         # (保留) VS Code 市场 API
└── types.ts                  # 类型定义
```

### 翻译流程
```
用户粘贴文本 → 选择翻译源 → Translator.translate()
  ├── 本地词典：词表替换 + 关键词检测 → 结果
  ├── DeepSeek：API 调用 + AI 翻译 → 结果
  ├── DeepL/Google/Libre：HTTP 请求 → 结果
  └── AI 总结（可选）→ 三段式中文总结
```

---

## 🛠 开发

```bash
# 克隆仓库
git clone https://github.com/你的用户名/chinese-eyes.git
cd chinese-eyes

# 安装依赖
npm install

# 编译
npm run compile

# 监视模式（开发时使用）
npm run watch

# 打包为 .vsix
npm run package
```

按 `F5` 在 VS Code 中启动扩展开发主机进行调试。

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

- 🐛 发现 Bug？[提交 Issue](https://github.com/你的用户名/chinese-eyes/issues)
- 💡 有想法？[发起讨论](https://github.com/你的用户名/chinese-eyes/discussions)

---

## 📄 许可证

[MIT License](LICENSE)

---

## 🙏 致谢

- 所有翻译源提供者（DeepSeek、DeepL、Google、LibreTranslate）
- VS Code 扩展生态
- 所有使用和贡献的用户

---

**CHINESE EYES** — 让语言不再成为探索扩展的障碍。