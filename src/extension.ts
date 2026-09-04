import * as vscode from 'vscode';
import { ExtensionBrowserViewProvider } from './extensionBrowserView';
import { Translator } from './translator';
import { TranslatorPanel } from './translatorPanel';
import { API_KEY_MASK, isApiKeyMask } from './types';

let provider: ExtensionBrowserViewProvider | undefined;
let translator: Translator | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('[chineseEyes] 0.3.0 激活中...');

  try {
    const config = vscode.workspace.getConfiguration('chineseEyes');
    const cfgKey = config.get('apiKey', '') as string;
    translator = new Translator({
      provider: config.get('translationProvider', 'local'),
      // 配置值若是掩码占位则传空，随后由密钥库注入真实值
      apiKey: isApiKeyMask(cfgKey) ? '' : cfgKey,
      targetLanguage: 'zh-CN',
      customEndpoint: config.get('apiEndpoint', ''),
      customModel: config.get('apiModel', ''),
    });

    // API Key 迁移到系统密钥库（SecretStorage），settings.json 只留黑点掩码
    (async () => {
      try {
        const stored = await context.secrets.get('chineseEyes.apiKey');
        const legacy = config.get('apiKey', '') as string;
        if (!stored && legacy && !isApiKeyMask(legacy)) {
          // 旧版明文 → 搬进密钥库 + 回写掩码
          await context.secrets.store('chineseEyes.apiKey', legacy);
          await config.update('apiKey', API_KEY_MASK, vscode.ConfigurationTarget.Global);
          console.log('[chineseEyes] 已将 API Key 从 settings.json 迁移至系统密钥库');
        } else if (stored && !isApiKeyMask(legacy) && legacy !== stored) {
          // 密钥库已有值、settings.json 还残留旧明文 → 以密钥库为准，回写掩码
          await config.update('apiKey', API_KEY_MASK, vscode.ConfigurationTarget.Global);
          translator!.updateConfig({
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

    // 配置变更监听（API Key 从系统密钥库读取；用户在设置 UI 粘贴新 Key 时自动迁入）
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('chineseEyes') && translator) {
          const c = vscode.workspace.getConfiguration('chineseEyes');
          const cfgKey = String(c.get('apiKey', '') || '');
          const applyConfig = (apiKey: string) => {
            translator!.updateConfig({
              provider: c.get('translationProvider', 'local'),
              apiKey,
              targetLanguage: 'zh-CN',
              customEndpoint: c.get('apiEndpoint', ''),
              customModel: c.get('apiModel', ''),
            });
          };
          if (isApiKeyMask(cfgKey)) {
            // 掩码占位（扩展自己回写的）→ 从密钥库取真实值
            context.secrets.get('chineseEyes.apiKey').then((key) => applyConfig(key || ''));
          } else {
            // 用户在 VS Code 设置里粘贴了新 Key 或清空了字段 → 写入密钥库
            context.secrets.store('chineseEyes.apiKey', cfgKey).then(() => {
              if (cfgKey) {
                c.update('apiKey', API_KEY_MASK, vscode.ConfigurationTarget.Global);
              }
              applyConfig(cfgKey);
            });
          }
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
