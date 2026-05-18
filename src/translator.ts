import * as https from 'https';
import * as http from 'http';
import * as zlib from 'zlib';
import { createSafeHttpsAgent } from './tlsCompat';

export interface TranslationConfig {
  provider: string;
  apiKey?: string;
  targetLanguage?: string;
  customEndpoint?: string;
  customModel?: string;
}

/**
 * 翻译服务模块
 * 支持 local（内置本地翻译）、DeepL、Google、LibreTranslate
 */
export class Translator {
  private cache = new Map<string, string>();
  private config: TranslationConfig;

  constructor(config: TranslationConfig) {
    this.config = config;
  }

  updateConfig(config: TranslationConfig): void {
    this.config = config;
  }

  /** 批量翻译文本 */
  async translateBatch(texts: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const toTranslate: string[] = [];

    for (const text of texts) {
      if (!text || !text.trim()) {
        result[text] = text;
        continue;
      }
      const cached = this.cache.get(text);
      if (cached) {
        result[text] = cached;
      } else {
        toTranslate.push(text);
      }
    }

    if (toTranslate.length === 0) {
      return result;
    }

    try {
      const translations = await this.callTranslationAPI(toTranslate);
      for (let i = 0; i < toTranslate.length; i++) {
        const translated = translations[i] || toTranslate[i];
        this.cache.set(toTranslate[i], translated);
        result[toTranslate[i]] = translated;
      }
    } catch (err) {
      console.warn('翻译失败，降级到本地翻译:', err);
      for (const text of toTranslate) {
        const localResult = localTranslate(text);
        this.cache.set(text, localResult);
        result[text] = localResult;
      }
    }

    return result;
  }

  async translate(text: string): Promise<string> {
    const results = await this.translateBatch([text]);
    return results[text] || text;
  }

