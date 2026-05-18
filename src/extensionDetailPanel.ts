import * as vscode from 'vscode';
import { Translator } from './translator';
import { ExtensionItem } from './types';
import { getExtensionReadme } from './marketplaceApi';

/**
 * 扩展详情面板（在主编辑区独立 webview panel）
 * - 顶部：扩展元信息（图标、名称、发布者、安装量、价格、版本、链接）
 * - 中段：AI 总结（可折叠，加载中/已加载/未加载）
 * - 下方：翻译后的中文 README（与原文 toggle）
 */
export class ExtensionDetailPanel {
  public static readonly viewType = 'chineseEyes.detail';
  private static activePanels = new Map<string, ExtensionDetailPanel>();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _translator: Translator;
  private readonly _item: ExtensionItem;
  private _disposables: vscode.Disposable[] = [];

  private _originalReadme = '';
  private _translatedReadme = '';
  private _summary = '';

  public static show(
    extensionUri: vscode.Uri,
    translator: Translator,
    item: ExtensionItem,
    opts: { openSummary?: boolean } = {}
  ): ExtensionDetailPanel {
    const existing = ExtensionDetailPanel.activePanels.get(item.id);
    if (existing) {
      existing._panel.reveal(vscode.ViewColumn.One);
      if (opts.openSummary) {
        existing.requestSummary();
      }
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      ExtensionDetailPanel.viewType,
      `${item.displayName} - 详情`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    const inst = new ExtensionDetailPanel(panel, extensionUri, translator, item);
    ExtensionDetailPanel.activePanels.set(item.id, inst);
    inst.boot(opts.openSummary === true);
    return inst;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    translator: Translator,
    item: ExtensionItem
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._translator = translator;
    this._item = item;

    this._panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    this._panel.webview.html = this.buildHtml(this._panel.webview);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (m) => this.handleMessage(m),
      null,
      this._disposables
    );
  }

  private dispose(): void {
    ExtensionDetailPanel.activePanels.delete(this._item.id);
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  /** 初始化加载 README + 自动翻译 */
  private async boot(openSummary: boolean): Promise<void> {
    this.post({ type: 'item', item: this._item, openSummary });

    const config = vscode.workspace.getConfiguration('chineseEyes');
    const autoTranslate = config.get('autoTranslateReadme', true);

    // 1) 加载 README
    this.post({ type: 'readmeLoading' });
    try {
      const readme = await getExtensionReadme(
        this._item.publisher,
        this._item.extensionName || this._item.id.split('.').slice(1).join('.'),
        this._item.readmeUrl
      );
      this._originalReadme = readme || '';
      this.post({
        type: 'readmeLoaded',
        original: this._originalReadme,
        translated: '',
      });
    } catch (err: any) {
      this.post({ type: 'readmeError', message: err.message || String(err) });
      return;
    }

    // 2) 自动翻译（如果开启且当前 provider 支持）
    if (autoTranslate && this._originalReadme) {
      await this.translateReadme();
    }

    // 3) 如果用户点的是「AI 总结」按钮，立即生成总结
    if (openSummary) {
      this.requestSummary();
    }
  }

  private async translateReadme(): Promise<void> {
    if (!this._originalReadme) return;
    this.post({ type: 'translating' });
    try {
      const isHtml = /<\w+/.test(this._originalReadme);
      const sourceText = isHtml ? stripHtml(this._originalReadme) : this._originalReadme;
      const translated = await this._translator.translateMarkdown(sourceText);
      this._translatedReadme = translated;
      this.post({
        type: 'readmeLoaded',
        original: this._originalReadme,
        translated: this._translatedReadme,
      });
    } catch (err: any) {
      this.post({
        type: 'translateError',
        message: err.message || String(err),
      });
    }
  }

  private async requestSummary(): Promise<void> {
    if (this._summary) {
      this.post({ type: 'summaryDone', summary: this._summary });
      return;
    }
    if (!this._translator.canSummarize()) {
      this.post({
        type: 'summaryError',
        message: '需要配置 DeepSeek 或 OpenAI 兼容 API Key 才能使用 AI 总结。请打开侧边栏「⚙ 设置」。',
      });
      return;
    }
    this.post({ type: 'summarizing' });
    try {
      const isHtml = /<\w+/.test(this._originalReadme);
      const text = (isHtml ? stripHtml(this._originalReadme) : this._originalReadme) || this._item.description;
      if (!text || !text.trim()) {
        this.post({
          type: 'summaryError',
          message: '没有可总结的内容（扩展未提供 README 或描述）',
        });
        return;
      }
      const summary = await this._translator.summarize(text);
      this._summary = summary;
      this.post({ type: 'summaryDone', summary });
    } catch (err: any) {
      this.post({
        type: 'summaryError',
        message: err.message || String(err),
      });
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          this.post({ type: 'item', item: this._item, openSummary: false });
          break;
        case 'requestTranslate':
          await this.translateReadme();
          break;
        case 'requestSummary':
          await this.requestSummary();
          break;
        case 'install':
          vscode.commands.executeCommand(
            'workbench.extensions.installExtension',
            this._item.id
          );
          break;
        case 'openUrl':
          if (msg.url) vscode.env.openExternal(vscode.Uri.parse(msg.url));
          break;
        case 'openMarketplace':
          vscode.env.openExternal(
            vscode.Uri.parse(
              `https://marketplace.visualstudio.com/items?itemName=${this._item.id}`
            )
          );
          break;
      }
    } catch (err: any) {
      this.post({ type: 'error', message: err.message || String(err) });
    }
  }

