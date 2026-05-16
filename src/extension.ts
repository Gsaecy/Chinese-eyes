import * as vscode from 'vscode';
import { ExtensionBrowserViewProvider } from './extensionBrowserView';
import { Translator } from './translator';

let provider: ExtensionBrowserViewProvider | undefined;
let translator: Translator | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('[ext-trans-picker] 激活中...');

  try {
    const defaultConfig = {
      provider: 'local' as const,
      apiKey: '',
      targetLanguage: 'zh-CN',
      customEndpoint: '',
      customModel: '',
    };
    translator = new Translator(defaultConfig);

    // ---- 注册侧边栏面板 ----
    provider = new ExtensionBrowserViewProvider(context.extensionUri, translator, context);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        ExtensionBrowserViewProvider.viewType,
        provider
      )
    );

    // ---- 打开侧边栏命令 ----
    context.subscriptions.push(
      vscode.commands.registerCommand('chineseEyes.openPanel', () => {
        vscode.commands.executeCommand('workbench.view.extension.chineseEyes-sidebar');
      })
    );

    // ---- 配置变更监听 ----
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('chineseEyes')) {
          const config = vscode.workspace.getConfiguration('chineseEyes');
          translator?.updateConfig({
            provider: config.get('translationProvider', 'local'),
            apiKey: config.get('apiKey', ''),
            targetLanguage: 'zh-CN',
            customEndpoint: config.get('apiEndpoint', ''),
            customModel: config.get('apiModel', ''),
          });
        }
      })
    );

    console.log('[ext-trans-picker] 激活完成');
  } catch (err: any) {
    console.error('[chinese-eyes] 激活失败:', err);
    vscode.window.showErrorMessage(`扩展选择助手 激活失败: ${err.message}`);
  }
}

export function deactivate() {
  console.log('[ext-trans-picker] 已停用');
}