  /**
   * 翻译一段较长的 Markdown 文本（如 README）。
   * 不使用 SEP 分隔策略，让 LLM 直接输出中文 Markdown，保留原结构。
   * 当 provider 不是 LLM 时，回退到本地词典逐段处理。
   */
  async translateMarkdown(markdown: string): Promise<string> {
    if (!markdown || !markdown.trim()) return markdown;

    if (!this.isLLMProvider() || !this.config.apiKey) {
      return localTranslate(markdown);
    }

    const defaultEndpoint = this.config.provider === 'deepseek'
      ? 'https://api.deepseek.com'
      : 'https://api.openai.com';
    const defaultModel = this.config.provider === 'deepseek'
      ? 'deepseek-chat'
      : 'gpt-4o-mini';
    const endpoint = (this.config.customEndpoint || defaultEndpoint).replace(/\/+$/, '');
    const model = this.config.customModel || defaultModel;

    const systemPrompt = [
      '你是一个专业的 Markdown 翻译器，把英文 Markdown 文档翻译成简体中文 Markdown。',
      '规则：',
      '1. 完整保留原 Markdown 结构（标题、列表、表格、代码块、链接、图片、HTML 标签）',
      '2. 只翻译自然语言内容，不要翻译代码块、行内代码、命令、URL、品牌名',
      '3. 保留技术术语（API/SDK/CLI/IDE 等）不翻译',
      '4. 翻译后直接输出 Markdown，不要包在 ```markdown 代码块里，不要寒暄说明',
      '5. 如果原文已是中文则原样返回',
      '6. 对涉及收费的句子（含 paid/pricing/subscription/trial/premium/license/billing 等），在该句末尾追加 ⚠️',
    ].join('\n');

    const response = await httpsPost(
      `${endpoint}/v1/chat/completions`,
      JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: markdown.substring(0, 16000) },
        ],
        temperature: 0.1,
        max_tokens: 6000,
      }),
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      }
    );

    const result = JSON.parse(response);
    if (result.error) {
      throw new Error(result.error.message || JSON.stringify(result.error));
    }
    const out = result.choices?.[0]?.message?.content;
    if (!out) throw new Error('翻译返回为空');
    return String(out).trim();
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async callTranslationAPI(texts: string[]): Promise<string[]> {
    switch (this.config.provider) {
      case 'local':
        return texts.map(t => localTranslate(t));
      case 'deepl':
        return this.translateDeepL(texts);
      case 'google':
        return this.translateGoogle(texts);
      case 'libretranslate':
        return this.translateLibre(texts);
      case 'deepseek':
        return this.translateOpenAILike(texts, 'https://api.deepseek.com', 'deepseek-chat');
      case 'openai-compatible':
        return this.translateOpenAILike(texts, 'https://api.openai.com', 'gpt-4o-mini');
      default:
        console.log('未配置翻译API，使用本地翻译');
        return texts.map(t => localTranslate(t));
    }
  }

  /** 是否支持 AI 总结 */
  canSummarize(): boolean {
    return (this.config.provider === 'deepseek' || this.config.provider === 'openai-compatible')
      && !!this.config.apiKey;
  }

  /** 是否使用了基于 LLM 的翻译（具备智能翻译能力） */
  isLLMProvider(): boolean {
    return this.config.provider === 'deepseek' || this.config.provider === 'openai-compatible';
  }

  /**
   * 调用 LLM 进行 AI 总结（无翻译流程，直接 system+user 提示）
   * 仅在 provider 为 deepseek 或 openai-compatible 时可用
   */
  async summarize(content: string, customSystemPrompt?: string): Promise<string> {
    if (!this.canSummarize()) {
      throw new Error('当前翻译源不支持 AI 总结，请切换到 DeepSeek 或 OpenAI 兼容并配置 API Key');
    }
    const defaultEndpoint = this.config.provider === 'deepseek'
      ? 'https://api.deepseek.com'
      : 'https://api.openai.com';
    const defaultModel = this.config.provider === 'deepseek'
      ? 'deepseek-chat'
      : 'gpt-4o-mini';
    const endpoint = (this.config.customEndpoint || defaultEndpoint).replace(/\/+$/, '');
    const model = this.config.customModel || defaultModel;

    const systemPrompt = customSystemPrompt || [
      '你是一个 VS Code 扩展说明助手。',
      '请用中文对用户提供的扩展介绍/README 进行总结，面向不懂英语的普通用户。',
      '总结必须包含以下三部分，使用 Markdown 标题：',
      '## 有什么用',
      '用大白话说明扩展的核心功能、解决什么问题。',
      '## 收不收费',
      '明确告知是否需要付费、价格、限制；若原文未提及则写「未明确说明，可能是免费的」。',
      '## 怎么用',
      '安装后如何启用，用 1-4 个步骤简明说明。',
      '注意：',
      '- 通俗易懂，不堆专业术语',
      '- 直接输出 Markdown，不要包装在 ```markdown 代码块中',
      '- 不要前置寒暄，开头就是 ## 标题',
    ].join('\n');

    const response = await httpsPost(
      `${endpoint}/v1/chat/completions`,
      JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: content.substring(0, 12000) },
        ],
        temperature: 0.2,
        max_tokens: 1200,
      }),
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      }
    );

    const result = JSON.parse(response);
    if (result.error) {
      throw new Error(result.error.message || JSON.stringify(result.error));
    }
    const text = result.choices?.[0]?.message?.content;
    if (!text) throw new Error('AI 返回为空');
    return String(text).trim();
  }

  private async translateDeepL(texts: string[]): Promise<string[]> {
    const apiKey = this.config.apiKey;
    if (!apiKey) throw new Error('请配置 DeepL API Key');
    const text = texts.join('\n<<<SEP>>>\n');
    const response = await httpsPost(
      'https://api-free.deepl.com/v2/translate',
      JSON.stringify({ text: [text], target_lang: 'ZH' }),
      {
        'Content-Type': 'application/json',
        'Authorization': `DeepL-Auth-Key ${apiKey}`,
      }
    );
    const result = JSON.parse(response);
    return (result.translations?.[0]?.text ?? text).split('\n<<<SEP>>>\n');
  }

  private async translateGoogle(texts: string[]): Promise<string[]> {
    const apiKey = this.config.apiKey;
    if (!apiKey) throw new Error('请配置 Google API Key');
    const response = await httpsPost(
      `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`,
      JSON.stringify({ q: texts, target: 'zh-CN' }),
      { 'Content-Type': 'application/json' }
    );
    const result = JSON.parse(response);
    return result.data?.translations?.map((t: any) => t.translatedText) ?? texts;
  }

  private async translateLibre(texts: string[]): Promise<string[]> {
    const endpoint = this.config.customEndpoint || 'https://libretranslate.com';
    const response = await httpsPost(
      `${endpoint}/translate`,
      JSON.stringify({ q: texts.join('\n<<<SEP>>>\n'), source: 'en', target: 'zh', format: 'text' }),
      {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      }
    );
    const result = JSON.parse(response);
    return (result.translatedText ?? texts.join('\n<<<SEP>>>\n')).split('\n<<<SEP>>>\n');
  }

  private async translateOpenAILike(
    texts: string[],
    defaultEndpoint: string,
    defaultModel: string
  ): Promise<string[]> {
    const apiKey = this.config.apiKey;
    if (!apiKey) throw new Error('请配置 API Key');

    const endpoint = (this.config.customEndpoint || defaultEndpoint).replace(/\/+$/, '');
    const model = this.config.customModel || defaultModel;

    const toTranslate = texts.join('\n<<<SEP>>>\n');
    const systemPrompt = [
      '你是一个专业的英语到简体中文翻译器。',
      '规则：',
      '1. 只输出翻译结果，不要解释、不要前缀、不要额外文字',
      '2. 每条翻译结果之间用 <<<SEP>>> 分隔，保持顺序',
      '3. 保留技术术语（API, SDK, CLI 等）不翻译',
      '4. 保留品牌名不翻译（React, Vue, VS Code 等）',
      '5. 保留代码片段不翻译',
      '6. 如果原文已是中文则直接保留',
      '7. 对收费关键词（paid, pricing, subscription 等）在译文末尾附加 ⚠️[付费]',
    ].join('\n');

    const response = await httpsPost(
      `${endpoint}/v1/chat/completions`,
      JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: toTranslate },
        ],
        temperature: 0.1,
        max_tokens: 4096,
      }),
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      }
    );

    const result = JSON.parse(response);
    if (result.error) {
      throw new Error(result.error.message || JSON.stringify(result.error));
    }
    const translated = result.choices?.[0]?.message?.content ?? toTranslate;
    return translated.split('<<<SEP>>>').map((t: string) => t.trim());
  }
}

