import * as vscode from 'vscode';
import { Translator, TranslationConfig, listModels, checkModel } from './translator';
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

        case 'detectModels': {
          try {
            const models = await listModels(
              String(msg.endpoint || '').trim(),
              String(msg.apiKey || '').trim()
            );
            this.postMessage({ type: 'detectModelsResult', models, silent: msg.silent });
          } catch (err: any) {
            this.postMessage({ type: 'detectModelsResult', error: err.message || String(err), silent: msg.silent });
          }
          break;
        }

        case 'applyApiKey': {
          try {
            const provider = msg.provider || 'deepseek';
            const endpoint = String(msg.endpoint || '').trim();
            const model = String(msg.model || '').trim();
            const apiKey = String(msg.apiKey || '').trim();
            await this.persistSettings(provider, apiKey, endpoint, model);
            const cfg = this.syncConfig();
            this.verifyModelInBackground(provider, endpoint, model, apiKey);
            this.postMessage({
              type: 'applyApiKeyResult',
              provider: cfg.provider,
              hasApiKey: !!cfg.apiKey,
              canSummarize: this._translator.canSummarize(),
              models: [],
              detectError: '',
            });

            // 后台检测模型列表，完成后单独推送结果（静默）
            if (endpoint && apiKey && (provider === 'deepseek' || provider === 'openai-compatible')) {
              listModels(endpoint, apiKey)
                .then((models) => {
                  this.postMessage({ type: 'detectModelsResult', models, silent: true });
                })
                .catch((e: any) => {
                  this.postMessage({ type: 'detectModelsResult', error: e.message || String(e), silent: true });
                });
            }
          } catch (err: any) {
            const raw = err.message || String(err);
            if (/Unable to write into user settings|无法写入用户设置/i.test(raw)) {
              this.postMessage({
                type: 'error',
                message: '无法写入 VS Code 用户设置：settings.json 可能存在 JSON 语法错误。请点「在 VS Code 设置中打开」修复 settings.json 后重试。',
              });
            } else {
              this.postMessage({ type: 'error', message: '保存 API Key 失败: ' + raw });
            }
          }
          break;
        }

        case 'verifyModel': {
          this.verifyModelInBackground(
            msg.provider || 'openai-compatible',
            String(msg.endpoint || '').trim(),
            String(msg.model || '').trim(),
            String(msg.apiKey || '').trim()
          );
          break;
        }

        case 'saveSettings': {
          try {
            await this.persistSettings(
              msg.provider || 'deepseek',
              msg.apiKey || '',
              msg.endpoint || '',
              msg.model || ''
            );
            const cfg = this.syncConfig();
            this.verifyModelInBackground(
              msg.provider || 'deepseek',
              msg.endpoint || '',
              msg.model || '',
              msg.apiKey || ''
            );
            this.postMessage({
              type: 'settingsSaved',
              provider: cfg.provider,
              hasApiKey: !!cfg.apiKey,
              canSummarize: this._translator.canSummarize(),
            });
          } catch (err: any) {
            const raw = err.message || String(err);
            if (/Unable to write into user settings|无法写入用户设置/i.test(raw)) {
              this.postMessage({
                type: 'error',
                message: '无法写入 VS Code 用户设置：settings.json 可能存在 JSON 语法错误。请点「在 VS Code 设置中打开」修复 settings.json 后重试。',
              });
            } else {
              this.postMessage({ type: 'error', message: '保存设置失败: ' + raw });
            }
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

  private async persistSettings(
    provider: string,
    apiKey: string,
    endpoint: string,
    model: string
  ): Promise<void> {
    const chConfig = vscode.workspace.getConfiguration('chineseEyes');
    await chConfig.update('translationProvider', provider, vscode.ConfigurationTarget.Global);
    await chConfig.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
    await chConfig.update('apiEndpoint', endpoint, vscode.ConfigurationTarget.Global);
    await chConfig.update('apiModel', model, vscode.ConfigurationTarget.Global);
  }

  /** 保存后后台校验模型名是否有效（LLM 供应商 + 已填 Key），结果通知前端显示状态 */
  private verifyModelInBackground(provider: string, endpoint: string, model: string, apiKey: string): void {
    if (!(provider === 'deepseek' || provider === 'openai-compatible') || !apiKey || !model) {
      return;
    }
    const defaultEndpoint = provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com';
    checkModel(endpoint || defaultEndpoint, model, apiKey)
      .then((r) => {
        if (r.ok) {
          this.postMessage({ type: 'modelCheckResult', ok: true, model });
        } else {
          this.postMessage({ type: 'modelCheckResult', ok: false, error: r.error || '模型不可用', model });
        }
      })
      .catch((e: any) => {
        console.warn('[chineseEyes] 模型校验异常:', e);
      });
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
.model-row{display:flex;gap:6px;align-items:center}
.key-row{display:flex;gap:6px;align-items:center}
.key-row .ap-input{flex:1;min-width:0}
.model-input-row{display:flex;gap:6px;align-items:center}
.model-input-row .ap-input{flex:1;min-width:0}
.model-status{display:inline-flex;align-items:center;gap:4px;font-size:11px;flex-shrink:0;white-space:nowrap}
.model-status.bad{color:#ff3b30}
.model-status.good{color:#34c759}
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
    <label>Agent 供应商</label>
    <select id="vendorSelect" class="ap-select">
      <option value="local">本地词典（离线，无 AI 总结，免 Key）</option>
      <option value="deepseek">DeepSeek 官方（翻译 + AI 总结）</option>
      <option value="openai">OpenAI 官方（翻译 + AI 总结）</option>
      <option value="dashscope">阿里云百炼 DashScope（翻译 + AI 总结）</option>
      <option value="moonshot">月之暗面 Kimi（翻译 + AI 总结）</option>
      <option value="glm">智谱 GLM（翻译 + AI 总结）</option>
      <option value="siliconflow">硅基流动 SiliconFlow（翻译 + AI 总结）</option>
      <option value="deepl">DeepL（仅翻译）</option>
      <option value="google">Google（仅翻译）</option>
      <option value="libretranslate">LibreTranslate（仅翻译）</option>
      <option value="custom">自定义（手动填下方地址和模型）</option>
    </select>
    <div class="hint">选品牌自动填好地址和模型，你只需填 API Key</div>
  </div>
  <div class="ap-field">
    <label>API Key</label>
    <div class="key-row">
      <input type="password" id="apiKeyInput" class="ap-input" placeholder="输入你的 API Key...">
      <button id="applyKeyBtn" class="ap-btn ap-btn-primary ap-btn-sm" type="button" title="单独保存 API Key 并自动检测模型">应用</button>
    </div>
    <div class="hint">点「应用」立即保存 Key 并检测模型；本地词典不需要 Key</div>
  </div>
  <div class="ap-field">
    <label>API 地址（选品牌自动填充；仅「自定义」需手动填）</label>
    <input type="text" id="endpointInput" class="ap-input" placeholder="选择自定义供应商后填写，如 https://api.deepseek.com" disabled>
  </div>
  <div class="ap-field">
    <label>模型（下拉选择常用模型，或直接输入自定义模型名）</label>
    <div class="model-row">
      <select id="modelSelect" class="ap-select" style="flex:1"></select>
      <button id="detectModelsBtn" class="ap-btn ap-btn-ghost ap-btn-sm" type="button" title="用 API 地址 + Key 检索可用模型列表">检测模型</button>
    </div>
    <div class="model-input-row">
      <input type="text" id="modelInput" class="ap-input" placeholder="当前模型；也可输入自定义模型名，保存时以这里为准">
      <span id="modelStatus" class="model-status" style="display:none"></span>
    </div>
    <div class="hint">下拉框选择会同步到这里；手输任意模型名后保存即可生效</div>
  </div>
  <div class="settings-actions">
    <button class="ap-btn" id="saveSettingsBtn" disabled title="修改设置后可保存">保存</button>
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
const vendorSelect = el('vendorSelect');
const apiKeyInput = el('apiKeyInput');
const modelSelect = el('modelSelect');
const detectModelsBtn = el('detectModelsBtn');
const applyKeyBtn = el('applyKeyBtn');
const modelStatus = el('modelStatus');
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
  deepseek: {
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
  },
  openai: {
    provider: 'openai-compatible',
    endpoint: 'https://api.openai.com',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
  },
  dashscope: {
    provider: 'openai-compatible',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-flash', 'qwen-plus-latest'],
  },
  moonshot: {
    provider: 'openai-compatible',
    endpoint: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  glm: {
    provider: 'openai-compatible',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4'],
  },
  siliconflow: {
    provider: 'openai-compatible',
    endpoint: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'],
  },
};

/** 供应商 → 后端 provider 值（自定义默认按 OpenAI 兼容处理，地址需手动填） */
const VENDOR_PROVIDER = {
  local: 'local',
  deepl: 'deepl',
  google: 'google',
  libretranslate: 'libretranslate',
  custom: 'openai-compatible',
};

function vendorProvider(vendor){
  if (VENDOR_PROVIDER[vendor]) return VENDOR_PROVIDER[vendor];
  const p = PRESETS[vendor];
  return p ? p.provider : 'openai-compatible';
}

/** 按 endpoint 域名匹配品牌预设（不要求模型一致，用于自动列出模型候选） */
function presetByEndpoint(endpoint){
  const ep = String(endpoint || '').trim().replace(/\\/+$/, '').toLowerCase();
  if (!ep) return null;
  for (const key of Object.keys(PRESETS)) {
    const p = PRESETS[key];
    const pe = p.endpoint.toLowerCase().replace(/\\/+$/, '');
    if (ep === pe) return { key, preset: p };
    try {
      if (new URL(ep).hostname === new URL(pe).hostname) return { key, preset: p };
    } catch (e) { /* 忽略 */ }
  }
  return null;
}

/** 根据已保存配置反推供应商选择（老用户兼容，不覆盖原配置） */
function vendorFromConfig(provider, endpoint, model){
  if (provider === 'deepl') return 'deepl';
  if (provider === 'google') return 'google';
  if (provider === 'libretranslate') return 'libretranslate';
  if (provider === 'local') return 'local';
  const m = presetByEndpoint(endpoint);
  if (m) return m.key;
  if (provider === 'deepseek' && !endpoint) return 'deepseek';
  return 'custom';
}

/** 填充模型下拉框：候选模型 + 当前值（保持选中），不覆盖用户已填内容 */
function populateModelSelect(candidates){
  if (!modelSelect) return;
  const current = (modelInput.value || '').trim();
  const list = Array.isArray(candidates) ? candidates.slice() : [];
  if (current && !list.includes(current)) {
    list.unshift(current);
  }
  modelSelect.innerHTML = list
    .map((m) => '<option value="' + String(m).replace(/"/g, '&quot;') + '">' + String(m).replace(/</g, '&lt;') + '</option>')
    .join('');
  if (current) modelSelect.value = current;
  if (!list.length) {
    modelSelect.innerHTML = '<option value="">（填写地址后点「检测模型」）</option>';
  }
}

// 供应商选择：品牌自动填地址/模型；本地与仅翻译选项不改动地址模型
if (vendorSelect) {
  vendorSelect.addEventListener('change', () => {
    const p = PRESETS[vendorSelect.value];
    if (p) {
      endpointInput.value = p.endpoint;
      if (!modelInput.value.trim()) modelInput.value = p.model;
      populateModelSelect(p.models);
    }
    updateEndpointInputState();
    markSettingsDirty();
  });
}

// 手动输入地址时（仅自定义模式）：匹配品牌则同步供应商选择并锁定地址框，否则保持自定义
if (endpointInput) {
  endpointInput.addEventListener('input', () => {
    const m = presetByEndpoint(endpointInput.value);
    if (m) {
      vendorSelect.value = m.key;
      updateEndpointInputState();
      populateModelSelect(m.preset.models);
    } else if (endpointInput.value.trim()) {
      vendorSelect.value = 'custom';
    }
    markSettingsDirty();
  });
}

// 下拉框选择 → 同步到输入框
if (modelSelect) {
  modelSelect.addEventListener('change', () => {
    if (modelSelect.value) {
      modelInput.value = modelSelect.value;
    }
    markSettingsDirty();
  });
}

// 检测模型：用当前地址 + Key 从 API 检索模型列表
if (detectModelsBtn) {
  detectModelsBtn.addEventListener('click', () => {
    const endpoint = endpointInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    if (!endpoint) { showToast('请先填写 API 地址', 'error'); return; }
    if (!apiKey) { showToast('请先填写 API Key', 'error'); return; }
    detectModelsBtn.disabled = true;
    detectModelsBtn.textContent = '检测中…';
    vscode.postMessage({ type: 'detectModels', endpoint, apiKey });
  });
}

/* ---- 应用/保存状态机与防误触 ---- */
let appliedKey = '';   // 已成功应用/保存的 API Key（trim 后）
let busyTimer = null;
let settingsDirty = false; // 设置面板是否有未保存的修改
let modelsDetectedFor = ''; // 已自动检测过模型的 供应商|地址|Key，避免重复请求

// 模型校验状态图标
const ICON_WARN_TRI = '<svg class="ico" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#ff9500" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.25 14.5 13.5h-13z"/><path d="M8 6.5v3.25"/><path d="M8 11.75h.01"/></svg>';
const ICON_CHECK_GREEN = '<svg class="ico" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#34c759" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.25"/><path d="M5.25 8.25l2 2 3.5-4"/></svg>';

/** 模型校验状态：bad=黄色感叹+红字，good=绿圈对勾，checking=校验中，none=隐藏 */
function setModelStatus(kind, text){
  if (!modelStatus) return;
  if (kind === 'bad') {
    modelStatus.innerHTML = ICON_WARN_TRI + '<span>无法识别该模型</span>';
    modelStatus.className = 'model-status bad';
    modelStatus.style.display = 'inline-flex';
  } else if (kind === 'good') {
    modelStatus.innerHTML = ICON_CHECK_GREEN;
    modelStatus.className = 'model-status good';
    modelStatus.style.display = 'inline-flex';
  } else if (kind === 'checking') {
    modelStatus.innerHTML = '<span style="color:var(--text-weak)">校验中…</span>';
    modelStatus.className = 'model-status';
    modelStatus.style.display = 'inline-flex';
  } else {
    modelStatus.style.display = 'none';
    modelStatus.className = 'model-status';
  }
}

function updateApplyBtnState(){
  const key = apiKeyInput.value.trim();
  const isApplied = !!key && key === appliedKey;
  applyKeyBtn.textContent = isApplied ? '已应用' : '应用';
  applyKeyBtn.classList.toggle('ap-btn-success', isApplied);
  applyKeyBtn.classList.toggle('ap-btn-primary', !isApplied);
}

/** 保存按钮：有未保存修改 → 蓝色可点；无修改 → 灰色不可点 */
function updateSaveBtnState(){
  saveSettingsBtn.disabled = !settingsDirty;
  saveSettingsBtn.classList.toggle('ap-btn-primary', settingsDirty);
}

/** 地址输入框：品牌/本地/仅翻译供应商由预设自动填充并锁定，只有「自定义」可手动填 */
function updateEndpointInputState(){
  const isCustom = vendorSelect.value === 'custom';
  endpointInput.disabled = !isCustom;
  endpointInput.placeholder = isCustom
    ? '输入自定义 API 地址，如 https://api.deepseek.com'
    : '地址由供应商预设自动填充';
}

function markSettingsDirty(){
  settingsDirty = true;
  updateSaveBtnState();
  setModelStatus('none'); // 修改设置后清空旧校验状态
}

function markSettingsClean(){
  settingsDirty = false;
  updateSaveBtnState();
}

function setSettingsBusy(busy){
  // 写入期间禁用设置面板内所有控件，防止误操作
  settingsArea.querySelectorAll('button, select, input').forEach((c) => { c.disabled = busy; });
  clearTimeout(busyTimer);
  if (busy) {
    // 防卡死：20 秒后强制恢复界面
    busyTimer = setTimeout(() => {
      setSettingsBusy(false);
      if (applyKeyBtn.textContent === '应用中…') { appliedKey = ''; }
      if (saveSettingsBtn.textContent === '保存中…') { saveSettingsBtn.textContent = '保存'; }
      showToast('操作超时，已恢复界面，请重试', 'error');
    }, 20000);
  } else {
    saveSettingsBtn.textContent = '保存';
    updateApplyBtnState();
    updateSaveBtnState();
    updateEndpointInputState();
  }
}

// API 输入框被编辑（换了新 Key）→ 应用按钮恢复蓝色「应用」，保存按钮变蓝可点
apiKeyInput.addEventListener('input', () => {
  const key = apiKeyInput.value.trim();
  if (appliedKey && key !== appliedKey) {
    appliedKey = '';
  }
  updateApplyBtnState();
  markSettingsDirty();
});

// 模型手动输入也算修改
modelInput.addEventListener('input', markSettingsDirty);

// 应用按钮：单独保存 API Key 并自动检测模型（防止未点底部保存导致 Key 丢失）
if (applyKeyBtn) {
  applyKeyBtn.addEventListener('click', () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) { showToast('请先粘贴 API Key', 'error'); return; }
    const vendor = vendorSelect.value;
    if (vendor === 'local' || (vendor === 'custom' && !endpointInput.value.trim())) {
      showToast('请选择 Agent 供应商：在上方下拉框选择品牌（如 DeepSeek / 阿里云 / Kimi），API Key 才能生效', 'error');
      vendorSelect.focus();
      return;
    }
    setSettingsBusy(true);
    applyKeyBtn.textContent = '应用中…';
    applyKeyBtn.classList.remove('ap-btn-success');
    setModelStatus('checking');
    vscode.postMessage({
      type: 'applyApiKey',
      provider: vendorProvider(vendor),
      apiKey,
      endpoint: endpointInput.value.trim(),
      model: modelInput.value.trim(),
    });
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
    settingsArea.classList.remove('show'); // 收起设置面板
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
  // 校验：填了 API Key 但供应商还是本地/自定义且无地址时，提醒用户先选 Agent 供应商
  const hasKey = !!apiKeyInput.value.trim();
  const vendor = vendorSelect.value;
  if (hasKey && (vendor === 'local' || (vendor === 'custom' && !endpointInput.value.trim()))) {
    showToast('请选择 Agent 供应商：在上方下拉框选择品牌（如 DeepSeek / 阿里云 / Kimi），保存后翻译才能生效', 'error');
    vendorSelect.focus();
    return;
  }
  setSettingsBusy(true);
  saveSettingsBtn.textContent = '保存中…';
  setModelStatus('checking');
  vscode.postMessage({
    type: 'saveSettings',
    provider: vendorProvider(vendor),
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
      // 从后端获取到真实配置值，填充设置面板（老用户已保存的配置原样展示）
      apiKeyInput.value = msg.apiKey || '';
      endpointInput.value = msg.endpoint || '';
      modelInput.value = msg.model || '';
      const vendor = vendorFromConfig(msg.provider, msg.endpoint, msg.model);
      vendorSelect.value = vendor;
      // 品牌预设但地址为空时，自动补默认地址（方便点「检测模型」，不影响后端默认逻辑）
      if (!endpointInput.value.trim() && PRESETS[vendor]) {
        endpointInput.value = PRESETS[vendor].endpoint;
      }
      updateEndpointInputState();
      // 已保存过 Key 的显示「已应用」绿色状态
      appliedKey = msg.apiKey || '';
      updateApplyBtnState();
      // 加载完成后视为干净状态：保存按钮灰色
      markSettingsClean();
      // 候选模型：地址匹配预设 → 品牌模型列表；否则用供应商预设的模型列表
      const matched = presetByEndpoint(endpointInput.value);
      const candidates = matched
        ? matched.preset.models
        : PRESETS[vendor]
          ? PRESETS[vendor].models
          : msg.model
            ? [msg.model]
            : [];
      populateModelSelect(candidates);
      // 已配置 Key + 品牌供应商 → 自动后台检测真实模型列表（静默填充，有缓存防频繁请求）
      if (appliedKey && PRESETS[vendor] && endpointInput.value.trim()) {
        const detKey = vendor + '|' + endpointInput.value.trim() + '|' + appliedKey;
        if (modelsDetectedFor !== detKey) {
          modelsDetectedFor = detKey;
          vscode.postMessage({
            type: 'detectModels',
            endpoint: endpointInput.value.trim(),
            apiKey: appliedKey,
            silent: true,
          });
        }
      }
      // 已配置 Key + 模型 → 自动校验模型有效性（绿勾/红字状态）
      if (appliedKey && modelInput.value.trim() && PRESETS[vendor]) {
        setModelStatus('checking');
        vscode.postMessage({
          type: 'verifyModel',
          provider: vendorProvider(vendor),
          endpoint: endpointInput.value.trim(),
          model: modelInput.value.trim(),
          apiKey: appliedKey,
        });
      }
      break;
    case 'applyApiKeyResult':
      setSettingsBusy(false);
      // 应用成功：记录已应用的 Key，按钮变绿色「已应用」
      appliedKey = apiKeyInput.value.trim();
      updateApplyBtnState();
      // 应用已保存全部设置 → 保存按钮回灰色
      markSettingsClean();
      state.provider = msg.provider || 'local';
      state.hasApiKey = !!msg.hasApiKey;
      state.canSummarize = !!msg.canSummarize;
      renderCapability();
      if (Array.isArray(msg.models) && msg.models.length > 0) {
        populateModelSelect(msg.models);
      }
      showToast('API Key 已应用' + (endpointInput.value.trim() ? '，正在后台检测模型…' : ''), 'success');
      break;
    case 'modelCheckResult':
      // 校验结果与当前输入框模型一致才更新状态（用户可能已改）
      if (msg.model && msg.model !== modelInput.value.trim()) break;
      if (msg.ok) {
        setModelStatus('good');
      } else {
        setModelStatus('bad');
        showToast('模型「' + (msg.model || '') + '」校验失败：' + (msg.error || '未知错误') + '。请检查模型名或点「检测模型」选择正确模型。', 'error');
      }
      break;
    case 'detectModelsResult':
      detectModelsBtn.disabled = false;
      detectModelsBtn.textContent = '检测模型';
      if (msg.error) {
        // 静默检测（打开面板自动触发）失败不打扰用户；手动点击才提示
        if (!msg.silent) showToast(msg.error, 'error');
        break;
      }
      if (Array.isArray(msg.models) && msg.models.length > 0) {
        populateModelSelect(msg.models);
        // 记录已检测组合，避免重复自动检测
        modelsDetectedFor = vendorSelect.value + '|' + endpointInput.value.trim() + '|' + apiKeyInput.value.trim();
        if (!msg.silent) {
          showToast('检测到 ' + msg.models.length + ' 个模型，可在下拉框切换', 'success');
        }
      } else if (!msg.silent) {
        showToast('未检测到模型列表，请手动输入模型名', 'error');
      }
      break;
    case 'settingsSaved':
      setSettingsBusy(false);
      // 保存成功也视为已应用（Key 已持久化）
      appliedKey = apiKeyInput.value.trim();
      updateApplyBtnState();
      markSettingsClean();
      state.provider = msg.provider;
      state.hasApiKey = !!msg.hasApiKey;
      state.canSummarize = !!msg.canSummarize;
      renderCapability();
      settingsArea.classList.remove('show');
      showToast('设置已保存', 'success');
      // 不自动重新搜索，避免保存后跳转到热门列表页
      break;
    case 'error':
      state.loading = false;
      // 若设置面板处于写入状态（应用中/保存中），恢复界面防止卡死
      if (applyKeyBtn.textContent === '应用中…' || saveSettingsBtn.textContent === '保存中…') {
        setSettingsBusy(false);
      }
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