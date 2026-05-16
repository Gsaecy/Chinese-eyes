import * as vscode from 'vscode';
import { Translator } from './translator';

export class ExtensionBrowserViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'chineseEyes.marketplace';

  private _view?: vscode.WebviewView;
  private _panel?: vscode.WebviewPanel;
  private _translator: Translator;
  private _context: vscode.ExtensionContext;
  private _lastOriginalText = '';

  constructor(private readonly _extensionUri: vscode.Uri, translator: Translator, context: vscode.ExtensionContext) {
    this._translator = translator;
    this._context = context;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
    webviewView.webview.html = this.buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((m) => this.handleMessage(m));
  }

  async handleMessage(msg: any): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          const config = vscode.workspace.getConfiguration('chineseEyes');
          const currentProvider = config.get('translationProvider', 'local');
          const savedApiKey = config.get('apiKey', '') || this._context.globalState.get('apiKey', '');
          const hasApiKey = !!savedApiKey;
          if (savedApiKey) {
            this._translator.updateConfig({
              provider: currentProvider,
              apiKey: savedApiKey,
              targetLanguage: 'zh-CN',
              customEndpoint: config.get('apiEndpoint', ''),
              customModel: config.get('apiModel', ''),
            });
          }
          this.postMessage({ type: 'init', provider: currentProvider, hasApiKey });
          break;

        case 'translate':
          this._lastOriginalText = msg.text;
          await this.translateText(msg.text);
          break;

        case 'summarize':
          await this.summarizeText(this._lastOriginalText);
          break;

        case 'saveApiKey':
          try {
            const chConfig = vscode.workspace.getConfiguration('chineseEyes');
            await chConfig.update('apiKey', msg.apiKey, vscode.ConfigurationTarget.Global);
            await chConfig.update('translationProvider', 'deepseek', vscode.ConfigurationTarget.Global);
            this._translator.updateConfig({
              provider: 'deepseek',
              apiKey: msg.apiKey,
              targetLanguage: 'zh-CN',
              customEndpoint: '',
              customModel: '',
            });
            this.postMessage({ type: 'apiKeySaved', success: true, provider: 'deepseek' });
          } catch (err: any) {
            this.postMessage({ type: 'error', message: '保存 API Key 失败: ' + err.message });
          }
          break;

        case 'setProvider':
          try {
            await vscode.workspace.getConfiguration('chineseEyes').update('translationProvider', msg.provider, vscode.ConfigurationTarget.Global);
            this._translator.updateConfig({
              provider: msg.provider,
              targetLanguage: 'zh-CN',
            });
            this.postMessage({ type: 'providerSet', provider: msg.provider });
          } catch (err: any) {
            this.postMessage({ type: 'error', message: '设置翻译源失败: ' + err.message });
          }
          break;

        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ext-trans-picker');
          break;
      }
    } catch (err: any) {
      console.error('[ext-trans-picker] handleMessage 异常:', err);
      this.postMessage({ type: 'error', message: err.message });
    }
  }

  private async translateText(text: string): Promise<void> {
    if (!text || !text.trim()) {
      this.postMessage({ type: 'translated', original: '', translated: '请输入要翻译的文本' });
      return;
    }
    this.postMessage({ type: 'translating' });
    try {
      const result = await this._translator.translate(text);
      this.postMessage({ type: 'translated', original: text, translated: result });
    } catch (err: any) {
      this.postMessage({ type: 'error', message: '翻译失败: ' + err.message });
    }
  }

  private async summarizeText(text: string): Promise<void> {
    if (!text || !text.trim()) {
      this.postMessage({ type: 'summarized', summary: '没有可总结的内容' });
      return;
    }

    const config = vscode.workspace.getConfiguration('chineseEyes');
    const provider: string = config.get('translationProvider', 'local');

    if (provider !== 'deepseek') {
      const apiKey = config.get('apiKey', '') || this._context.globalState.get('apiKey', '');
      if (apiKey) {
        this._translator.updateConfig({
          provider: 'deepseek',
          apiKey,
          targetLanguage: 'zh-CN',
          customEndpoint: config.get('apiEndpoint', ''),
          customModel: config.get('apiModel', ''),
        });
      }
    }

    this.postMessage({ type: 'summarizing' });

    try {
      if (provider !== 'deepseek' && !config.get('apiKey', '')) {
        const simpleSummary = this.simpleSummary(text);
        this.postMessage({ type: 'summarized', summary: simpleSummary });
        return;
      }

      const summary = await this._translator.translate(
        this.buildSummarizePrompt(text)
      );
      this.postMessage({ type: 'summarized', summary });
    } catch (err: any) {
      const simpleSummary = this.simpleSummary(text);
      const note = '\n\n[注意] 如需更精准总结，请配置 DeepSeek API Key';
      this.postMessage({ type: 'summarized', summary: simpleSummary + note });
    }
  }

  private buildSummarizePrompt(text: string): string {
    return [
      '请用中文对以下英文内容进行总结（面向不懂英语的普通用户），包含三部分：',
      '',
      '1. **有什么用**：这个扩展/工具的主要功能是什么，用大白话说清楚',
      '2. **收不收费**：明确告诉用户是否需要付费，多少钱，有什么限制',
      '3. **怎么用**：安装后如何使用，简单几步说明',
      '',
      '注意：',
      '- 用通俗易懂的中文，不要用专业术语',
      '- 每部分用标题 + 内容格式',
      '- 如果原文提到价格、订阅、免费试用等，一定要重点说明',
      '- 如果原文没有提到收费，就写"未明确说明收费情况"',
      '',
      '原文内容：',
      '---',
      text.substring(0, 8000),
      '---',
    ].join('\n');
  }

  private simpleSummary(text: string): string {
    const lower = text.toLowerCase();
    const parts: string[] = [];

    const firstLine = text.split(/[.\n]/).filter(s => s.trim().length > 10).slice(0, 3).join('. ');
    parts.push('**有什么用**\n' + firstLine.substring(0, 300));

    const paidKeywords = ['paid', 'pricing', 'subscription', 'free', 'trial', 'premium', 'pro', 'enterprise', '$', 'price', 'buy', 'purchase', 'monthly', 'annual', 'license', 'billing'];
    const foundPaid = paidKeywords.filter(k => lower.includes(k));
    if (foundPaid.length > 0) {
      parts.push('**收费信息**\n原文提到了收费相关关键词（' + foundPaid.join('、') + '），建议进一步查看详情确认费用。');
    } else {
      parts.push('**收费信息**\n未检测到明确的收费关键词，可能是免费工具。建议进一步查看详情确认。');
    }

    const installMatches = text.match(/install|setup|usage|getting started/i);
    if (installMatches) {
      parts.push('**怎么用**\n安装后即可使用，具体用法请参考扩展的 README 说明。');
    } else {
      parts.push('**怎么用**\n安装扩展后，通常可在 VS Code 命令面板（Ctrl+Shift+P）中搜索扩展名来使用。');
    }

    return parts.join('\n\n---\n\n');
  }

  public postMessage(msg: any): void {
    this._view?.webview.postMessage(msg);
    this._panel?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const N = getNonce();
    const W = webview.cspSource;
    return '<!DOCTYPE html>' +
      '<html lang="zh-CN">' +
      '<head>' +
      '<meta charset="UTF-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src ' + "'none'" + '; style-src ' + "'unsafe-inline' " + W + '; script-src ' + "'nonce-" + N + "'" + ';">' +
      '<style nonce="' + N + '">' +
      ':root{' +
      '--fg:var(--vscode-editor-foreground);' +
      '--bg:var(--vscode-editor-background);' +
      '--card:var(--vscode-sideBar-background);' +
      '--border:var(--vscode-widget-border);' +
      '--btn:var(--vscode-button-background);' +
      '--btn-fg:var(--vscode-button-foreground);' +
      '--sub:var(--vscode-descriptionForeground);' +
      '--link:var(--vscode-textLink-foreground);' +
      '--input-bg:var(--vscode-input-background);' +
      '--input-fg:var(--vscode-input-foreground);' +
      '--input-border:var(--vscode-input-border);' +
      '--success:#1ea55b;--warning:#c9a93c;--error:#c95c3c;' +
      '}' +
      '*{box-sizing:border-box;margin:0;padding:0}' +
      'body{font-family:var(--vscode-font-family);font-size:13px;color:var(--fg);background:var(--bg);padding:12px}' +
      'h2{font-size:15px;font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:6px}' +
      '.subtitle{font-size:11px;color:var(--sub);margin-bottom:12px}' +
      '.capability-notice{padding:8px 10px;border-radius:6px;font-size:11px;line-height:1.6;margin-bottom:10px;display:none}' +
      '.capability-notice.warning{display:block;background:rgba(201,169,60,.12);border:1px solid var(--warning);color:var(--warning)}' +
      '.capability-notice.info{display:block;background:rgba(30,165,91,.1);border:1px solid var(--success);color:var(--success)}' +
      '.provider-row{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}' +
      '.provider-btn{padding:4px 10px;border-radius:12px;font-size:11px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--sub);transition:all .15s;user-select:none}' +
      '.provider-btn:hover{border-color:var(--btn);color:var(--btn)}' +
      '.provider-btn.active{background:var(--btn);color:var(--btn-fg);border-color:var(--btn)}' +
      '.input-area{position:relative;margin-bottom:10px}' +
      '.input-area textarea{width:100%;height:100px;padding:10px;border:1px solid var(--input-border);border-radius:6px;background:var(--input-bg);color:var(--input-fg);resize:vertical;font-size:13px;font-family:var(--vscode-font-family);outline:none}' +
      '.input-area textarea:focus{border-color:var(--btn)}' +
      '.input-area .char-count{position:absolute;bottom:6px;right:10px;font-size:10px;color:var(--sub)}' +
      '.btn-row{display:flex;gap:6px;margin-bottom:12px}' +
      '.btn-row button{flex:1;padding:7px 0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;border:none;transition:opacity .15s}' +
      '.btn-row button:disabled{opacity:.4;cursor:not-allowed}' +
      '.btn-translate{background:var(--btn);color:var(--btn-fg)}' +
      '.btn-translate:hover:not(:disabled){opacity:.9}' +
      '.btn-clear{background:transparent;color:var(--sub);border:1px solid var(--border)}' +
      '.btn-clear:hover{background:var(--btn);color:var(--btn-fg);border-color:var(--btn)}' +
      '.btn-settings{flex:0;padding:7px 10px;background:transparent;color:var(--sub);border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:16px}' +
      '.result-section{display:none;margin-bottom:12px}' +
      '.result-section .section-label{font-size:11px;color:var(--sub);margin-bottom:4px;font-weight:600}' +
      '.result-box{padding:10px;background:var(--card);border:1px solid var(--border);border-radius:6px;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;margin-bottom:8px}' +
      '.result-box .translated-text{color:var(--fg)}' +
      '.summary-row{display:none;gap:6px;margin-bottom:12px}' +
      '.summary-row button{flex:1;padding:7px 0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;border:none;transition:opacity .15s}' +
      '.summary-row button:disabled{opacity:.4;cursor:not-allowed}' +
      '.btn-summarize{background:var(--link);color:var(--btn-fg)}' +
      '.btn-summarize:hover:not(:disabled){opacity:.9}' +
      '.summary-section{display:none;margin-bottom:12px}' +
      '.summary-section .section-label{font-size:11px;color:var(--sub);margin-bottom:4px;font-weight:600}' +
      '.summary-box{padding:12px;background:var(--card);border:1px solid var(--success);border-radius:6px;font-size:13px;line-height:1.8;white-space:pre-wrap;word-break:break-word;color:var(--fg)}' +
      '.summary-box strong{color:var(--btn)}' +
      '.settings-area{margin-top:16px;padding:12px;background:var(--card);border:1px solid var(--border);border-radius:8px}' +
      '.settings-area h3{font-size:12px;font-weight:700;margin-bottom:8px;color:var(--sub);display:flex;justify-content:space-between;align-items:center}' +
      '.settings-area h3 .toggle{font-size:11px;color:var(--link);cursor:pointer;font-weight:400}' +
      '.settings-area h3 .toggle:hover{text-decoration:underline}' +
      '.settings-row{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}' +
      '.settings-row label{font-size:11px;color:var(--sub)}' +
      '.settings-row input{padding:6px 8px;border:1px solid var(--input-border);border-radius:4px;background:var(--input-bg);color:var(--input-fg);font-size:12px;outline:none}' +
      '.settings-row input:focus{border-color:var(--btn)}' +
      '.settings-row input::placeholder{color:var(--sub);opacity:.5}' +
      '.settings-actions{display:flex;gap:6px;margin-top:4px}' +
      '.settings-actions button{padding:5px 12px;border-radius:4px;cursor:pointer;font-size:12px;border:none;font-weight:600}' +
      '.btn-save{background:var(--btn);color:var(--btn-fg)}' +
      '.btn-save:hover{opacity:.9}' +
      '.btn-save:disabled{opacity:.4;cursor:not-allowed}' +
      '.settings-hint{font-size:10px;color:var(--sub);margin-top:4px;line-height:1.5}' +
      '.status-bar{margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--sub)}' +
      '.status-bar .status-item{display:flex;align-items:center;gap:3px}' +
      '.status-dot{width:6px;height:6px;border-radius:50%;display:inline-block}' +
      '.status-dot.green{background:var(--success)}' +
      '.status-dot.yellow{background:var(--warning)}' +
      '.status-dot.red{background:var(--error)}' +
      '.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);padding:6px 16px;border-radius:16px;font-size:12px;z-index:999;pointer-events:none;animation:toastIn .3s ease;display:none}' +
      '.toast.success{background:var(--success);color:#fff}' +
      '.toast.error{background:var(--error);color:#fff}' +
      '.toast.info{background:var(--btn);color:var(--btn-fg)}' +
      '@keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}' +
      '</style>' +
      '</head>' +
      '<body>' +
      '<div id="app">' +
      '<h2>扩展选择助手</h2>' +
      '<div class="subtitle">粘贴外文 → 自动翻译 → AI 总结</div>' +
      '<div class="capability-notice" id="capabilityNotice"></div>' +
      '<div class="provider-row">' +
      '<span class="provider-btn active" data-provider="local">本地词典</span>' +
      '<span class="provider-btn" data-provider="deepseek">DeepSeek</span>' +
      '<span class="provider-btn" data-provider="deepl">DeepL</span>' +
      '<span class="provider-btn" data-provider="google">Google</span>' +
      '<span class="provider-btn" data-provider="libretranslate">Libre</span>' +
      '</div>' +
      '<div class="input-area">' +
      '<textarea id="inputText" placeholder="在此粘贴要翻译的文本(扩展描述、README 等)..."></textarea>' +
      '<span class="char-count" id="charCount">0 字符</span>' +
      '</div>' +
      '<div class="btn-row">' +
      '<button class="btn-translate" id="translateBtn">翻译</button>' +
      '<button class="btn-clear" id="clearBtn">清空</button>' +
      '<button class="btn-settings" id="toggleSettings">设置</button>' +
      '</div>' +
      '<div class="result-section" id="resultSection">' +
      '<div class="section-label">翻译结果</div>' +
      '<div class="result-box"><div class="translated-text" id="resultTranslated"></div></div>' +
      '</div>' +
      '<div class="summary-row" id="summaryRow">' +
      '<button class="btn-summarize" id="summarizeBtn">AI 总结: 有什么用 - 收不收费 - 怎么用</button>' +
      '</div>' +
      '<div class="summary-section" id="summarySection">' +
      '<div class="section-label">AI 总结</div>' +
      '<div class="summary-box" id="summaryContent"></div>' +
      '</div>' +
      '<div class="settings-area" id="settingsArea" style="display:none">' +
      '<h3>翻译设置<span class="toggle" id="hideSettings">收起</span></h3>' +
      '<div class="settings-row">' +
      '<label>API Key(DeepSeek 推荐，总结功能需要)</label>' +
      '<input type="password" id="apiKeyInput" placeholder="输入你的 API Key...">' +
      '</div>' +
      '<div class="settings-row">' +
      '<label>自定义端点(可选)</label>' +
      '<input type="text" id="endpointInput" placeholder="如 https://api.deepseek.com">' +
      '</div>' +
      '<div class="settings-row">' +
      '<label>模型名称(DeepSeek 可选，默认 deepseek-chat)</label>' +
      '<input type="text" id="modelInput" placeholder="deepseek-chat">' +
      '</div>' +
      '<div class="settings-actions">' +
      '<button class="btn-save" id="saveSettingsBtn">保存</button>' +
      '</div>' +
      '<div class="settings-hint">' +
      '⚠️ DeepSeek = 翻译 + AI 总结 都可用<br>' +
      '⚠️ DeepL / Google / LibreTranslate = 仅翻译，不能 AI 总结<br>' +
      '⚠️ 本地词典 = 仅基础翻译，不需要 API Key' +
      '</div>' +
      '</div>' +
      '<div class="status-bar">' +
      '<span class="status-item"><span class="status-dot green" id="translateDot"></span> 翻译: <span id="translateStatus">就绪</span></span>' +
      '<span class="status-item"><span class="status-dot yellow" id="summaryDot"></span> 总结: <span id="summaryStatus">需 DeepSeek</span></span>' +
      '<span class="status-item">翻译源: <span id="currentProvider">local</span></span>' +
      '</div>' +
      '<div class="toast" id="toast"></div>' +
      '</div>' +
      '<script nonce="' + N + '">' +
      'const vscode = acquireVsCodeApi();' +
      'const inputText = document.getElementById("inputText");' +
      'const translateBtn = document.getElementById("translateBtn");' +
      'const clearBtn = document.getElementById("clearBtn");' +
      'const resultSection = document.getElementById("resultSection");' +
      'const summaryRow = document.getElementById("summaryRow");' +
      'const summarySection = document.getElementById("summarySection");' +
      'const resultTranslated = document.getElementById("resultTranslated");' +
      'const summaryContent = document.getElementById("summaryContent");' +
      'const summarizeBtn = document.getElementById("summarizeBtn");' +
      'const charCount = document.getElementById("charCount");' +
      'const toggleSettings = document.getElementById("toggleSettings");' +
      'const hideSettings = document.getElementById("hideSettings");' +
      'const settingsArea = document.getElementById("settingsArea");' +
      'const apiKeyInput = document.getElementById("apiKeyInput");' +
      'const endpointInput = document.getElementById("endpointInput");' +
      'const modelInput = document.getElementById("modelInput");' +
      'const saveSettingsBtn = document.getElementById("saveSettingsBtn");' +
      'const currentProvider = document.getElementById("currentProvider");' +
      'const translateStatus = document.getElementById("translateStatus");' +
      'const summaryStatus = document.getElementById("summaryStatus");' +
      'const translateDot = document.getElementById("translateDot");' +
      'const summaryDot = document.getElementById("summaryDot");' +
      'const capabilityNotice = document.getElementById("capabilityNotice");' +
      'const toast = document.getElementById("toast");' +
      'const providerBtns = document.querySelectorAll(".provider-btn");' +
      'let currentProviderVal = "local";' +
      'let hasApiKey = false;' +
      'let lastTranslatedText = "";' +
      'function updateCapabilityUI(provider, hasKey){' +
      '  var canSummarize = (provider === "deepseek" && hasKey);' +
      '  var canTranslate = (provider === "local" || hasKey);' +
      '  if (provider === "local") {' +
      '    translateStatus.textContent = "就绪(本地)";' +
      '    translateDot.className = "status-dot green";' +
      '  } else if (hasKey) {' +
      '    translateStatus.textContent = "就绪";' +
      '    translateDot.className = "status-dot green";' +
      '  } else {' +
      '    translateStatus.textContent = "需配置 API";' +
      '    translateDot.className = "status-dot red";' +
      '  }' +
      '  if (canSummarize) {' +
      '    summaryStatus.textContent = "可用";' +
      '    summaryDot.className = "status-dot green";' +
      '    capabilityNotice.className = "capability-notice";' +
      '    capabilityNotice.style.display = "none";' +
      '  } else if (provider === "deepseek" && !hasKey) {' +
      '    summaryStatus.textContent = "需配置 API";' +
      '    summaryDot.className = "status-dot red";' +
      '    capabilityNotice.className = "capability-notice warning";' +
      '    capabilityNotice.innerHTML = "⚠️ 当前翻译源为 DeepSeek，但未配置 API Key。请在设置中填入 API Key 后方可使用翻译和 AI 总结功能。";' +
      '    capabilityNotice.style.display = "block";' +
      '  } else if (provider === "local") {' +
      '    summaryStatus.textContent = "不支持";' +
      '    summaryDot.className = "status-dot red";' +
      '    capabilityNotice.className = "capability-notice warning";' +
      '    capabilityNotice.innerHTML = "⚠️ 本地词典只能做基础翻译，不支持 AI 总结。如需 AI 总结功能，请切换到 DeepSeek 并配置 API Key。";' +
      '    capabilityNotice.style.display = "block";' +
      '  } else {' +
      '    summaryStatus.textContent = "需 DeepSeek";' +
      '    summaryDot.className = "status-dot yellow";' +
      '    capabilityNotice.className = "capability-notice warning";' +
      '    capabilityNotice.innerHTML = "⚠️ 当前使用的 \\"" + providerName(provider) + "\\" API 仅支持翻译，不支持 AI 总结。如需 AI 总结，请切换到 DeepSeek 翻译源。";' +
      '    capabilityNotice.style.display = "block";' +
      '  }' +
      '}' +
      'function providerName(p){' +
      '  var names = {local:"本地词典",deepseek:"DeepSeek",deepl:"DeepL",google:"Google",libretranslate:"LibreTranslate"};' +
      '  return names[p] || p;' +
      '}' +
      'providerBtns.forEach(function(btn){' +
      '  btn.addEventListener("click",function(){' +
      '    providerBtns.forEach(function(b){b.classList.remove("active")});' +
      '    btn.classList.add("active");' +
      '    currentProviderVal = btn.dataset.provider;' +
      '    currentProvider.textContent = currentProviderVal;' +
      '    updateCapabilityUI(currentProviderVal, hasApiKey);' +
      '    if (currentProviderVal !== "local" && !hasApiKey) {' +
      '      showToast("请在设置中配置 API Key","info");' +
      '      expandSettings();' +
      '    }' +
      '    vscode.postMessage({type:"setProvider",provider:currentProviderVal});' +
      '  });' +
      '});' +
      'function doTranslate(){' +
      '  var text = inputText.value.trim();' +
      '  if (!text) { showToast("请粘贴要翻译的文本","error"); return; }' +
      '  translateBtn.disabled = true;' +
      '  translateBtn.textContent = "翻译中...";' +
      '  summaryRow.style.display = "none";' +
      '  summarySection.style.display = "none";' +
      '  resultSection.style.display = "none";' +
      '  vscode.postMessage({type:"translate",text:text});' +
      '}' +
      'translateBtn.addEventListener("click",doTranslate);' +
      'inputText.addEventListener("keydown",function(e){if(e.key==="Enter"&&e.ctrlKey)doTranslate()});' +
      'inputText.addEventListener("input",function(){' +
      '  var len = inputText.value.length;' +
      '  charCount.textContent = len + " 字符";' +
      '  charCount.style.color = len > 5000 ? "var(--warning)" : "";' +
      '});' +
      'clearBtn.addEventListener("click",function(){' +
      '  inputText.value = "";' +
      '  charCount.textContent = "0 字符";' +
      '  resultSection.style.display = "none";' +
      '  summaryRow.style.display = "none";' +
      '  summarySection.style.display = "none";' +
      '  translateBtn.disabled = false;' +
      '  translateBtn.textContent = "翻译";' +
      '  lastTranslatedText = "";' +
      '});' +
      'toggleSettings.addEventListener("click",expandSettings);' +
      'hideSettings.addEventListener("click",function(){settingsArea.style.display="none"});' +
      'function expandSettings(){settingsArea.style.display="block"}' +
      'saveSettingsBtn.addEventListener("click",function(){' +
      '  var key = apiKeyInput.value.trim();' +
      '  if (!key) { showToast("请输入 API Key","error"); return; }' +
      '  saveSettingsBtn.disabled = true;' +
      '  saveSettingsBtn.textContent = "保存中...";' +
      '  vscode.postMessage({type:"saveApiKey",apiKey:key});' +
      '});' +
      'summarizeBtn.addEventListener("click",function(){' +
      '  if (!lastTranslatedText) { showToast("请先翻译文本","error"); return; }' +
      '  if (!(currentProviderVal === "deepseek" && hasApiKey)) {' +
      '    showToast("AI 总结需要 DeepSeek API。请在设置中配置 DeepSeek Key 或切换到 DeepSeek 翻译源","error");' +
      '    expandSettings();' +
      '    return;' +
      '  }' +
      '  summarySection.style.display = "none";' +
      '  summarizeBtn.disabled = true;' +
      '  summarizeBtn.textContent = "正在分析...";' +
      '  vscode.postMessage({type:"summarize"});' +
      '});' +
      'window.addEventListener("message",function(event){' +
      '  var msg = event.data;' +
      '  switch(msg.type){' +
      '    case "init":' +
      '      currentProviderVal = msg.provider || "local";' +
      '      currentProvider.textContent = currentProviderVal;' +
      '      hasApiKey = msg.hasApiKey;' +
      '      updateCapabilityUI(currentProviderVal, hasApiKey);' +
      '      providerBtns.forEach(function(b){b.classList.toggle("active",b.dataset.provider===currentProviderVal)});' +
      '      if (hasApiKey && currentProviderVal === "local") {' +
      '        showToast("已检测到 API Key，可切换到 DeepSeek 获得 AI 总结功能","info");' +
      '      }' +
      '      break;' +
      '    case "translated":' +
      '      translateBtn.disabled = false;' +
      '      translateBtn.textContent = "翻译";' +
      '      lastTranslatedText = msg.translated;' +
      '      resultSection.style.display = "block";' +
      '      resultTranslated.textContent = msg.translated;' +
      '      summaryRow.style.display = "block";' +
      '      summarySection.style.display = "none";' +
      '      summarizeBtn.disabled = false;' +
      '      summarizeBtn.textContent = "AI 总结: 有什么用 - 收不收费 - 怎么用";' +
      '      break;' +
      '    case "summarized":' +
      '      summarizeBtn.disabled = false;' +
      '      summarizeBtn.textContent = "AI 总结: 有什么用 - 收不收费 - 怎么用";' +
      '      summarySection.style.display = "block";' +
      '      summaryContent.textContent = msg.summary;' +
      '      break;' +
      '    case "apiKeySaved":' +
      '      saveSettingsBtn.disabled = false;' +
      '      saveSettingsBtn.textContent = "保存";' +
      '      if (msg.success) {' +
      '        hasApiKey = true;' +
      '        currentProviderVal = msg.provider || "deepseek";' +
      '        currentProvider.textContent = currentProviderVal;' +
      '        updateCapabilityUI(currentProviderVal, true);' +
      '        providerBtns.forEach(function(b){b.classList.toggle("active",b.dataset.provider===currentProviderVal)});' +
      '        showToast("设置已保存，已切换到 DeepSeek，翻译和 AI 总结均可使用","success");' +
      '      }' +
      '      break;' +
      '    case "providerSet":' +
      '      showToast("已切换到 " + providerName(msg.provider),"success");' +
      '      break;' +
      '    case "error":' +
      '      translateBtn.disabled = false;' +
      '      translateBtn.textContent = "翻译";' +
      '      summarizeBtn.disabled = false;' +
      '      summarizeBtn.textContent = "AI 总结: 有什么用 - 收不收费 - 怎么用";' +
      '      saveSettingsBtn.disabled = false;' +
      '      saveSettingsBtn.textContent = "保存";' +
      '      showToast(msg.message,"error");' +
      '      break;' +
      '  }' +
      '});' +
      'var toastTimeout = null;' +
      'function showToast(msg,type){' +
      '  toast.textContent = msg;' +
      '  toast.className = "toast " + type;' +
      '  toast.style.display = "block";' +
      '  clearTimeout(toastTimeout);' +
      '  toastTimeout = setTimeout(function(){toast.style.display="none"},5000);' +
      '}' +
      'vscode.postMessage({type:"ready"});' +
      '</script>' +
      '</body>' +
      '</html>';
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