// ============================================================
//  本地翻译器 —— 内置英文→中文词表，无需网络
// ============================================================

const DICT: Record<string, string> = {
  'Extension': '扩展',
  'extensions': '扩展',
  'extension': '扩展',
  'plugin': '插件',
  'framework': '框架',
  'library': '库',
  'tool': '工具',
  'utility': '实用工具',
  'module': '模块',
  'package': '包',
  'runtime': '运行时',
  'compiler': '编译器',
  'interpreter': '解释器',
  'engine': '引擎',
  'server': '服务器',
  'client': '客户端',
  'terminal': '终端',
  'console': '控制台',
  'editor': '编辑器',
  'viewer': '查看器',
  'browser': '浏览器',
  'manager': '管理器',
  'provider': '提供程序',
  'handler': '处理器',
  'service': '服务',
  'interface': '接口',
  'configuration': '配置',
  'setting': '设置',
  'theme': '主题',
  'color': '颜色',
  'colors': '颜色方案',
  'icon': '图标',
  'icons': '图标',
  'syntax': '语法',
  'highlight': '高亮',
  'highlighting': '高亮显示',
  'snippet': '代码片段',
  'snippets': '代码片段',
  'completion': '补全',
  'IntelliSense': '智能感知',
  'autocomplete': '自动补全',
  'formatting': '格式化',
  'formatter': '格式化工具',
  'linter': '代码检查工具',
  'linting': '代码检查',
  'prettier': '代码美化',
  'debug': '调试',
  'debugger': '调试器',
  'testing': '测试',
  'task': '任务',
  'build': '构建',
  'deploy': '部署',
  'deployment': '部署',
  'publish': '发布',
  'version': '版本',
  'control': '版本控制',
  'git': 'Git',
  'github': 'GitHub',
  'repository': '代码仓库',
  'branch': '分支',
  'merge': '合并',
  'commit': '提交',
  'diff': '差异对比',
  'pull': '拉取',
  'push': '推送',
  'clone': '克隆',
  'Visual Studio Code': 'Visual Studio Code',
  'TypeScript': 'TypeScript',
  'JavaScript': 'JavaScript',
  'Python': 'Python',
  'Java': 'Java',
  'C++': 'C++',
  'Go': 'Go',
  'Rust': 'Rust',
  'Regex': '正则表达式',
  'regex': '正则表达式',
  'HTML': 'HTML',
  'CSS': 'CSS',
  'JSON': 'JSON',
  'XML': 'XML',
  'YAML': 'YAML',
  'Markdown': 'Markdown',
  'SQL': 'SQL',
  'GraphQL': 'GraphQL',
  'REST': 'REST',
  'API': 'API',
  'SDK': 'SDK',
  'CLI': 'CLI',
  'UI': 'UI',
  'UX': 'UX',
  'IDE': 'IDE',
  'AI': 'AI',
  'ML': '机器学习',
  'LLM': '大语言模型',
  'GPT': 'GPT',
  'Copilot': 'Copilot',
  'React': 'React',
  'Vue': 'Vue',
  'Angular': 'Angular',
  'Node': 'Node',
  'Node.js': 'Node.js',
  'Next': 'Next.js',
  'Express': 'Express',
  'Flask': 'Flask',
  'Django': 'Django',
  'Docker': 'Docker',
  'Kubernetes': 'Kubernetes',
  'CI/CD': 'CI/CD',
  'lint': '代码检查',
  'preview': '预览',
  'live': '实时',
  'remote': '远程',
  'local': '本地',
  'cloud': '云端',
  'web': '网页',
  'mobile': '移动端',
  'desktop': '桌面端',
  'cross-platform': '跨平台',
  'open source': '开源',
  'free': '免费',
  'paid': '付费',
  'premium': '高级版',
  'pro': '专业版',
  'enterprise': '企业版',
  'trial': '试用',
  'license': '许可证',
  'MIT': 'MIT 许可证',
  'Apache': 'Apache 许可证',
  'install': '安装',
  'uninstall': '卸载',
  'update': '更新',
  'upgrade': '升级',
  'restart': '重启',
  'reload': '重新加载',
  'save': '保存',
  'open': '打开',
  'close': '关闭',
  'export': '导出',
  'import': '导入',
  'download': '下载',
  'upload': '上传',
  'search': '搜索',
  'find': '查找',
  'replace': '替换',
  'filter': '过滤',
  'sort': '排序',
  'navigate': '导航',
  'bookmark': '书签',
  'selection': '选中区域',
  'select': '选择',
  'copy': '复制',
  'paste': '粘贴',
  'cut': '剪切',
  'undo': '撤销',
  'redo': '重做',
  'delete': '删除',
  'rename': '重命名',
  'move': '移动',
  'file': '文件',
  'files': '文件',
  'folder': '文件夹',
  'directory': '目录',
  'path': '路径',
  'workspace': '工作区',
  'project': '项目',
  'template': '模板',
  'scaffold': '脚手架',
  'generator': '生成器',
  'command': '命令',
  'palette': '命令面板',
  'shortcut': '快捷键',
  'keybinding': '按键绑定',
  'keyboard': '键盘',
  'cursor': '光标',
  'input': '输入',
  'output': '输出',
  'error': '错误',
  'warning': '警告',
  'info': '信息',
  'log': '日志',
  'notification': '通知',
  'status': '状态',
  'progress': '进度',
  'performance': '性能',
  'optimization': '优化',
  'fast': '快速',
  'efficient': '高效',
  'lightweight': '轻量级',
  'minimal': '极简',
  'simple': '简洁',
  'beautiful': '精美的',
  'modern': '现代的',
  'custom': '自定义',
  'customizable': '可自定义',
  'configurable': '可配置',
  'extensible': '可扩展',
  'modular': '模块化',
  'compatible': '兼容',
  'integrated': '集成的',
  'seamless': '无缝的',
  'intuitive': '直观的',
  'powerful': '强大的',
  'robust': '稳健的',
  'reliable': '可靠的',
  'secure': '安全的',
  'scalable': '可伸缩',
  'flexible': '灵活的',
  'smart': '智能的',
  'automatic': '自动的',
  'manual': '手动的',
  'interactive': '交互式',
  'visual': '可视化的',
  'tree': '树形',
  'list': '列表',
  'grid': '网格',
  'table': '表格',
  'chart': '图表',
  'diagram': '图表',
  'image': '图片',
  'video': '视频',
  'audio': '音频',
  'text': '文本',
  'string': '字符串',
  'number': '数字',
  'boolean': '布尔值',
  'array': '数组',
  'object': '对象',
  'function': '函数',
  'class': '类',
  'method': '方法',
  'property': '属性',
  'variable': '变量',
  'constant': '常量',
  'parameter': '参数',
  'callback': '回调',
  'promise': 'Promise',
  'async': '异步',
  'sync': '同步',
  'event': '事件',
  'listener': '监听器',
  'stream': '流',
  'buffer': '缓冲',
  'state': '状态',
  'component': '组件',
  'hook': '钩子',
  'directive': '指令',
  'guard': '守卫',
  'interceptor': '拦截器',
  'decorator': '装饰器',
  'validator': '验证器',
  'serializer': '序列化器',
  'converter': '转换器',
  'parser': '解析器',
  'tokenizer': '分词器',
  'lexer': '词法分析器',
  'pricing': '付费定价 ⚠️',
  'subscription': '订阅制 ⚠️',
  'purchase': '需购买 ⚠️',
  'billing': '账单 ⚠️',
  'payment': '付款 ⚠️',
  'monthly': '月付 ⚠️',
  'annually': '年付 ⚠️',
  'lifetime': '永久买断',
  'freemium': '免费增值模式 ⚠️',
  'pay-as-you-go': '按需付费 ⚠️',
  'per seat': '按席位 ⚠️',
  'per user': '按用户 ⚠️',
  'per month': '每月 ⚠️',
  'starting at': '起售价 ⚠️',
  'unlimited': '无限使用',
  'limited': '有限制 ⚠️',
  'restrictions': '限制 ⚠️',
  'watermark': '水印 ⚠️',
  'ads': '广告 ⚠️',
  'donation': '捐赠',
  'community edition': '社区版',
  'professional edition': '专业版 ⚠️',
  'business': '商业版 ⚠️',
  'commercial': '商业用途 ⚠️',
  'non-commercial': '非商业',
  'personal use': '个人使用',
  'evaluation': '评估版',
  'demo': '演示版',
  'registration': '注册',
  'activation': '激活',
};

