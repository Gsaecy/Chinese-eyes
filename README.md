# 🇨🇳 扩展选择助手 — 看透外文，一目了然

> **浏览 VS Code 扩展市场，自动翻译扩展详情为中文，AI 总结用途/收费/用法。**
> **让不擅长英语的用户也能轻松看懂扩展的功能和收费信息。**

![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/ext-trans-picker.ext-trans-picker)
![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/ext-trans-picker.ext-trans-picker)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## 📺 演示

| 浏览扩展市场 | 自动翻译 | AI 总结 |
|-------------|---------|---------|
| 在侧边栏直接搜索 VS Code 扩展市场 | 扩展描述自动翻译为中文 | 总结：有什么用 · 收不收费 · 怎么用 |
<img width="811" height="709" alt="01" src="https://github.com/user-attachments/assets/66a7ac8a-f685-4c6a-9535-ab52b35626fe" />
<img width="895" height="708" alt="02" src="https://github.com/user-attachments/assets/abd7fc61-8989-4b67-b872-4237c2b9182e" />
<img width="873" height="720" alt="03" src="https://github.com/user-attachments/assets/ba452e02-b3b5-44f8-9a5b-98b1c18c5cd0" />

---

## ✨ 主要功能

### 1. 🏪 浏览扩展市场
在侧边栏直接搜索和浏览 VS Code 扩展市场，无需离开编辑器：
- 搜索扩展名或关键词
- 按热门/评分/最新/相关排序
- 分页加载更多
- 查看扩展图标、描述、评分、下载量
- 一键安装或打开市场页面

### 2. 🌐 自动翻译
扩展描述自动翻译为中文，支持多种翻译源：
- **本地词典**：离线可用，无需 API Key
- **DeepSeek**：AI 翻译（推荐）
- **OpenAI 兼容**：支持任意 OpenAI 兼容 API
- **DeepL / Google / LibreTranslate**：专业翻译引擎

### 3. 🤖 AI 总结（一键看懂）
点击「AI 总结」按钮，自动分析扩展生成三段式中文总结：

| 段落 | 说明 |
|------|------|
| 🔧 **有什么用** | 大白话说清楚这个扩展的主要功能 |
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

### 4. 💰 收费标识
扩展卡片上自动标注收费状态：
- 🟢 **免费**：完全免费
- 🟡 **可能付费**：包含付费标签，需进一步确认
- 🔴 **付费**：明确需要付费使用

### 5. ⚙️ 内置设置面板
在扩展 UI 内直接配置，无需去 VS Code 设置页面翻找：
- 选择翻译提供商
- 输入 API Key
- 配置自定义 Endpoint 和模型

---

## 🚀 安装

### 从 VS Code 市场安装（推荐）
1. 打开 VS Code
2. 点击左侧活动栏的扩展图标（或按 `Ctrl+Shift+X`）
3. 搜索 **"扩展选择助手"**
4. 点击「安装」

### 手动安装
1. 下载最新的 `.vsix` 文件从 [Releases](https://github.com/Gsaecy/Chinese-eyes/releases)
2. 在 VS Code 中执行 `Extensions: Install from VSIX...` 命令
3. 选择下载的文件

---

## 📖 快速上手

### 第一步：打开面板
- 点击左侧活动栏的 🇨🇳 扩展选择助手图标
- 或按 `Ctrl+Shift+P` → 输入「扩展选择助手」

### 第二步：浏览扩展
1. 点击「📦 浏览扩展」按钮加载热门扩展
2. 或在搜索框输入关键词搜索
3. 点击扩展卡片上的「详情」查看完整介绍

### 第三步：AI 总结（可选）
点击扩展卡片上的「AI 总结」按钮获得三段式中文总结。

### 配置 API Key（推荐获取智能总结）
1. 在面板中点击右上角 ⚙ 设置按钮
2. 选择 DeepSeek 或 OpenAI 兼容
3. 输入你的 API Key
4. 点击「保存」

> 💡 **没有 API Key？** 没关系！本地词典模式可以直接翻译，AI 总结会用内置规则做基础总结，虽然不如 AI 精准，但也能用。

---

## ⚙️ 配置项

| 配置名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `chineseEyes.translationProvider` | string | `local` | 翻译源：`local` / `deepl` / `google` / `libretranslate` / `deepseek` / `openai-compatible` |
| `chineseEyes.apiKey` | string | `""` | API 密钥（DeepSeek/DeepL/Google/OpenAI 兼容） |
| `chineseEyes.apiEndpoint` | string | `""` | 自定义 API 端点 |
| `chineseEyes.apiModel` | string | `""` | 自定义模型名称（如 `deepseek-chat`、`gpt-4o-mini`） |
| `chineseEyes.autoTranslateReadme` | boolean | `true` | 打开扩展详情时自动翻译 README 内容 |
| `chineseEyes.pageSize` | number | `20` | 扩展列表每页显示数量 |

---

## 🧩 技术架构

```
src/
├── extension.ts              # 扩展入口，注册侧边栏视图
├── extensionBrowserView.ts   # 扩展市场浏览面板 UI + 消息处理
├── extensionDetailPanel.ts   # 扩展详情面板（翻译 + AI 总结）
├── translator.ts             # 翻译引擎（本地词典 / DeepL / Google / Libre / DeepSeek / OpenAI 兼容）
├── marketplaceApi.ts         # VS Code 市场 API 封装
├── tlsCompat.ts              # TLS 兼容层（解决 Windows 证书问题）
└── types.ts                  # 类型定义
```

### 翻译流程
```
用户浏览扩展 → 获取扩展列表 → 自动翻译描述
  ├── 本地词典：词表替换 + 关键词检测 → 结果
  ├── DeepSeek：API 调用 + AI 翻译 → 结果
  ├── DeepL/Google/Libre：HTTP 请求 → 结果
  └── AI 总结（可选）→ 三段式中文总结
```

---

## 🛠 开发

```bash
# 克隆仓库
git clone https://github.com/Gsaecy/Chinese-eyes.git
cd Chinese-eyes

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

- 🐛 发现 Bug？[提交 Issue](https://github.com/Gsaecy/Chinese-eyes/issues)
- 💡 有想法？[发起讨论](https://github.com/Gsaecy/Chinese-eyes/discussions)

---

## 📄 许可证

[MIT License](LICENSE)

---

## 🙏 致谢

- 所有翻译源提供者（DeepSeek、DeepL、Google、LibreTranslate）
- VS Code 扩展生态
- 所有使用和贡献的用户

---

**扩展选择助手** — 让语言不再成为探索扩展的障碍。
