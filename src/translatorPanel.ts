import * as vscode from 'vscode';
import { Translator } from './translator';
import { icon } from './icons';
import { APPLE_CSS } from './theme';

/**
 * 独立翻译面板（在主编辑区 webview panel）
 * - 输入框：粘贴英文原文
 * - 输出框：显示中文翻译
 * - AI 总结按钮：对输入内容进行总结
 */
export class TranslatorPanel {
  public static readonly viewType = 'chineseEyes.translator';
  private static currentPanel: TranslatorPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _translator: Translator;
  private _disposables: vscode.Disposable[] = [];

  public static show(extensionUri: vscode.Uri, translator: Translator): TranslatorPanel {
    if (TranslatorPanel.currentPanel) {
      TranslatorPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      return TranslatorPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      TranslatorPanel.viewType,
      '翻译助手',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    const inst = new TranslatorPanel(panel, extensionUri, translator);
    TranslatorPanel.currentPanel = inst;
    return inst;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    translator: Translator
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._translator = translator;

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
    TranslatorPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    try {
      switch (msg.type) {
        case 'translate': {
          const text = (msg.text || '').trim();
          if (!text) {
            this.post({ type: 'translateError', message: '请输入要翻译的内容' });
            return;
          }
          this.post({ type: 'translating' });
          try {
            const res = await this._translator.translateSmart(text, this.getProxyUrl());
            this.post({
              type: 'translateDone',
              translated: res.text,
              warning: res.warning,
              source: res.source,
            });
          } catch (err: any) {
            this.post({ type: 'translateError', message: err.message || String(err) });
          }
          break;
        }

        case 'summarize': {
          const text = (msg.text || '').trim();
          if (!text) {
            this.post({ type: 'summarizeError', message: '请输入要总结的内容' });
            return;
          }
          if (!this._translator.canSummarize()) {
            this.post({
              type: 'summarizeError',
              message: '需要配置 DeepSeek 或 OpenAI 兼容 API Key 才能使用 AI 总结。',
            });
            return;
          }
          this.post({ type: 'summarizing' });
          try {
            const summaryZh = await this._translator.summarize(text);
            this.post({ type: 'summarizeDone', summary: summaryZh });
          } catch (err: any) {
            this.post({ type: 'summarizeError', message: err.message || String(err) });
          }
          break;
        }

        case 'openSettings':
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            '@ext:honor-world.ext-trans-picker'
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

  /** 优先使用 chineseEyes.proxyUrl，其次 VS Code 内置 http.proxy 设置 */
  private getProxyUrl(): string {
    const ch = vscode.workspace.getConfiguration('chineseEyes');
    const explicit = (ch.get('proxyUrl') as string) || '';
    if (explicit) return explicit;
    const httpCfg = vscode.workspace.getConfiguration('http');
    return (httpCfg.get('proxy') as string) || '';
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
/* ===== 翻译面板布局 ===== */
body{font-size:14px;line-height:1.6}
.container{max-width:960px;margin:0 auto;padding:28px 24px}
.page-head{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.page-head .title{font-size:20px;font-weight:700;letter-spacing:-.02em}
.page-head .settings{margin-left:auto;font-size:12px;cursor:pointer;color:var(--accent);display:inline-flex;align-items:center;gap:5px;background:transparent;border:none;font-family:inherit}
.page-head .settings:hover{opacity:.8}
.panels{display:flex;gap:16px;margin-bottom:16px}
.panel{flex:1;display:flex;flex-direction:column;padding:16px}
.panel-label{font-size:12px;font-weight:600;margin-bottom:10px;color:var(--text-sub);display:flex;align-items:center;gap:6px}
.panel textarea{flex:1;min-height:280px;padding:14px;border:1px solid var(--line);border-radius:var(--radius-m);background:var(--input);color:var(--text);font-size:13px;line-height:1.65;resize:vertical;outline:none;font-family:var(--vscode-editor-font-family,monospace)}
.panel textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.panel .output-area{flex:1;min-height:280px;padding:14px;border:1px solid var(--line);border-radius:var(--radius-m);background:var(--card);color:var(--text);font-size:13px;line-height:1.65;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
.panel .output-area .source-note{display:block;margin-top:8px;font-size:11px;color:var(--text-weak)}
.output-area .empty{color:var(--text-weak);font-style:italic}
.actions{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.summary-section{margin-top:18px}
.summary-section h2{font-size:15px;font-weight:700;margin-bottom:10px;display:flex;align-items:center;gap:7px}
.summary-body{padding:16px;min-height:60px;font-size:13px;line-height:1.75;white-space:pre-wrap;word-break:break-word}
.summary-body:empty::after{content:'点击「AI 总结」按钮生成总结';color:var(--text-weak);font-style:italic}
.loading-state{display:flex;align-items:center;justify-content:center;gap:8px;padding:16px;color:var(--text-weak)}
.error-state{padding:10px 14px;background:rgba(255,59,48,.1);border:1px solid rgba(255,59,48,.35);border-radius:var(--radius-m);color:#ff453a;font-size:12px;margin-top:8px}
.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);padding:7px 18px;border-radius:var(--radius-pill);font-size:12px;z-index:99;display:none;box-shadow:var(--shadow-pop);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.toast.success{background:rgba(52,199,89,.92);color:#fff}
.toast.error{background:rgba(255,59,48,.92);color:#fff}
.toast.info{background:rgba(0,122,255,.92);color:#fff}
@media(max-width:600px){.panels{flex-direction:column}}
</style>
</head>
<body>
<div class="container">
  <div class="page-head">
    ${icon('globe', 22)}<span class="title">翻译助手</span>
    <button class="settings" id="openSettingsBtn">${icon('settings', 13)} 设置</button>
  </div>

  <div class="actions">
    <button class="ap-btn ap-btn-primary" id="translateBtn">${icon('swap')} 翻译</button>
    <button class="ap-btn" id="summarizeBtn">${icon('sparkle')} AI 总结</button>
    <button class="ap-btn" id="clearBtn">${icon('trash')} 清空</button>
  </div>

  <div class="panels">
    <div class="panel ap-card">
      <div class="panel-label">${icon('clipboard', 13)} 输入（英文/其他语言）</div>
      <textarea id="inputArea" placeholder="在此粘贴要翻译的英文内容..."></textarea>
    </div>
    <div class="panel ap-card">
      <div class="panel-label">${icon('upload', 13)} 输出（中文翻译）</div>
      <div class="output-area" id="outputArea">
        <span class="empty">翻译结果将显示在这里</span>
      </div>
      <div class="ap-note" id="warnNote" style="display:none"></div>
    </div>
  </div>

  <div class="summary-section">
    <h2>${icon('sparkle')} AI 总结</h2>
    <div class="summary-body ap-card" id="summaryBody"></div>
  </div>

  <div class="toast" id="toast"></div>
</div>

<script nonce="${N}">
const vscode = acquireVsCodeApi();
const el = (id) => document.getElementById(id);
// 与扩展侧 icons.ts 一致的简洁线性图标
const ICON_SWAP = '<svg class="ico" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5h11M10.75 4.75 13.5 7.5l-2.75 2.75"/><path d="M13.5 8.5h-11M5.25 11.25 2.5 8.5l2.75-2.75"/></svg>';
const ICON_SPARKLE = '<svg class="ico" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.25 9.55 6.45 13.75 8 9.55 9.55 8 13.75 6.45 9.55 2.25 8 6.45 6.45 8 2.25z"/></svg>';
const ICON_WARNING = '<svg class="ico" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.25 14.5 13.5h-13z"/><path d="M8 6.5v3.25"/><path d="M8 11.75h.01"/></svg>';
const inputArea = el('inputArea');
const outputArea = el('outputArea');
const summaryBody = el('summaryBody');
const warnNote = el('warnNote');
const translateBtn = el('translateBtn');
const summarizeBtn = el('summarizeBtn');
const clearBtn = el('clearBtn');
const openSettingsBtn = el('openSettingsBtn');
const toast = el('toast');

// 回车翻译
inputArea.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    doTranslate();
  }
});

translateBtn.addEventListener('click', doTranslate);
summarizeBtn.addEventListener('click', doSummarize);
clearBtn.addEventListener('click', () => {
  inputArea.value = '';
  outputArea.innerHTML = '<span class="empty">翻译结果将显示在这里</span>';
  summaryBody.innerHTML = '';
  warnNote.style.display = 'none';
  warnNote.innerHTML = '';
});
openSettingsBtn.addEventListener('click', () => vscode.postMessage({type:'openSettings'}));

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#39;');
}

function showToast(msg, type){
  toast.textContent = msg;
  toast.className = 'toast ' + (type || 'info');
  toast.style.display = 'block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

function doTranslate(){
  const text = inputArea.value.trim();
  if (!text) { showToast('请先在输入框中粘贴英文内容', 'error'); return; }
  translateBtn.disabled = true;
  translateBtn.innerHTML = ICON_SWAP + ' 翻译中…';
  outputArea.innerHTML = '<div class="loading-state"><span class="ap-spinner"></span>翻译中…</div>';
  vscode.postMessage({type:'translate', text});
}

function doSummarize(){
  const text = inputArea.value.trim();
  if (!text) { showToast('请先在输入框中粘贴需要总结的内容', 'error'); return; }
  summarizeBtn.disabled = true;
  summarizeBtn.innerHTML = ICON_SPARKLE + ' 生成中…';
  summaryBody.innerHTML = '<div class="loading-state"><span class="ap-spinner"></span>AI 总结生成中…</div>';
  vscode.postMessage({type:'summarize', text});
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type){
    case 'translating':
      outputArea.innerHTML = '<div class="loading-state"><span class="ap-spinner"></span>翻译中…</div>';
      warnNote.style.display = 'none';
      break;
    case 'translateDone':
      translateBtn.disabled = false;
      translateBtn.innerHTML = ICON_SWAP + ' 翻译';
      outputArea.innerHTML = esc(msg.translated).replace(/\\n/g, '<br>');
      if (msg.warning) {
        warnNote.innerHTML = ICON_WARNING + '<span>' + esc(msg.warning) + '</span>';
        warnNote.style.display = 'flex';
      } else if (msg.source === 'free-online') {
        outputArea.innerHTML += '<span class="source-note">（由免费在线翻译提供，配置 API Key 可获得更准确的翻译）</span>';
      }
      showToast('翻译完成', 'success');
      break;
    case 'translateError':
      translateBtn.disabled = false;
      translateBtn.innerHTML = ICON_SWAP + ' 翻译';
      outputArea.innerHTML = '<div class="error-state">' + esc(msg.message) + '</div>';
      break;
    case 'summarizing':
      summaryBody.innerHTML = '<div class="loading-state"><span class="ap-spinner"></span>AI 总结生成中…</div>';
      break;
    case 'summarizeDone':
      summarizeBtn.disabled = false;
      summarizeBtn.innerHTML = ICON_SPARKLE + ' AI 总结';
      summaryBody.innerHTML = esc(msg.summary).replace(/\\n/g, '<br>');
      showToast('总结生成完成', 'success');
      break;
    case 'summarizeError':
      summarizeBtn.disabled = false;
      summarizeBtn.innerHTML = ICON_SPARKLE + ' AI 总结';
      summaryBody.innerHTML = '<div class="error-state">' + esc(msg.message) + '</div>';
      break;
    case 'error':
      showToast(msg.message, 'error');
      break;
  }
});
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