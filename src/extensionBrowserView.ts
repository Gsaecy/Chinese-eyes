import * as vscode from 'vscode';
import { Translator, TranslationConfig } from './translator';
import { queryExtensions } from './marketplaceApi';
import { ExtensionItem } from './types';
import { ExtensionDetailPanel } from './extensionDetailPanel';

/**
 * 侧边栏：扩展列表浏览（搜索 + 卡片）
 * - 列表项提供「详情」「AI 总结」两个按钮
 * - 「详情」打开主编辑区的 ExtensionDetailPanel，自动翻译 README
 * - 「AI 总结」也走 ExtensionDetailPanel，但默认展开总结区域
 */
export class ExtensionBrowserViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'chineseEyes.marketplace';

  private _view?: vscode.WebviewView;
  private _translator: Translator;
  private _context: vscode.ExtensionContext;

  private _query = '';
  private _sortBy: 'relevance' | 'installCount' | 'rating' | 'publishedDate' = 'installCount';
  private _page = 1;
  private _hasMore = true;
  private _loading = false;
  private _items: ExtensionItem[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    translator: Translator,
    context: vscode.ExtensionContext
  ) {
    this._translator = translator;
    this._context = context;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    console.log('[chineseEyes] resolveWebviewView 开始');
    try {
      this._view = webviewView;
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [this._extensionUri],
      };
      console.log('[chineseEyes] resolveWebviewView 设置 HTML');
      webviewView.webview.html = this.buildHtml(webviewView.webview);
      console.log('[chineseEyes] resolveWebviewView 设置消息监听');
      webviewView.webview.onDidReceiveMessage((m) => this.handleMessage(m));
      console.log('[chineseEyes] resolveWebviewView 完成');
    } catch (err) {
      console.error('[chineseEyes] resolveWebviewView 异常:', err);
    }
  }

  private syncConfig(): TranslationConfig {
    const config = vscode.workspace.getConfiguration('chineseEyes');
    const cfg: TranslationConfig = {
      provider: config.get('translationProvider', 'local'),
      apiKey: config.get('apiKey', ''),
      targetLanguage: 'zh-CN',
      customEndpoint: config.get('apiEndpoint', ''),
      customModel: config.get('apiModel', ''),
    };
    this._translator.updateConfig(cfg);
    return cfg;
  }

  private async handleMessage(msg: any): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': {
          const cfg = this.syncConfig();
          this.postMessage({
            type: 'init',
            provider: cfg.provider,
            hasApiKey: !!cfg.apiKey,
            canSummarize: this._translator.canSummarize(),
            pageSize: vscode.workspace.getConfiguration('chineseEyes').get('pageSize', 20),
          });
          // 不再自动加载扩展，显示欢迎页让用户点击按钮再加载
          if (this._items.length === 0) {
            this.postMessage({ type: 'welcome' });
          } else {
            this.postMessage({
              type: 'searchResults',
              items: this._items,
              hasMore: this._hasMore,
              query: this._query,
              page: this._page,
            });
          }
          break;
        }

        case 'getSettings': {
          const config = vscode.workspace.getConfiguration('chineseEyes');
          this.postMessage({
            type: 'settingsData',
            provider: config.get('translationProvider', 'local'),
            apiKey: config.get('apiKey', ''),
            endpoint: config.get('apiEndpoint', ''),
            model: config.get('apiModel', ''),
          });
          break;
        }


        case 'search':
          this._query = (msg.query || '').trim();
          await this.doSearch(this._query, true);
          break;

        case 'loadMore':
          if (!this._loading && this._hasMore) {
            await this.doSearch(this._query, false);
          }
          break;

        case 'setSort':
          this._sortBy = msg.sortBy || 'installCount';
          await this.doSearch(this._query, true);
          break;

        case 'openDetail':
        case 'openSummary': {
          this.syncConfig();
          const item = this._items.find((i) => i.id === msg.extensionId);
          if (!item) {
            vscode.window.showWarningMessage('未找到扩展信息，请重新搜索');
            return;
          }
          ExtensionDetailPanel.show(
            this._context.extensionUri,
            this._translator,
            item,
            { openSummary: msg.type === 'openSummary' }
          );
          break;
        }

        case 'openMarketplace': {
          const item = this._items.find((i) => i.id === msg.extensionId);
          if (item) {
            const url = `https://marketplace.visualstudio.com/items?itemName=${item.id}`;
            vscode.env.openExternal(vscode.Uri.parse(url));
          }
          break;
        }

        case 'install': {
          const item = this._items.find((i) => i.id === msg.extensionId);
          if (item) {
            vscode.commands.executeCommand('workbench.extensions.installExtension', item.id);
          }
          break;
        }

        case 'saveSettings': {
          try {
            const chConfig = vscode.workspace.getConfiguration('chineseEyes');
            const provider = msg.provider || 'deepseek';
            await chConfig.update('translationProvider', provider, vscode.ConfigurationTarget.Global);
            await chConfig.update('apiKey', msg.apiKey || '', vscode.ConfigurationTarget.Global);
            await chConfig.update('apiEndpoint', msg.endpoint || '', vscode.ConfigurationTarget.Global);
            await chConfig.update('apiModel', msg.model || '', vscode.ConfigurationTarget.Global);
            const cfg = this.syncConfig();
            this.postMessage({
              type: 'settingsSaved',
              provider: cfg.provider,
              hasApiKey: !!cfg.apiKey,
              canSummarize: this._translator.canSummarize(),
            });
          } catch (err: any) {
            this.postMessage({ type: 'error', message: '保存设置失败: ' + err.message });
          }
          break;
        }

        case 'openSettingsUI':
          vscode.commands.executeCommand('workbench.action.openSettings', '@ext:honor-world.ext-trans-picker');
          break;

        case 'openUrl':
          if (msg.url) vscode.env.openExternal(vscode.Uri.parse(msg.url));
          break;
      }
    } catch (err: any) {
      console.error('[chineseEyes] handleMessage 异常:', err);
      this.postMessage({ type: 'error', message: err.message || String(err) });
    }
  }

  private async doSearch(query: string, reset: boolean): Promise<void> {
    if (this._loading) return;

    // Guard: LLM 翻译需要 API Key，用户没配置就不应该发请求
    if (this._translator.isLLMProvider()) {
      const config = vscode.workspace.getConfiguration('chineseEyes');
      if (!config.get('apiKey', '').trim()) {
        this.postMessage({
          type: 'error',
          message: '请先在「⚙ 设置」中配置 API Key，再进行搜索。',
        });
        this._loading = false;
        return;
      }
    }

    this._loading = true;
    if (reset) {
      this._items = [];
      this._page = 1;
      this._hasMore = true;
    }
    this.postMessage({ type: 'loading', append: !reset });

    const pageSize = vscode.workspace.getConfiguration('chineseEyes').get('pageSize', 20);

    try {
      const { extensions, total } = await queryExtensions({
        text: query,
        pageNumber: this._page,
        pageSize,
        sortBy: this._sortBy,
      });

      // 异步翻译每个扩展的简介（不阻塞列表展示）
      const newItems = extensions;
      this._items = reset ? newItems : this._items.concat(newItems);
      this._hasMore = this._items.length < total && extensions.length > 0;

      this.postMessage({
        type: 'searchResults',
        items: this._items,
        hasMore: this._hasMore,
        query,
        page: this._page,
        total,
      });

      this._page += 1;
    } catch (err: any) {
      console.error('[chineseEyes] 搜索失败:', err);
      this.postMessage({ type: 'error', message: '搜索失败: ' + (err.message || String(err)) });
    } finally {
      this._loading = false;
    }
  }

  public postMessage(msg: any): void {
    this._view?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const N = getNonce();
    const W = webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `img-src ${W} https: data:`,
      `style-src 'unsafe-inline' ${W}`,
      `script-src 'nonce-${N}'`,
      `connect-src https:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${N}">
:root{
  --fg:var(--vscode-editor-foreground);
  --bg:var(--vscode-editor-background);
  --card:var(--vscode-sideBar-background);
  --border:var(--vscode-widget-border, rgba(128,128,128,.3));
  --btn:var(--vscode-button-background);
  --btn-fg:var(--vscode-button-foreground);
  --btn-hover:var(--vscode-button-hoverBackground);
  --sub:var(--vscode-descriptionForeground);
  --link:var(--vscode-textLink-foreground);
  --input-bg:var(--vscode-input-background);
  --input-fg:var(--vscode-input-foreground);
  --input-border:var(--vscode-input-border);
  --success:#1ea55b;--warning:#c9a93c;--error:#c95c3c;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--fg);background:var(--bg);padding:8px}
.header{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
.search-row{display:flex;gap:4px}
.search-row input{flex:1;padding:6px 8px;border:1px solid var(--input-border);border-radius:4px;background:var(--input-bg);color:var(--input-fg);font-size:12px;outline:none}
.search-row input:focus{border-color:var(--btn)}
.search-row button{padding:6px 10px;border:none;border-radius:4px;background:var(--btn);color:var(--btn-fg);cursor:pointer;font-size:12px}
.search-row button:hover{background:var(--btn-hover)}
.search-row .btn-settings{background:transparent;color:var(--sub);border:1px solid var(--border)}
.search-row .btn-settings:hover{background:var(--btn);color:var(--btn-fg)}
.sort-row{display:flex;gap:4px;flex-wrap:wrap;font-size:11px}
.sort-chip{padding:2px 8px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--sub);cursor:pointer;user-select:none}
.sort-chip:hover{border-color:var(--btn);color:var(--btn)}
.sort-chip.active{background:var(--btn);color:var(--btn-fg);border-color:var(--btn)}
.capability-bar{font-size:10px;color:var(--sub);display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:4px;background:rgba(128,128,128,.08)}
.capability-bar .dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.capability-bar .dot.g{background:var(--success)}
.capability-bar .dot.y{background:var(--warning)}
.capability-bar .dot.r{background:var(--error)}
.list{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.card{display:flex;gap:8px;padding:8px;background:var(--card);border:1px solid var(--border);border-radius:6px}
.card .icon{width:42px;height:42px;border-radius:6px;flex-shrink:0;background:rgba(128,128,128,.15);object-fit:contain}
.card .icon-fallback{width:42px;height:42px;border-radius:6px;flex-shrink:0;background:rgba(128,128,128,.15);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--sub)}
.card .body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.card .title{font-weight:600;font-size:13px;line-height:1.3;word-break:break-word}
.card .publisher{font-size:10px;color:var(--sub)}
.card .desc{font-size:11px;color:var(--fg);line-height:1.5;word-break:break-word;opacity:.92}
.card .desc-zh{font-size:11px;color:var(--fg);line-height:1.5;word-break:break-word;border-left:2px solid var(--success);padding-left:6px;margin-top:2px}
.card .desc-zh.loading{opacity:.5;font-style:italic}
.card .meta{display:flex;gap:6px;align-items:center;font-size:10px;color:var(--sub);flex-wrap:wrap;margin-top:2px}
.card .badge{padding:1px 6px;border-radius:8px;font-size:10px;line-height:1.4}
.card .badge.free{background:rgba(30,165,91,.15);color:var(--success)}
.card .badge.paid{background:rgba(201,92,60,.15);color:var(--error)}
.card .badge.maybe{background:rgba(201,169,60,.15);color:var(--warning)}
.card .actions{display:flex;gap:4px;margin-top:4px;flex-wrap:wrap}
.card .actions button{flex:1;min-width:60px;padding:4px 6px;font-size:11px;border:1px solid var(--border);background:transparent;color:var(--fg);border-radius:4px;cursor:pointer}
.card .actions button:hover{background:var(--btn);color:var(--btn-fg);border-color:var(--btn)}
.card .actions .primary{background:var(--btn);color:var(--btn-fg);border-color:var(--btn)}
.card .actions .primary:hover{background:var(--btn-hover)}
.card .actions .summary{color:var(--link);border-color:var(--link)}
.card .actions .summary:hover{background:var(--link);color:var(--btn-fg)}
.empty{padding:20px;text-align:center;color:var(--sub);font-size:12px}
.loading-bar{display:flex;align-items:center;justify-content:center;gap:6px;padding:10px;color:var(--sub);font-size:11px}
.spinner{width:12px;height:12px;border:2px solid var(--sub);border-top-color:var(--btn);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.load-more{padding:6px;text-align:center;background:transparent;color:var(--link);border:1px dashed var(--border);border-radius:6px;cursor:pointer;font-size:11px;margin:4px 0}
.load-more:hover{border-color:var(--link);background:rgba(0,122,204,.08)}
.settings-area{margin-top:12px;padding:10px;background:var(--card);border:1px solid var(--border);border-radius:6px;display:none;position:sticky;top:0;z-index:10;box-shadow:0 4px 12px rgba(0,0,0,.25)}
.settings-area.show{display:block}
.settings-area h3{font-size:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;color:var(--sub)}
.settings-area h3 .close{cursor:pointer;color:var(--link);font-weight:400;font-size:11px}
.field{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}
.field label{font-size:11px;color:var(--sub)}
.field select,.field input{padding:5px 7px;border:1px solid var(--input-border);background:var(--input-bg);color:var(--input-fg);border-radius:4px;font-size:11px;outline:none}
.field select:focus,.field input:focus{border-color:var(--btn)}
.field .hint{font-size:10px;color:var(--sub);opacity:.8}
.settings-actions{display:flex;gap:6px;margin-top:6px}
.settings-actions button{padding:5px 10px;border:none;border-radius:4px;cursor:pointer;font-size:11px}
.settings-actions .save{background:var(--btn);color:var(--btn-fg)}
.settings-actions .save:hover{background:var(--btn-hover)}
.settings-actions .open-ui{background:transparent;color:var(--sub);border:1px solid var(--border)}
.settings-actions .open-ui:hover{background:var(--btn);color:var(--btn-fg)}
.help-box{margin-top:8px;padding:8px;background:rgba(30,165,91,.08);border:1px solid var(--success);border-radius:4px;font-size:10px;line-height:1.7;color:var(--fg)}
.help-box strong{color:var(--success)}
.help-box a{color:var(--link);cursor:pointer;text-decoration:underline}
.toast{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);padding:5px 14px;border-radius:14px;font-size:11px;z-index:99;display:none}
.toast.success{background:var(--success);color:#fff}
.toast.error{background:var(--error);color:#fff}
.toast.info{background:var(--btn);color:var(--btn-fg)}
.welcome-area{display:flex;align-items:center;justify-content:center;height:300px;text-align:center}
.welcome-content h2{font-size:18px;margin-bottom:10px;color:var(--fg)}
.welcome-content p{font-size:13px;color:var(--sub);margin-bottom:20px}
.primary-btn{padding:10px 24px;background:var(--btn);color:var(--btn-fg);border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600}
.primary-btn:hover{background:var(--btn-hover)}
</style>
</head>
<body>
<div class="header">
  <div class="search-row">
    <input id="searchInput" type="text" placeholder="搜索扩展名 / 关键词...">
    <button id="searchBtn">搜索</button>
    <button id="settingsBtn" class="btn-settings" title="设置">⚙</button>
  </div>
  <div class="sort-row">
    <span class="sort-chip" data-sort="installCount">热门</span>
    <span class="sort-chip" data-sort="rating">评分</span>
    <span class="sort-chip" data-sort="publishedDate">最新</span>
    <span class="sort-chip" data-sort="relevance">相关</span>
  </div>
  <div class="capability-bar" id="capabilityBar">
    <span><span class="dot g" id="dotTrans"></span> 翻译：<span id="transStat">本地</span></span>
    <span><span class="dot r" id="dotSum"></span> AI 总结：<span id="sumStat">需配置</span></span>
  </div>
</div>

<div class="settings-area" id="settingsArea">
  <h3>设置 <span class="close" id="closeSettings">收起</span></h3>
  <div class="field">
    <label>翻译 / 总结 提供商</label>
    <select id="providerSelect">
      <option value="local">本地词典（离线，无 AI 总结）</option>
      <option value="deepseek">DeepSeek（推荐，翻译 + AI 总结）</option>
      <option value="openai-compatible">OpenAI 兼容（翻译 + AI 总结）</option>
      <option value="deepl">DeepL（仅翻译）</option>
      <option value="google">Google（仅翻译）</option>
      <option value="libretranslate">LibreTranslate（仅翻译）</option>
    </select>
  </div>
  <div class="field">
    <label>API Key</label>
    <input type="password" id="apiKeyInput" placeholder="输入你的 API Key...">
    <div class="hint">本地词典不需要 Key；其余 provider 必须填写</div>
  </div>
  <div class="field">
    <label>自定义 Endpoint（可选）</label>
    <input type="text" id="endpointInput" placeholder="如 https://api.deepseek.com 或 https://api.openai.com">
  </div>
  <div class="field">
    <label>自定义模型（可选）</label>
    <input type="text" id="modelInput" placeholder="如 deepseek-chat、gpt-4o-mini、qwen-plus">
  </div>
  <div class="settings-actions">
    <button class="save" id="saveSettingsBtn">保存</button>
    <button class="open-ui" id="openSettingsBtn">在 VS Code 设置中打开</button>
  </div>
  <div class="help-box">
    <strong>🔑 推荐配置</strong><br>
    1. DeepSeek：注册 <a data-url="https://platform.deepseek.com/">platform.deepseek.com</a> → 创建 API Key<br>
    2. OpenAI 兼容：填入 endpoint（如阿里云 DashScope、Moonshot、Together 等）+ 对应模型名<br>
    3. 仅翻译：DeepL/Google/LibreTranslate 也可使用，但不能 AI 总结
  </div>
</div>

<div id="listArea">
  <div class="welcome-area" id="welcomeArea">
    <div class="welcome-content">
      <h2>👋 欢迎使用扩展选择助手</h2>
      <p>AI 智能总结 + 翻译，帮助你快速了解 VS Code 扩展</p>
      <button id="loadExtensionsBtn" class="primary-btn">📦 浏览扩展</button>
      <div style="margin-top:16px;font-size:12px;color:var(--sub)">
        <strong style="color:var(--warning)">⚠️ 首次使用请先配置 API Key</strong><br>
        点击右上角 ⚙ 设置 → 选择 DeepSeek/OpenAI 兼容 → 填入 Key
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script nonce="${N}">
const vscode = acquireVsCodeApi();
const el = (id) => document.getElementById(id);
const listArea = el('listArea');
const searchInput = el('searchInput');
const searchBtn = el('searchBtn');
const settingsBtn = el('settingsBtn');
const settingsArea = el('settingsArea');
const closeSettings = el('closeSettings');
const providerSelect = el('providerSelect');
const apiKeyInput = el('apiKeyInput');
const endpointInput = el('endpointInput');
const modelInput = el('modelInput');
const saveSettingsBtn = el('saveSettingsBtn');
const openSettingsBtn = el('openSettingsBtn');
const toast = el('toast');
const dotTrans = el('dotTrans');
const dotSum = el('dotSum');
const transStat = el('transStat');
const sumStat = el('sumStat');
const sortChips = document.querySelectorAll('.sort-chip');

let state = {
  provider: 'local',
  hasApiKey: false,
  canSummarize: false,
  items: [],
  hasMore: false,
  loading: false,
  query: '',
  sortBy: 'installCount',
  descMap: {},
};

function fmtCount(n){
  if (!n) return '0';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return String(n);
}
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCapability(){
  if (state.provider === 'local'){
    transStat.textContent = '本地词典';
    dotTrans.className = 'dot g';
  } else if (state.hasApiKey){
    transStat.textContent = state.provider;
    dotTrans.className = 'dot g';
  } else {
    transStat.textContent = state.provider + '（缺 Key）';
    dotTrans.className = 'dot r';
  }
  if (state.canSummarize){
    sumStat.textContent = '可用（' + state.provider + '）';
    dotSum.className = 'dot g';
  } else {
    sumStat.textContent = '需配置 DeepSeek/OpenAI 兼容';
    dotSum.className = 'dot r';
  }
}

function renderList(){
  if (state.items.length === 0 && !state.loading){
    listArea.innerHTML = '<div class="empty">没有找到匹配的扩展，换个关键词试试</div>';
    return;
  }
  const parts = [];
  for (const item of state.items){
    const badge = item.pricingStatus === 'paid'
      ? '<span class="badge paid">付费</span>'
      : item.pricingStatus === 'maybePaid'
        ? '<span class="badge maybe">可能付费</span>'
        : '<span class="badge free">免费</span>';
    const iconHtml = item.iconUrl
      ? '<img class="icon" src="' + esc(item.iconUrl) + '" alt="' + esc((item.displayName || '?').slice(0,1)) + '">'
      : '<div class="icon-fallback">' + esc((item.displayName || '?').slice(0,1).toUpperCase()) + '</div>';
    parts.push(
      '<div class="card" data-id="' + esc(item.id) + '">'
      + iconHtml
      + '<div class="body">'
        + '<div class="title">' + esc(item.displayName) + '</div>'
        + '<div class="publisher">' + esc(item.publisherDisplayName || item.publisher) + ' · v' + esc(item.version) + '</div>'
        + (item.description ? '<div class="desc">' + esc(item.description) + '</div>' : '')
        + '<div class="meta">'
          + badge
          + '<span>⬇ ' + fmtCount(item.installCount) + '</span>'
          + (item.ratingScore ? '<span>★ ' + item.ratingScore.toFixed(1) + '（' + fmtCount(item.ratingCount) + '）</span>' : '')
        + '</div>'
        + '<div class="actions">'
          + '<button class="primary" data-act="detail">详情</button>'
          + '<button class="summary" data-act="summary">AI 总结</button>'
          + '<button data-act="install" title="在 VS Code 中安装">安装</button>'
          + '<button data-act="open" title="在浏览器打开市场页">↗</button>'
        + '</div>'
      + '</div>'
      + '</div>'
    );
  }
  if (state.hasMore){
    parts.push('<button class="load-more" id="loadMoreBtn">加载更多…</button>');
  }
  listArea.innerHTML = parts.join('');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  if (loadMoreBtn){
    loadMoreBtn.addEventListener('click', () => {
      loadMoreBtn.textContent = '加载中…';
      loadMoreBtn.disabled = true;
      vscode.postMessage({type:'loadMore'});
    });
  }
  listArea.querySelectorAll('.card').forEach((card) => {
    const id = card.getAttribute('data-id');
    card.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.getAttribute('data-act');
        if (act === 'detail') vscode.postMessage({type:'openDetail', extensionId: id});
        else if (act === 'summary') vscode.postMessage({type:'openSummary', extensionId: id});
        else if (act === 'install') vscode.postMessage({type:'install', extensionId: id});
        else if (act === 'open') vscode.postMessage({type:'openMarketplace', extensionId: id});
      });
    });
  });
}

function showLoading(append){
  if (!append){
    listArea.innerHTML = '<div class="loading-bar"><span class="spinner"></span>加载中…</div>';
  }
}

function showToast(msg, type){
  toast.textContent = msg;
  toast.className = 'toast ' + (type || 'info');
  toast.style.display = 'block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

function doSearch(){
  state.query = searchInput.value.trim();
  vscode.postMessage({type:'search', query: state.query});
}
searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

sortChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    sortChips.forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.sortBy = chip.getAttribute('data-sort');
    vscode.postMessage({type:'setSort', sortBy: state.sortBy});
  });
});

settingsBtn.addEventListener('click', () => {
  settingsArea.classList.toggle('show');
  if (settingsArea.classList.contains('show')){
    // 从后端获取真实配置值
    vscode.postMessage({type:'getSettings'});
  }
});

const loadExtensionsBtn = el('loadExtensionsBtn');
if (loadExtensionsBtn) {
  loadExtensionsBtn.addEventListener('click', () => {
    loadExtensionsBtn.disabled = true;
    loadExtensionsBtn.textContent = '加载中…';
    vscode.postMessage({type:'search', query: ''});
  });
}
closeSettings.addEventListener('click', () => settingsArea.classList.remove('show'));
saveSettingsBtn.addEventListener('click', () => {
  saveSettingsBtn.disabled = true;
  saveSettingsBtn.textContent = '保存中…';
  vscode.postMessage({
    type: 'saveSettings',
    provider: providerSelect.value,
    apiKey: apiKeyInput.value.trim(),
    endpoint: endpointInput.value.trim(),
    model: modelInput.value.trim(),
  });
});
openSettingsBtn.addEventListener('click', () => vscode.postMessage({type:'openSettingsUI'}));

document.querySelectorAll('.help-box a').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    vscode.postMessage({type:'openUrl', url: a.getAttribute('data-url')});
  });
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type){
    case 'init':
      state.provider = msg.provider || 'local';
      state.hasApiKey = !!msg.hasApiKey;
      state.canSummarize = !!msg.canSummarize;
      renderCapability();
      sortChips.forEach((c) => c.classList.toggle('active', c.getAttribute('data-sort') === state.sortBy));
      break;
    case 'welcome':
      // 显示欢迎页，搜索按钮被禁用状态
      if (loadExtensionsBtn) {
        loadExtensionsBtn.disabled = false;
        loadExtensionsBtn.textContent = '📦 浏览扩展';
      }
      break;
    case 'loading':
      state.loading = true;
      showLoading(msg.append);
      break;
    case 'searchResults':
      state.loading = false;
      state.items = msg.items || [];
      state.hasMore = !!msg.hasMore;
      state.descMap = {};
      renderList();
      break;
    case 'descriptionsTranslated':
      Object.assign(state.descMap, msg.map || {});
      renderList();
      break;
    case 'settingsData':
      // 从后端获取到真实配置值，填充设置面板
      providerSelect.value = msg.provider || 'local';
      apiKeyInput.value = msg.apiKey || '';
      endpointInput.value = msg.endpoint || '';
      modelInput.value = msg.model || '';
      break;
    case 'settingsSaved':
      saveSettingsBtn.disabled = false;
      saveSettingsBtn.textContent = '保存';
      state.provider = msg.provider;
      state.hasApiKey = !!msg.hasApiKey;
      state.canSummarize = !!msg.canSummarize;
      renderCapability();
      settingsArea.classList.remove('show');
      showToast('设置已保存', 'success');
      // 重新搜索以应用新的翻译能力
      vscode.postMessage({type:'search', query: state.query});
      break;
    case 'error':
      state.loading = false;
      saveSettingsBtn.disabled = false;
      saveSettingsBtn.textContent = '保存';
      showToast(msg.message, 'error');
      // 搜索失败后恢复欢迎页，让用户可以重试
      if (state.items.length === 0) {
        listArea.innerHTML = '<div class="welcome-area"><div class="welcome-content"><h2>👋 欢迎使用扩展选择助手</h2><p>AI 智能总结 + 翻译，帮助你快速了解 VS Code 扩展</p><button id="loadExtensionsBtn" class="primary-btn">📦 浏览扩展</button><div style="margin-top:16px;font-size:12px;color:var(--sub)"><strong style="color:var(--warning)">⚠️ 首次使用请先配置 API Key</strong><br>点击右上角 ⚙ 设置 → 选择 DeepSeek/OpenAI 兼容 → 填入 Key</div></div></div>';
        const newLoadBtn = document.getElementById('loadExtensionsBtn');
        if (newLoadBtn) {
          newLoadBtn.addEventListener('click', () => {
            newLoadBtn.disabled = true;
            newLoadBtn.textContent = '加载中…';
            vscode.postMessage({type:'search', query: ''});
          });
        }
      }
      break;

  }
});

vscode.postMessage({type:'ready'});
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 64; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
