import * as vscode from 'vscode';
import { ExtensionBrowserViewProvider } from './extensionBrowserView';
import { Translator } from './translator';
import { TranslatorPanel } from './translatorPanel';

let provider: ExtensionBrowserViewProvider | undefined;
let translator: Translator | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('[chineseEyes] 0.3.0 激活中...');

  try {
    const config = vscode.workspace.getConfiguration('chineseEyes');
    translator = new Translator({
      provider: config.get('translationProvider', 'local'),
      apiKey: config.get('apiKey', ''), // 旧版明文兼容值，随后由密钥库覆盖
      targetLanguage: 'zh-CN',
      customEndpoint: config.get('apiEndpoint', ''),
      customModel: config.get('apiModel', ''),
    });

    // API Key 迁移到系统密钥库（SecretStorage），不再存 settings.json 明文
    (async () => {
      try {
        const stored = await context.secrets.get('chineseEyes.apiKey');
        const legacy = config.get('apiKey', '') as string;
        if (!stored && legacy) {
          await context.secrets.store('chineseEyes.apiKey', legacy);
          await config.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
          console.log('[chineseEyes] 已将 API Key 从 settings.json 迁移至系统密钥库');
        } else if (stored && stored !== legacy && translator) {
          translator.updateConfig({
            provider: config.get('translationProvider', 'local'),
            apiKey: stored,
            targetLanguage: 'zh-CN',
            customEndpoint: config.get('apiEndpoint', ''),
            customModel: config.get('apiModel', ''),
          });
        }
      } catch (e: any) {
        console.warn('[chineseEyes] API Key 迁移失败:', e);
      }
    })();

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

    // 打开翻译面板命令
    context.subscriptions.push(
      vscode.commands.registerCommand('chineseEyes.openTranslator', () => {
        TranslatorPanel.show(context.extensionUri, translator!);
      })
    );

    // 配置变更监听（API Key 从系统密钥库读取）
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('chineseEyes') && translator) {
          const c = vscode.workspace.getConfiguration('chineseEyes');
          context.secrets.get('chineseEyes.apiKey').then((key) => {
            translator!.updateConfig({
              provider: c.get('translationProvider', 'local'),
              apiKey: key || c.get('apiKey', ''),
              targetLanguage: 'zh-CN',
              customEndpoint: c.get('apiEndpoint', ''),
              customModel: c.get('apiModel', ''),
            });
          });
        }
      })
    );

    console.log('[chineseEyes] 激活完成');
  } catch (err: any) {
    // 激活失败不影响其他扩展
    console.error('[chineseEyes] 激活部分失败:', err);
    // 仍然让扩展激活，不要抛出错误
  }
}

export function deactivate() {
  console.log('[chineseEyes] 已停用');
}