function localTranslate(text: string): string {
  if (!text || !text.trim()) return text;

  // 检测是否已是中文（超过50%中文字符则跳过）
  let chineseCount = 0;
  let meaningfulChars = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4E00 && code <= 0x9FFF) chineseCount++;
    if (code > 32) meaningfulChars++;
  }
  if (meaningfulChars > 0 && chineseCount / meaningfulChars > 0.5) {
    return text;
  }

  // 检测收费关键词
  let paidWarning = '';
  const lowerText = text.toLowerCase();
  const paidKeys = [
    'paid', 'pricing', 'subscription', 'billing', 'purchase',
    'monthly', 'annually', 'per seat', 'per user', 'per month',
    'starting at', 'starts at', 'freemium', 'trial', 'pro',
    'premium', 'enterprise', 'limited', 'restrictions',
    'watermark', 'ads', 'commercial',
  ];
  for (const kw of paidKeys) {
    if (lowerText.includes(kw)) {
      paidWarning = ' ⚠️[注意收费]';
      break;
    }
  }

  // 长词优先替换
  let result = text;
  const entries = Object.entries(DICT);
  entries.sort((a, b) => b[0].length - a[0].length);

  for (const [en, zh] of entries) {
    if (zh === en) continue; // 品牌名保持原文
    if (en.length <= 2) continue;
    const regex = new RegExp(`\\b${escapeRegExp(en)}\\b`, 'g');
    let changed = false;
    result = result.replace(regex, () => { changed = true; return zh; });
    if (changed) continue;
  }

  if (result === text) {
    return text + paidWarning;
  }
  return result + paidWarning;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
//  HTTP 辅助
// ============================================================

function httpsPost(
  url: string,
  data: string,
  headers: Record<string, string>
): Promise<string> {
  return httpRequest(url, 'POST', data, headers, true);
}

function httpRequest(
  url: string,
  method: string,
  data: string,
  headers: Record<string, string>,
  useHttps: boolean
): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = useHttps ? https : http;

    // macOS/Linux 使用 Node 默认 HTTPS Agent，避免自定义 TLS 干扰 API 调用
    const isMacOrLinux = process.platform !== 'win32';
    const agent = useHttps && !isMacOrLinux ? createSafeHttpsAgent() : undefined;

    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      port: urlObj.port || (useHttps ? 443 : 80),
      method,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(data) },
      timeout: 30000,
      agent,
    };

    const req = mod.request(options, (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        let result: Buffer = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        if (enc === 'gzip') {
          try { result = zlib.gunzipSync(result) as Buffer; } catch (e) { reject(e); return; }
        } else if (enc === 'deflate') {
          try { result = zlib.inflateSync(result) as Buffer; } catch (e) { reject(e); return; }
        }
        resolve(result.toString('utf-8'));
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(data);
    req.end();
  });
}