  private post(msg: any): void {
    this._panel.webview.postMessage(msg);
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
  --success:#1ea55b;--warning:#c9a93c;--error:#c95c3c;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);color:var(--fg);background:var(--bg);font-size:14px;line-height:1.6}
.container{max-width:920px;margin:0 auto;padding:20px}
.header{display:flex;gap:16px;padding-bottom:18px;border-bottom:1px solid var(--border);margin-bottom:18px}
.header .icon{width:80px;height:80px;border-radius:10px;background:rgba(128,128,128,.15);flex-shrink:0;object-fit:contain}
.header .icon-fallback{width:80px;height:80px;border-radius:10px;background:rgba(128,128,128,.15);display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:700;color:var(--sub);flex-shrink:0}
.header .info{flex:1;min-width:0}
.header .title{font-size:22px;font-weight:700;line-height:1.2;margin-bottom:4px;word-break:break-word}
.header .publisher{font-size:13px;color:var(--sub);margin-bottom:8px}
.header .desc{font-size:13px;color:var(--fg);margin-bottom:6px;opacity:.9}
.header .desc-zh{font-size:13px;border-left:3px solid var(--success);padding-left:8px;margin-bottom:6px;color:var(--fg)}
.header .meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--sub);margin-top:6px}
.header .badge{padding:2px 8px;border-radius:10px;font-size:11px}
.header .badge.free{background:rgba(30,165,91,.15);color:var(--success)}
.header .badge.paid{background:rgba(201,92,60,.15);color:var(--error)}
.header .badge.maybe{background:rgba(201,169,60,.15);color:var(--warning)}
.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.actions button,.actions a{padding:6px 14px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--fg);cursor:pointer;font-size:12px;text-decoration:none;display:inline-block}
.actions button:hover,.actions a:hover{background:var(--btn);color:var(--btn-fg);border-color:var(--btn)}
.actions .primary{background:var(--btn);color:var(--btn-fg);border-color:var(--btn)}
.actions .primary:hover{background:var(--btn-hover)}
.section{margin-bottom:24px;padding:14px;background:var(--card);border:1px solid var(--border);border-radius:8px}
.section.summary{border-color:var(--link)}
.section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.section-head h2{font-size:15px;font-weight:600;display:flex;align-items:center;gap:6px}
.section-head .controls{display:flex;gap:6px}
.section-head .controls button{padding:4px 10px;font-size:11px;border:1px solid var(--border);background:transparent;color:var(--sub);border-radius:4px;cursor:pointer}
.section-head .controls button:hover{background:var(--btn);color:var(--btn-fg);border-color:var(--btn)}
.section-head .controls button.active{background:var(--btn);color:var(--btn-fg);border-color:var(--btn)}
.section-body{color:var(--fg);font-size:13px;line-height:1.75}
.section-body.markdown h1,.section-body.markdown h2,.section-body.markdown h3,.section-body.markdown h4{margin:14px 0 6px;font-weight:700}
.section-body.markdown h1{font-size:20px}
.section-body.markdown h2{font-size:17px;padding-bottom:4px;border-bottom:1px solid var(--border)}
.section-body.markdown h3{font-size:15px}
.section-body.markdown p{margin:6px 0}
.section-body.markdown ul,.section-body.markdown ol{margin:6px 0 6px 20px}
.section-body.markdown li{margin:2px 0}
.section-body.markdown code{font-family:var(--vscode-editor-font-family, monospace);background:rgba(128,128,128,.15);padding:1px 5px;border-radius:3px;font-size:12px}
.section-body.markdown pre{background:rgba(128,128,128,.1);padding:10px;border-radius:4px;overflow:auto;margin:8px 0}
.section-body.markdown pre code{background:transparent;padding:0}
.section-body.markdown blockquote{border-left:3px solid var(--sub);padding-left:10px;color:var(--sub);margin:6px 0}
.section-body.markdown a{color:var(--link);text-decoration:none}
.section-body.markdown a:hover{text-decoration:underline}
.section-body.markdown img{max-width:100%;height:auto;border-radius:4px}
.section-body.markdown table{border-collapse:collapse;margin:8px 0;width:100%}
.section-body.markdown table td,.section-body.markdown table th{border:1px solid var(--border);padding:5px 8px}
.section-body.markdown hr{border:none;border-top:1px solid var(--border);margin:10px 0}
.empty-state{color:var(--sub);font-style:italic;padding:12px;text-align:center}
.loading-state{display:flex;align-items:center;justify-content:center;gap:8px;padding:18px;color:var(--sub)}
.spinner{width:14px;height:14px;border:2px solid var(--sub);border-top-color:var(--btn);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.error-state{padding:10px;background:rgba(201,92,60,.1);border:1px solid var(--error);border-radius:4px;color:var(--error);font-size:12px}
.summary-cta{padding:14px;text-align:center;color:var(--sub);font-size:13px}
.summary-cta button{margin-top:8px;padding:8px 20px;background:var(--link);color:var(--btn-fg);border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600}
.summary-cta button:hover{opacity:.9}
.summary-cta button:disabled{opacity:.4;cursor:not-allowed}
</style>
</head>
<body>
<div class="container">
  <div class="header" id="headerBlock">
    <div class="icon-fallback">…</div>
    <div class="info">
      <div class="title">加载中…</div>
    </div>
  </div>

  <div class="section summary" id="summarySection">
    <div class="section-head">
      <h2>💡 AI 总结：有什么用 · 收不收费 · 怎么用</h2>
      <div class="controls">
        <button id="regenSummaryBtn" style="display:none">重新生成</button>
      </div>
    </div>
    <div class="section-body" id="summaryBody">
      <div class="summary-cta">
        点击下方按钮，让 AI 用中文总结这个扩展的用途、收费和用法。<br>
        <button id="generateSummaryBtn">生成 AI 总结</button>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-head">
      <h2>📖 README</h2>
      <div class="controls" id="readmeControls">
        <button id="showZhBtn" class="active">中文翻译</button>
        <button id="showEnBtn">原文</button>
        <button id="retransBtn">重新翻译</button>
      </div>
    </div>
    <div class="section-body markdown" id="readmeBody">
      <div class="empty-state">加载中…</div>
    </div>
  </div>
</div>

<script nonce="${N}">
const vscode = acquireVsCodeApi();
const el = (id) => document.getElementById(id);
const headerBlock = el('headerBlock');
const summaryBody = el('summaryBody');
const generateSummaryBtn = el('generateSummaryBtn');
const regenSummaryBtn = el('regenSummaryBtn');
const readmeBody = el('readmeBody');
const showZhBtn = el('showZhBtn');
const showEnBtn = el('showEnBtn');
const retransBtn = el('retransBtn');

let state = {
  item: null,
  original: '',
  translated: '',
  summary: '',
  view: 'zh',
};

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtCount(n){
  if (!n) return '0';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return String(n);
}

function md(text){
  if (!text) return '';
  // 已是 HTML，直接信任
  if (/<(html|body|div|p|h[1-6]|table|pre|img|a|ul|ol)/i.test(text)) return text;
  let h = text;
  h = h.replace(/\\r\\n/g, '\\n');
  // fenced code
  h = h.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) =>
    '<pre><code>' + esc(code) + '</code></pre>'
  );
  // images
  h = h.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, (_, alt, url) =>
    '<img src="' + esc(url) + '" alt="' + esc(alt) + '">'
  );
  // links
  h = h.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, (_, txt, url) =>
    '<a href="' + esc(url) + '" target="_blank">' + esc(txt) + '</a>'
  );
  // inline code
  h = h.replace(/\`([^\`\\n]+)\`/g, (_, c) => '<code>' + esc(c) + '</code>');
  // bold / italic
  h = h.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
  // headings
  h = h.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  h = h.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  h = h.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // hr
  h = h.replace(/^---+$/gm, '<hr>');
  // blockquote
  h = h.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  // lists
  h = h.replace(/^[*\\-] (.+)$/gm, '<li>$1</li>');
  h = h.replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>');
  h = h.replace(/((?:<li>[\\s\\S]*?<\\/li>\\s*)+)/g, '<ul>$1</ul>');
  // tables
  h = h.replace(/^\\|(.+)\\|$/gm, (line) => {
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length && /^[-: ]+$/.test(cells[0])) return '';
    return '<tr>' + cells.map(c => '<td>' + c + '</td>').join('') + '</tr>';
  });
  h = h.replace(/((?:<tr>.*?<\\/tr>\\s*)+)/g, '<table>$1</table>');
  // paragraphs
  const segs = h.split(/\\n{2,}/);
  return segs.map(s => {
    const t = s.trim();
    if (!t) return '';
    if (/^<(h[1-6]|ul|ol|li|table|tr|td|pre|blockquote|hr|p|div|img)/i.test(t)) return t;
    return '<p>' + t.replace(/\\n/g, '<br>') + '</p>';
  }).join('\\n');
}

function renderHeader(item){
  if (!item) return;
  const badge = item.pricingStatus === 'paid'
    ? '<span class="badge paid">付费</span>'
    : item.pricingStatus === 'maybePaid'
      ? '<span class="badge maybe">可能付费</span>'
      : '<span class="badge free">免费</span>';
  const iconHtml = item.iconUrl
    ? '<img class="icon" src="' + esc(item.iconUrl) + '" alt="">'
    : '<div class="icon-fallback">' + esc((item.displayName || '?').slice(0,1).toUpperCase()) + '</div>';
  const desc = item.description ? '<div class="desc">' + esc(item.description) + '</div>' : '';
  const repo = item.repositoryUrl
    ? '<a href="' + esc(item.repositoryUrl) + '" target="_blank">代码仓库</a>'
    : '';
  const license = item.licenseUrl
    ? '<a href="' + esc(item.licenseUrl) + '" target="_blank">许可证</a>'
    : '';
  headerBlock.innerHTML =
    iconHtml
    + '<div class="info">'
    + '<div class="title">' + esc(item.displayName) + '</div>'
    + '<div class="publisher">' + esc(item.publisherDisplayName || item.publisher) + ' · v' + esc(item.version) + ' · ' + esc(item.id) + '</div>'
    + desc
    + '<div class="meta">'
      + badge
      + '<span>⬇ ' + fmtCount(item.installCount) + ' 次安装</span>'
      + (item.ratingScore ? '<span>★ ' + item.ratingScore.toFixed(1) + '（' + fmtCount(item.ratingCount) + '）</span>' : '')
      + (item.lastUpdated ? '<span>更新于 ' + new Date(item.lastUpdated).toLocaleDateString('zh-CN') + '</span>' : '')
    + '</div>'
    + '<div class="actions">'
      + '<button class="primary" id="installBtn">在 VS Code 中安装</button>'
      + '<button id="openMarketBtn">打开市场页 ↗</button>'
      + (repo ? '<a href="' + esc(item.repositoryUrl) + '" target="_blank">代码仓库 ↗</a>' : '')
      + (license ? '<a href="' + esc(item.licenseUrl) + '" target="_blank">许可证 ↗</a>' : '')
    + '</div>'
    + '</div>';
  const installBtn = el('installBtn');
  if (installBtn) installBtn.addEventListener('click', () => vscode.postMessage({type:'install'}));
  const openMarketBtn = el('openMarketBtn');
  if (openMarketBtn) openMarketBtn.addEventListener('click', () => vscode.postMessage({type:'openMarketplace'}));
}

function renderReadme(){
  if (state.view === 'zh'){
    if (state.translated){
      readmeBody.innerHTML = md(state.translated);
    } else if (state.original){
      readmeBody.innerHTML = '<div class="empty-state">尚未翻译。点击「重新翻译」可手动触发。</div>';
    } else {
      readmeBody.innerHTML = '<div class="empty-state">未找到 README 内容</div>';
    }
  } else {
    if (state.original){
      readmeBody.innerHTML = md(state.original);
    } else {
      readmeBody.innerHTML = '<div class="empty-state">未找到 README 内容</div>';
    }
  }
}

function setViewMode(mode){
  state.view = mode;
  showZhBtn.classList.toggle('active', mode === 'zh');
  showEnBtn.classList.toggle('active', mode === 'en');
  renderReadme();
}
showZhBtn.addEventListener('click', () => setViewMode('zh'));
showEnBtn.addEventListener('click', () => setViewMode('en'));
retransBtn.addEventListener('click', () => {
  retransBtn.disabled = true;
  retransBtn.textContent = '翻译中…';
  vscode.postMessage({type:'requestTranslate'});
});

generateSummaryBtn.addEventListener('click', () => {
  generateSummaryBtn.disabled = true;
  generateSummaryBtn.textContent = '生成中…';
  vscode.postMessage({type:'requestSummary'});
});
regenSummaryBtn.addEventListener('click', () => {
  regenSummaryBtn.disabled = true;
  regenSummaryBtn.textContent = '生成中…';
  state.summary = '';
  vscode.postMessage({type:'requestSummary'});
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type){
    case 'item':
      state.item = msg.item;
      renderHeader(msg.item);
      if (msg.openSummary){
        summaryBody.innerHTML = '<div class="loading-state"><span class="spinner"></span>生成 AI 总结中…</div>';
      }
      break;
    case 'readmeLoading':
      readmeBody.innerHTML = '<div class="loading-state"><span class="spinner"></span>加载 README 中…</div>';
      break;
    case 'readmeLoaded':
      state.original = msg.original || '';
      state.translated = msg.translated || '';
      retransBtn.disabled = false;
      retransBtn.textContent = '重新翻译';
      renderReadme();
      break;
    case 'translating':
      retransBtn.disabled = true;
      retransBtn.textContent = '翻译中…';
      if (state.view === 'zh' && !state.translated){
        readmeBody.innerHTML = '<div class="loading-state"><span class="spinner"></span>正在翻译为中文…</div>';
      }
      break;
    case 'translateError':
      retransBtn.disabled = false;
      retransBtn.textContent = '重新翻译';
      readmeBody.innerHTML = '<div class="error-state">翻译失败：' + esc(msg.message) + '</div>';
      break;
    case 'summarizing':
      summaryBody.innerHTML = '<div class="loading-state"><span class="spinner"></span>AI 总结生成中…</div>';
      break;
    case 'summaryDone':
      state.summary = msg.summary || '';
      generateSummaryBtn.disabled = false;
      generateSummaryBtn.textContent = '生成 AI 总结';
      regenSummaryBtn.style.display = 'inline-block';
      regenSummaryBtn.disabled = false;
      regenSummaryBtn.textContent = '重新生成';
      summaryBody.innerHTML = '<div class="section-body markdown">' + md(state.summary) + '</div>';
      break;
    case 'summaryError':
      generateSummaryBtn.disabled = false;
      generateSummaryBtn.textContent = '生成 AI 总结';
      regenSummaryBtn.disabled = false;
      regenSummaryBtn.textContent = '重新生成';
      summaryBody.innerHTML = '<div class="error-state">' + esc(msg.message) + '</div>';
      break;
    case 'readmeError':
      readmeBody.innerHTML = '<div class="error-state">加载 README 失败：' + esc(msg.message) + '</div>';
      break;
    case 'error':
      summaryBody.innerHTML = '<div class="error-state">' + esc(msg.message) + '</div>';
      break;
  }
});

vscode.postMessage({type:'ready'});
</script>
</body>
</html>`;
  }
}

/** 简单 HTML → 纯文本（用于翻译/总结源材料） */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|tr|div|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 64; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
