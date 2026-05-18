import * as vscode from 'vscode';
import { ExtensionBrowserViewProvider } from './extensionBrowserView';
import { Translator } from './translator';

let provider: ExtensionBrowserViewProvider | undefined;
let translator: Translator | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('[chineseEyes] 0.3.0 激活中...');

  try {
    const config = vscode.workspace.getConfiguration('chineseEyes');
    translator = new Translator({
      provider: config.get('translationProvider', 'local'),
      apiKey: config.get('apiKey', ''),
      targetLanguage: 'zh-CN',
      customEndpoint: config.get('apiEndpoint', ''),
      customModel: config.get('apiModel', ''),
    });

    // 注册侧边栏视图（扩展列表）
    provider = new ExtensionBrowserViewProvider(context.extensionUri, translator, context);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        ExtensionBrowserViewProvider.viewType,
        provider
      )
    );

    // 打开侧边栏命令
    context.subscriptions.push(
      vscode.commands.registerCommand('chineseEyes.openPanel', () => {
        vscode.commands.executeCommand('workbench.view.extension.chineseEyes-sidebar');
      })
    );

    // 打开设置命令
    context.subscriptions.push(
      vscode.commands.registerCommand('chineseEyes.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:honor-world.ext-trans-picker');
      })
    );

    // 配置变更监听
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('chineseEyes') && translator) {
          const c = vscode.workspace.getConfiguration('chineseEyes');
          translator.updateConfig({
            provider: c.get('translationProvider', 'local'),
            apiKey: c.get('apiKey', ''),
            targetLanguage: 'zh-CN',
            customEndpoint: c.get('apiEndpoint', ''),
            customModel: c.get('apiModel', ''),
          });
        }
      })
    );

    console.log('[chineseEyes] 激活完成');
  } catch (err: any) {
    console.error('[chineseEyes] 激活失败:', err);
    vscode.window.showErrorMessage(`扩展选择助手 激活失败: ${err.message}`);
  }
}

export function deactivate() {
  console.log('[chineseEyes] 已停用');
}
