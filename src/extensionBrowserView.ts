import * as vscode from 'vscode';
import { Translator, TranslationConfig } from './translator';
import { queryExtensions, reorderByRelevance, sortItemsBy } from './marketplaceApi';
import { ExtensionItem } from './types';
import { ExtensionDetailPanel } from './extensionDetailPanel';
import { icon } from './icons';
import { APPLE_CSS } from './theme';

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
  private _sortBy: 'relevance' | 'popular' | 'downloads' | 'rating' | 'publishedDate' = 'popular';
  private _sortExplicit = false;
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
          // 有关键词且用户未手动选排序时，默认按相关性搜索（避免热门排序把无关大牌排前面）
          if (this._query && !this._sortExplicit && this._sortBy !== 'relevance') {
            this._sortBy = 'relevance';
          }
          await this.doSearch(this._query, true);
          break;

        case 'loadMore':
          if (!this._loading && this._hasMore) {
            await this.doSearch(this._query, false);
          }
          break;

        case 'setSort':
          this._sortBy = msg.sortBy || 'installCount';
          this._sortExplicit = true;
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
            vscode.commands.executeCommand('extension.open', item.id);
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

        case 'clearSearch':
          this._query = '';
          this._items = [];
          this._page = 1;
          this._hasMore = true;
          this._sortBy = 'popular';
          this._sortExplicit = false;
          this.postMessage({ type: 'welcome', sortBy: 'popular' });
          break;

        case 'openTranslator':
          vscode.commands.executeCommand('chineseEyes.openTranslator');
          break;

        case 'closePanel':
          vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
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
          message: '请先在「设置」中配置 API Key，再进行搜索。',
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
      // 先按本地真实数值排序（下载量/评分/最新），再做相关性分层：
      // 「相关」模式按匹配度精细排序；其他模式保持真实排名、只把无关项移到底部
      const sorted = reset ? sortItemsBy(extensions, this._sortBy) : extensions;
      const newItems = reset
        ? reorderByRelevance(sorted, query, this._sortBy !== 'relevance')
        : sorted;
      this._items = reset ? newItems : this._items.concat(newItems);
      this._hasMore = this._items.length < total && extensions.length > 0;

      this.postMessage({
        type: 'searchResults',
        items: this._items,
        hasMore: this._hasMore,
        query,
        page: this._page,
        total,
        sortBy: this._sortBy,
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
${APPLE_CSS}
/* ===== 侧边栏布局 ===== */
body{padding:12px;font-size:13px}
.header{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.search-row{display:flex;gap:6px;align-items:center}
.search-row .ap-input{flex:1;min-width:0}
.toolbar{display:flex;gap:6px;align-items:center}
.toolbar .spacer{flex:1}
.capability-bar{display:flex;gap:14px;align-items:center;padding:2px 8px;font-size:10.5px;color:var(--text-weak)}
.capability-bar .dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:4px;vertical-align:1px}
.capability-bar .dot.g{background:#34c759}
.capability-bar .dot.y{background:#ff9500}
.capability-bar .dot.r{background:#ff3b30}
.list{display:flex;flex-direction:column;gap:10px;margin-top:6px}
.ext-card{display:flex;gap:12px;padding:12px}
.ext-card .icon{width:44px;height:44px;border-radius:10px;flex-shrink:0;background:var(--chip-bg);object-fit:contain}
.ext-card .icon-fallback{width:44px;height:44px;border-radius:10px;flex-shrink:0;background:var(--chip-bg);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--text-sub);font-size:18px}
.ext-card .body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.ext-card .title{font-weight:700;font-size:13px;line-height:1.3;word-break:break-word;letter-spacing:-.01em}
.ext-card .publisher{font-size:10.5px;color:var(--text-sub)}
.ext-card .desc{font-size:11.5px;color:var(--text-sub);line-height:1.5;word-break:break-word}
.ext-card .desc-zh{font-size:11.5px;color:var(--text);line-height:1.5;word-break:break-word;border-left:2px solid var(--accent);padding-left:8px;margin-top:2px}
.ext-card .desc-zh.loading{opacity:.5;font-style:italic}
.ext-card .meta{display:flex;gap:8px;align-items:center;font-size:10.5px;color:var(--text-weak);flex-wrap:wrap;margin-top:2px}
.ext-card .meta .bicon{display:inline-flex;align-items:center;gap:3px}
.ext-card .actions{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.ext-card .actions .ap-btn{flex:1;min-width:62px}
.empty{padding:40px 20px;text-align:center;color:var(--text-weak);font-size:12px}
.loading-bar{display:flex;align-items:center;justify-content:center;gap:8px;padding:16px;color:var(--text-weak);font-size:11.5px}
.load-more{display:block;width:100%;margin:4px 0;padding:8px;text-align:center;background:transparent;color:var(--accent);border:none;border-radius:var(--radius-pill);cursor:pointer;font-size:12px;font-weight:600;font-family:inherit}
.load-more:hover{background:var(--accent-soft)}
.load-more:disabled{opacity:.5;cursor:not-allowed}
.settings-area{margin-top:4px;padding:14px;display:none;position:sticky;top:0;z-index:10}
.settings-area.show{display:block}
.settings-area h3{font-size:13px;font-weight:700;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;color:var(--text)}
.settings-area h3 .close{cursor:pointer;color:var(--accent);font-weight:500;font-size:11.5px}
.settings-actions{display:flex;gap:8px;margin-top:14px}
.toast{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);padding:7px 18px;border-radius:var(--radius-pill);font-size:11.5px;z-index:99;display:none;box-shadow:var(--shadow-pop);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.toast.success{background:rgba(52,199,89,.92);color:#fff}
.toast.error{background:rgba(255,59,48,.92);color:#fff}
.toast.info{background:rgba(0,122,255,.92);color:#fff}
.welcome-area{display:flex;align-items:center;justify-content:center;height:320px;text-align:center}
.welcome-content .mark{width:56px;height:56px;border-radius:14px;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;margin:0 auto 14px}
.welcome-content h2{font-size:16px;font-weight:700;margin-bottom:8px;color:var(--text);letter-spacing:-.01em}
.welcome-content p{font-size:12.5px;color:var(--text-sub);margin-bottom:18px;line-height:1.6}
.help-box{margin-top:12px;padding:12px;background:rgba(52,199,89,.08);border:1px solid rgba(52,199,89,.35);border-radius:var(--radius-m);font-size:11px;line-height:1.8;color:var(--text)}
.help-box strong{color:#34c759;display:inline-flex;align-items:center;gap:4px}
</style>
</head>
<body>
<div class="header">
  <div class="search-row">
    <input id="searchInput" class="ap-input" type="text" placeholder="搜索扩展名 / 关键词...">
    <button id="clearSearchBtn" class="ap-btn ap-btn-icon" title="清除搜索" style="display:none">${icon('clear')}</button>
    <button id="searchBtn" class="ap-btn ap-btn-primary">${icon('search')}<span>搜索</span></button>
  </div>
  <div class="toolbar">
    <button id="homeBtn" class="ap-btn ap-btn-icon" title="返回主页">${icon('home')}</button>
    <button id="translatorBtn" class="ap-btn ap-btn-ghost">${icon('globe')}<span>手动翻译</span></button>
    <button id="settingsBtn" class="ap-btn ap-btn-icon" title="设置">${icon('settings')}</button>
    <button id="closePanelBtn" class="ap-btn ap-btn-icon" title="关闭侧边栏">${icon('close')}</button>
  </div>
  <div class="ap-seg" id="sortSeg">
    <span class="sort-chip" data-sort="popular">热门</span>
    <span class="sort-chip" data-sort="downloads">下载量</span>
    <span class="sort-chip" data-sort="rating">评分</span>
    <span class="sort-chip" data-sort="publishedDate">最新</span>
    <span class="sort-chip" data-sort="relevance">相关</span>
  </div>
  <div class="capability-bar" id="capabilityBar">
    <span><span class="dot g" id="dotTrans"></span> 翻译：<span id="transStat">本地</span></span>
    <span><span class="dot r" id="dotSum"></span> AI 总结：<span id="sumStat">需配置</span></span>
  </div>
</div>

<div class="settings-area ap-pop" id="settingsArea">
  <h3>设置 <span class="close" id="closeSettings">收起</span></h3>
  <div class="ap-field">
    <label>Agent 预设（选一个，自动填好地址和模型，你只需填 API Key）</label>
    <select id="presetSelect" class="ap-select">
      <option value="custom">自定义（手动填下方地址和模型）</option>
      <option value="deepseek">DeepSeek 官方</option>
      <option value="openai">OpenAI 官方</option>
      <option value="dashscope">阿里云百炼 DashScope（qwen）</option>
      <option value="moonshot">月之暗面 Kimi</option>
      <option value="glm">智谱 GLM</option>
      <option value="siliconflow">硅基流动 SiliconFlow</option>
    </select>
  </div>
  <div class="ap-field">
    <label>翻译 / 总结 提供商</label>
    <select id="providerSelect" class="ap-select">
      <option value="local">本地词典（离线，无 AI 总结）</option>
      <option value="deepseek">DeepSeek（推荐，翻译 + AI 总结）</option>
      <option value="openai-compatible">OpenAI 兼容（翻译 + AI 总结）</option>
      <option value="deepl">DeepL（仅翻译）</option>
      <option value="google">Google（仅翻译）</option>
      <option value="libretranslate">LibreTranslate（仅翻译）</option>
    </select>
  </div>
  <div class="ap-field">
    <label>API Key</label>
    <input type="password" id="apiKeyInput" class="ap-input" placeholder="输入你的 API Key...">
    <div class="hint">本地词典不需要 Key；其余 provider 必须填写</div>
  </div>
  <div class="ap-field">
    <label>API 地址（选预设后自动填充，可改）</label>
    <input type="text" id="endpointInput" class="ap-input" placeholder="如 https://api.deepseek.com 或 https://api.openai.com">
  </div>
  <div class="ap-field">
    <label>模型名称（选预设后自动填充，可改）</label>
    <input type="text" id="modelInput" class="ap-input" placeholder="如 deepseek-chat、gpt-4o-mini、qwen-plus">
  </div>
  <div class="settings-actions">
    <button class="ap-btn ap-btn-primary" id="saveSettingsBtn">保存</button>
    <button class="ap-btn ap-btn-ghost" id="openSettingsBtn">在 VS Code 设置中打开</button>
  </div>
  <div class="help-box">
    <strong>${icon('key', 12)} 推荐配置</strong><br>
    1. 在「Agent 预设」选一个（如 DeepSeek / 阿里云 / Kimi）→ 地址和模型自动填好<br>
    2. 只填 API Key → 点保存，即可翻译 + AI 总结<br>
    3. 不填 Key 也能用：免费在线翻译（有道/Google）自动生效
  </div>
</div>

<div id="listArea">
  <div class="welcome-area" id="welcomeArea">
    <div class="welcome-content">
      <div class="mark">${icon('globe', 26)}</div>
      <h2>欢迎使用扩展选择助手</h2>
      <p>AI 智能总结 + 翻译，帮助你快速了解 VS Code 扩展</p>
      <button id="loadExtensionsBtn" class="ap-btn ap-btn-primary">${icon('grid')}<span class="lbl">浏览扩展</span></button>
      <div style="margin-top:16px;font-size:12px;color:var(--text-sub)">
        <strong style="color:#ff9500;display:inline-flex;align-items:center;gap:4px">${icon('warning', 12)} 首次使用请先配置 API Key</strong><br>
        点击右上角 ${icon('settings', 12)} 设置 → 选择预设 → 填入 Key
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
const presetSelect = el('presetSelect');
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

// 与扩展侧 icons.ts 一致的简洁线性 SVG 图标
const ICON_GLOBE = '<svg class="ico" viewBox="0 0 16 16" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.25"/><path d="M1.75 8h12.5"/><path d="M8 1.75a9.6 9.6 0 0 1 0 12.5"/></svg>';
const ICON_GRID = '<svg class="ico" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="5.25" height="5.25" rx="1"/><rect x="8.75" y="2" width="5.25" height="5.25" rx="1"/><rect x="2" y="8.75" width="5.25" height="5.25" rx="1"/><rect x="8.75" y="8.75" width="5.25" height="5.25" rx="1"/></svg>';
const ICON_SETTINGS = '<svg class="ico" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="1.8"/><circle cx="8" cy="8" r="4.6"/><path d="M8 1.3v2M8 12.7v2M1.3 8h2M12.7 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4"/></svg>';
const ICON_WARNING = '<svg class="ico" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.25 14.5 13.5h-13z"/><path d="M8 6.5v3.25"/><path d="M8 11.75h.01"/></svg>';

function welcomeHtml(){
  return '<div class="welcome-area">'
    + '<div class="welcome-content">'
    + '<div class="mark">' + ICON_GLOBE + '</div>'
    + '<h2>欢迎使用扩展选择助手</h2>'
    + '<p>AI 智能总结 + 翻译，帮助你快速了解 VS Code 扩展</p>'
    + '<button id="loadExtensionsBtn" class="ap-btn ap-btn-primary">' + ICON_GRID + '<span class="lbl">浏览扩展</span></button>'
    + '<div style="margin-top:16px;font-size:12px;color:var(--text-sub)">'
    + '<strong style="color:#ff9500;display:inline-flex;align-items:center;gap:4px">' + ICON_WARNING + ' 首次使用请先配置 API Key</strong><br>'
    + '点击右上角 ' + ICON_SETTINGS + ' 设置 → 选择预设 → 填入 Key'
    + '</div></div></div>';
}

function renderWelcome(){
  listArea.innerHTML = welcomeHtml();
  bindLoadBtn();
}

function bindLoadBtn(){
  const btn = document.getElementById('loadExtensionsBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    const lbl = btn.querySelector('.lbl');
    if (lbl) lbl.textContent = '加载中…';
    vscode.postMessage({type:'search', query: ''});
  });
}

let state = {
  provider: 'local',
  hasApiKey: false,
  canSummarize: false,
  items: [],
  hasMore: false,
  loading: false,
  query: '',
  sortBy: 'popular',
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
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
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
      ? '<span class="ap-badge red">付费</span>'
      : item.pricingStatus === 'maybePaid'
        ? '<span class="ap-badge orange">可能付费</span>'
        : '<span class="ap-badge green">免费</span>';
    const iconHtml = item.iconUrl
      ? '<img class="icon" src="' + esc(item.iconUrl) + '" alt="' + esc((item.displayName || '?').slice(0,1)) + '">'
      : '<div class="icon-fallback">' + esc((item.displayName || '?').slice(0,1).toUpperCase()) + '</div>';
    parts.push(
      '<div class="ap-card hoverable ext-card" data-id="' + esc(item.id) + '">'
      + iconHtml
      + '<div class="body">'
        + '<div class="title">' + esc(item.displayName) + '</div>'
        + '<div class="publisher">' + esc(item.publisherDisplayName || item.publisher) + ' · v' + esc(item.version) + '</div>'
        + (item.description ? '<div class="desc">' + esc(item.description) + '</div>' : '')
        + '<div class="meta">'
          + badge
          + '<span class="bicon">${icon('download', 11)}' + fmtCount(item.installCount) + '</span>'
          + (item.ratingScore ? '<span class="bicon">${icon('star', 11)}' + item.ratingScore.toFixed(1) + '（' + fmtCount(item.ratingCount) + '）</span>' : '')
        + '</div>'
        + '<div class="actions">'
          + '<button class="ap-btn ap-btn-sm ap-btn-primary" data-act="detail">${icon('doc', 12)}<span>详情</span></button>'
          + '<button class="ap-btn ap-btn-sm" data-act="summary">${icon('sparkle', 12)}<span>AI 总结</span></button>'
          + '<button class="ap-btn ap-btn-sm" data-act="install" title="在 VS Code 中安装">${icon('install', 12)}<span>安装</span></button>'
          + '<button class="ap-btn ap-btn-sm ap-btn-icon" data-act="open" title="在编辑器打开扩展页">${icon('external', 12)}</button>'
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
  listArea.querySelectorAll('.ext-card').forEach((card) => {
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
    listArea.innerHTML = '<div class="loading-bar"><span class="ap-spinner"></span>加载中…</div>';
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
  clearSearchBtn.style.display = state.query ? '' : 'none';
  vscode.postMessage({type:'search', query: state.query});
}
searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
searchInput.addEventListener('input', () => {
  clearSearchBtn.style.display = searchInput.value.trim() ? '' : 'none';
});

sortChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    sortChips.forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.sortBy = chip.getAttribute('data-sort');
    vscode.postMessage({type:'setSort', sortBy: state.sortBy});
  });
});

/* ---- Agent 预设：选择后自动填充 provider / endpoint / model ---- */
const PRESETS = {
  deepseek: { provider: 'deepseek', endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai: { provider: 'openai-compatible', endpoint: 'https://api.openai.com', model: 'gpt-4o-mini' },
  dashscope: { provider: 'openai-compatible', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  moonshot: { provider: 'openai-compatible', endpoint: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  glm: { provider: 'openai-compatible', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  siliconflow: { provider: 'openai-compatible', endpoint: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
};

function detectPreset(provider, endpoint, model){
  for (const key of Object.keys(PRESETS)) {
    const p = PRESETS[key];
    if (p.provider === provider && p.endpoint === (endpoint || '').replace(/\\/+$/, '') && p.model === model) {
      return key;
    }
  }
  return 'custom';
}

if (presetSelect) {
  presetSelect.addEventListener('change', () => {
    const p = PRESETS[presetSelect.value];
    if (p) {
      providerSelect.value = p.provider;
      endpointInput.value = p.endpoint;
      modelInput.value = p.model;
    }
  });
}

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
    const lbl = loadExtensionsBtn.querySelector('.lbl');
    if (lbl) lbl.textContent = '加载中…';
    vscode.postMessage({type:'search', query: ''});
  });
}
closeSettings.addEventListener('click', () => settingsArea.classList.remove('show'));

const closePanelBtn = el('closePanelBtn');
if (closePanelBtn) {
  closePanelBtn.addEventListener('click', () => vscode.postMessage({ type: 'closePanel' }));
}

/* ---- 翻译面板 ---- */
const translatorBtn = el('translatorBtn');
if (translatorBtn) {
  translatorBtn.addEventListener('click', () => vscode.postMessage({ type: 'openTranslator' }));
}

/* ---- 返回主页 ---- */
const homeBtn = el('homeBtn');
if (homeBtn) {
  homeBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.query = '';
    clearSearchBtn.style.display = 'none';
    vscode.postMessage({ type: 'clearSearch' });
  });
}

/* ---- 清除搜索 ---- */
const clearSearchBtn = el('clearSearchBtn');
if (clearSearchBtn) {
  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.query = '';
    clearSearchBtn.style.display = 'none';
    vscode.postMessage({ type: 'clearSearch' });
  });
}
/**********************/

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
      // 显示欢迎页（初始状态 / 清除搜索后）
      state.loading = false;
      state.items = [];
      state.hasMore = false;
      state.descMap = {};
      if (msg.sortBy) state.sortBy = msg.sortBy;
      sortChips.forEach((c) => c.classList.toggle('active', c.getAttribute('data-sort') === state.sortBy));
      renderWelcome();
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
      if (msg.sortBy) state.sortBy = msg.sortBy;
      sortChips.forEach((c) => c.classList.toggle('active', c.getAttribute('data-sort') === state.sortBy));
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
      presetSelect.value = detectPreset(msg.provider, msg.endpoint, msg.model);
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
        renderWelcome();
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