import * as http from 'http';
import * as tls from 'tls';

export interface TranslationConfig {
  provider: string;
  apiKey?: string;
  targetLanguage?: string;
  customEndpoint?: string;
  customModel?: string;
}

interface LLMConfig {
  endpoint: string;
  model: string;
}

/** 智能翻译结果 */
export interface TranslateResult {
  /** 最终译文 */
  text: string;
  /** 翻译来源 */
  source: 'api' | 'free-online' | 'local';
  /** 降级提示（翻译质量受限时说明原因） */
  warning?: string;
}

/**
 * 翻译服务模块
 * 支持 local（内置本地翻译）、DeepL、Google、LibreTranslate、LLM（DeepSeek/OpenAI 兼容）
 */
export class Translator {
  private cache = new Map<string, string>();
  private smartCache = new Map<string, TranslateResult>();
  private freeOnlineFailAt = 0;
  private config: TranslationConfig;

  constructor(config: TranslationConfig) {
    this.config = config;
  }

  updateConfig(config: TranslationConfig): void {
    this.config = config;
    this.smartCache.clear();
    this.freeOnlineFailAt = 0;
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
        const translated = (translations[i] || '').trim() || toTranslate[i];
        // API 原样返回英文时不要污染缓存（下次会重新尝试翻译）
        if (translated !== toTranslate[i] || !this.isLLMProvider()) {
          this.cache.set(toTranslate[i], translated);
        }
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
   * 智能翻译（供翻译面板/详情页使用）—— 依次尝试：
   * 1. 已配置的 API 提供商（LLM / DeepL / Google / LibreTranslate）
   * 2. 免费在线翻译（Google 网页翻译接口，无需 Key，支持代理）
   * 3. 本地词典兜底，并给出明确提示
   * @param text 待翻译文本
   * @param proxyUrl 可选 HTTP 代理（如 http://127.0.0.1:7890），用于免费在线翻译
   */
  async translateSmart(text: string, proxyUrl?: string): Promise<TranslateResult> {
    if (!text || !text.trim()) {
      return { text, source: 'local' };
    }

    const cached = this.smartCache.get(text);
    if (cached) {
      return cached;
    }

    const provider = this.config.provider;
    const apiProviders = ['deepl', 'google', 'libretranslate', 'deepseek', 'openai-compatible'];

    // 1. 已配置 API Key 的提供商
    if (apiProviders.includes(provider) && this.config.apiKey) {
      try {
        const translated = await this.translateViaProviderOne(text);
        if (isRealTranslation(text, translated)) {
          const r: TranslateResult = { text: translated, source: 'api' };
          this.smartCache.set(text, r);
          return r;
        }
        console.warn('[chineseEyes] API 返回内容仍是英文，尝试免费渠道');
      } catch (err) {
        console.warn('[chineseEyes] API 翻译失败，尝试免费渠道:', err);
      }
    }

    // 2. 免费在线翻译（无需 Key，支持代理）
    const free = await this.tryFreeOnlineTranslate(text, proxyUrl);
    if (free) {
      const r: TranslateResult = { text: free, source: 'free-online' };
      this.smartCache.set(text, r);
      return r;
    }

    // 3. 本地词典兜底 + 明确提示
    const local = localTranslate(text);
    let warning: string;
    if (apiProviders.includes(provider)) {
      warning = '在线翻译暂时不可用，已使用本地词典（仅翻译常用词汇）。请检查网络后重试。';
    } else if (isMostlyEnglish(local)) {
      warning = '本地词典只能翻译常用技术词汇，无法完整翻译这段文本。建议在设置中配置 DeepSeek 或 OpenAI 兼容 API Key 以获得完整翻译。';
    } else {
      warning = '已使用本地词典翻译（部分词汇可能不准确），配置 API Key 可获得更准确的翻译。';
    }
    const r: TranslateResult = { text: local, source: 'local', warning };
    this.smartCache.set(text, r);
    return r;
  }

  /** 用当前提供商翻译单段文本（失败时抛出异常） */
  private async translateViaProviderOne(text: string): Promise<string> {
    const results = await this.callTranslationAPI([text]);
    const out = (results && results[0]) || text;
    if (out !== text) {
      this.cache.set(text, out);
    }
    return out;
  }

  /** 免费在线翻译（Google gtx + 有道双通道，均失败返回 null） */
  private async tryFreeOnlineTranslate(text: string, proxyUrl?: string): Promise<string | null> {
    // 一分钟内失败过就跳过，避免每次都卡超时
    if (Date.now() - this.freeOnlineFailAt < 60_000) {
      return null;
    }
    try {
      const chunks = splitTextForTranslate(text, 900);
      // 依次尝试各免费通道；每个通道直连与代理并行，谁先成功用谁
      const providers: FreeProvider[] = ['google', 'youdao'];
      for (const provider of providers) {
        const direct = this.freeOnlineViaFetch(chunks, provider);
        const viaProxy = proxyUrl
          ? this.freeOnlineViaProxy(chunks, provider, proxyUrl)
          : Promise.resolve(null);
        const [directResult, proxyResult] = await Promise.all([direct, viaProxy]);
        const joined = directResult ?? proxyResult;
        if (joined && joined.trim() && isRealTranslation(text, joined)) {
          this.freeOnlineFailAt = 0;
          return joined;
        }
      }
      this.freeOnlineFailAt = Date.now();
      return null;
    } catch (err) {
      this.freeOnlineFailAt = Date.now();
      console.warn('[chineseEyes] 免费在线翻译不可用:', err);
      return null;
    }
  }

  /** 直连免费翻译（原生 fetch） */
  private async freeOnlineViaFetch(chunks: string[], provider: FreeProvider): Promise<string | null> {
    try {
      const parts: string[] = [];
      for (const chunk of chunks) {
        const req = buildFreeTranslateRequest(provider, chunk);
        const res = await fetchWithTimeout(
          req.url,
          {
            method: req.method,
            headers: req.headers,
            body: req.body,
          },
          6000
        );
        const raw = await res.text();
        parts.push(parseFreeTranslateResult(provider, raw));
      }
      return parts.join('');
    } catch (err) {
      console.warn('[chineseEyes] 免费翻译直连失败(' + provider + '):', err);
      return null;
    }
  }

  /** 通过 HTTP CONNECT 代理免费翻译（适配 Clash 等本地代理） */
  private async freeOnlineViaProxy(
    chunks: string[],
    provider: FreeProvider,
    proxyUrl: string
  ): Promise<string | null> {
    try {
      const parts: string[] = [];
      for (const chunk of chunks) {
        const req = buildFreeTranslateRequest(provider, chunk);
        const raw = await httpsViaProxy(req.url, proxyUrl, req.method, req.headers, req.body, 8000);
        parts.push(parseFreeTranslateResult(provider, raw));
      }
      return parts.join('');
    } catch (err) {
      console.warn('[chineseEyes] 免费翻译代理通道失败(' + provider + '):', err);
      return null;
    }
  }

  /**
   * 翻译一段较长的 Markdown 文本（如 README）。
   * LLM provider 时直接调用 LLM 输出中文 Markdown；否则走智能翻译（免费在线/本地词典）。
   */
  async translateMarkdown(markdown: string, proxyUrl?: string): Promise<{ text: string; warning?: string }> {
    if (!markdown || !markdown.trim()) return { text: markdown };

    if (this.isLLMProvider() && this.config.apiKey) {
      const { endpoint, model } = this.resolveLLMConfig();

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

      const out = await this.chatCompletion(endpoint, model, systemPrompt, markdown.substring(0, 16000), 0.1, 6000);
      if (!out) throw new Error('翻译返回为空');
      return { text: out };
    }

    // 非 LLM：智能翻译（免费在线 / 本地词典）
    const res = await this.translateSmart(markdown, proxyUrl);
    return { text: res.text, warning: res.warning };
  }

  clearCache(): void {
    this.cache.clear();
    this.smartCache.clear();
  }

  /** 是否支持 AI 总结 */
  canSummarize(): boolean {
    return this.isLLMProvider() && !!this.config.apiKey;
  }

  /** 是否使用了基于 LLM 的翻译（具备智能翻译能力） */
  isLLMProvider(): boolean {
    return this.config.provider === 'deepseek' || this.config.provider === 'openai-compatible';
  }

  /**
   * 调用 LLM 进行中文 AI 总结
   */
  async summarize(content: string, customSystemPrompt?: string): Promise<string> {
    this.ensureCanSummarize();
    const { endpoint, model } = this.resolveLLMConfig();

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

    const text = await this.chatCompletion(endpoint, model, systemPrompt, content.substring(0, 12000), 0.2, 1200);
    if (!text) throw new Error('AI 返回为空');
    return text;
  }

  /**
   * 用英文生成 AI 总结
   */
  async summarizeEn(content: string): Promise<string> {
    this.ensureCanSummarize();
    const { endpoint, model } = this.resolveLLMConfig();

    const systemPrompt = [
      'You are a VS Code extension documentation assistant.',
      'Summarize the provided extension introduction/README in English.',
      'The summary MUST contain these three sections using Markdown headings:',
      '## What it does',
      'Explain the core functionality and what problem it solves in plain English.',
      '## Pricing',
      'Clearly state if it requires payment, pricing, limitations; if not mentioned, write "Not specified, may be free".',
      '## How to use',
      'Explain how to enable it after installation in 1-4 concise steps.',
      'Notes:',
      '- Be easy to understand, avoid jargon',
      '- Output Markdown directly, do not wrap in ```markdown code blocks',
      '- Do not start with pleasantries, start directly with ## heading',
    ].join('\n');

    const text = await this.chatCompletion(endpoint, model, systemPrompt, content.substring(0, 12000), 0.2, 1200);
    if (!text) throw new Error('AI 返回为空');
    return text;
  }

  // ========== private helpers ==========

  private ensureCanSummarize(): void {
    if (!this.canSummarize()) {
      throw new Error('当前翻译源不支持 AI 总结，请切换到 DeepSeek 或 OpenAI 兼容并配置 API Key');
    }
  }

  /** 统一的 LLM endpoint/model 解析，消除 translateMarkdown/summarize/summarizeEn 中的重复代码 */
  private resolveLLMConfig(): LLMConfig {
    const defaultEndpoint = this.config.provider === 'deepseek'
      ? 'https://api.deepseek.com'
      : 'https://api.openai.com';
    const defaultModel = this.config.provider === 'deepseek'
      ? 'deepseek-chat'
      : 'gpt-4o-mini';
    return {
      endpoint: (this.config.customEndpoint || defaultEndpoint).replace(/\/+$/, ''),
      model: this.config.customModel || defaultModel,
    };
  }

  /** 统一 LLM 调用 */
  private async chatCompletion(
    endpoint: string,
    model: string,
    systemPrompt: string,
    userContent: string,
    temperature: number,
    maxTokens: number,
    timeoutMs: number = 30000,
  ): Promise<string> {
    const response = await fetchWithTimeout(
      `${endpoint}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature,
          max_tokens: maxTokens,
        }),
      },
      timeoutMs,
    );

    const result = await response.json() as {
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string } }>;
    };
    if (result.error) {
      throw new Error(result.error.message || JSON.stringify(result.error));
    }
    const out: string | undefined = result.choices?.[0]?.message?.content;
    return out ? String(out).trim() : '';
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

  private async translateDeepL(texts: string[]): Promise<string[]> {
    const apiKey = this.config.apiKey;
    if (!apiKey) throw new Error('请配置 DeepL API Key');
    const text = texts.join('\n<<<SEP>>>\n');
    const response = await fetchWithTimeout(
      'https://api-free.deepl.com/v2/translate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `DeepL-Auth-Key ${apiKey}`,
        },
        body: JSON.stringify({ text: [text], target_lang: 'ZH' }),
      },
      15000,
    );
    const result = await response.json() as any;
    return (result.translations?.[0]?.text ?? text).split('\n<<<SEP>>>\n');
  }

  private async translateGoogle(texts: string[]): Promise<string[]> {
    const apiKey = this.config.apiKey;
    if (!apiKey) throw new Error('请配置 Google API Key');
    const response = await fetchWithTimeout(
      `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: texts, target: 'zh-CN' }),
      },
      15000,
    );
    const result = await response.json() as any;
    return result.data?.translations?.map((t: any) => t.translatedText) ?? texts;
  }

  private async translateLibre(texts: string[]): Promise<string[]> {
    const endpoint = this.config.customEndpoint || 'https://libretranslate.com';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    const response = await fetchWithTimeout(
      `${endpoint}/translate`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ q: texts.join('\n<<<SEP>>>\n'), source: 'en', target: 'zh', format: 'text' }),
      },
      15000,
    );
    const result = await response.json() as any;
    return (result.translatedText ?? texts.join('\n<<<SEP>>>\n')).split('\n<<<SEP>>>\n');
  }

  private async translateOpenAILike(
    texts: string[],
    defaultEndpoint: string,
    defaultModel: string,
  ): Promise<string[]> {
    const apiKey = this.config.apiKey;
    if (!apiKey) throw new Error('请配置 API Key');

    const endpoint = (this.config.customEndpoint || defaultEndpoint).replace(/\/+$/, '');
    const model = this.config.customModel || defaultModel;

    const SEP = '<<<SEP>>>';
    const systemPrompt = [
      '你是一个专业的英语到简体中文翻译器。',
      '规则：',
      '1. 只输出翻译结果，不要解释、不要前缀、不要额外文字',
      '2. 每条翻译结果之间用 <<<SEP>>> 分隔，保持顺序，不得合并或省略任何一条',
      '3. 保留技术术语（API, SDK, CLI 等）不翻译',
      '4. 保留品牌名不翻译（React, Vue, VS Code 等）',
      '5. 保留代码片段不翻译',
      '6. 如果原文已是中文则直接保留',
      '7. 对收费关键词（paid, pricing, subscription 等）在译文末尾附加 ⚠️[付费]',
    ].join('\n');

    // 分批翻译：每批总长度不超过 2400 字符，避免输出被截断导致条数错位
    const batches: string[][] = [];
    let cur: string[] = [];
    let len = 0;
    for (const t of texts) {
      if (cur.length > 0 && len + t.length + SEP.length > 2400) {
        batches.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(t);
      len += t.length + SEP.length;
    }
    if (cur.length > 0) batches.push(cur);

    const results: string[] = [];
    for (const batch of batches) {
      const joined = batch.join('\n' + SEP + '\n');
      let out = await this.chatCompletion(endpoint, model, systemPrompt, joined, 0.1, 4096, 30000);
      let parts = out.split(SEP).map((s: string) => s.trim());

      // 条数不匹配：重试一次，明确要求按分隔符逐条输出
      if (parts.length !== batch.length) {
        const retryPrompt =
          systemPrompt +
          '\n重要：本次必须逐条输出 ' + batch.length +
          ' 条翻译结果，条与条之间用 ' + SEP + ' 分隔，不要合并、不要省略、不要添加额外说明。';
        out = await this.chatCompletion(endpoint, model, retryPrompt, joined, 0.1, 4096, 30000);
        parts = out.split(SEP).map((s: string) => s.trim());
      }

      // 对齐数量：少了用原文补齐，多了截断
      for (let i = 0; i < batch.length; i++) {
        results.push(parts[i] || batch[i]);
      }
    }
    return results;
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

  // ===== 常用词汇扩展（本地词典兜底翻译质量增强）=====
  'and': '和',
  'with': '与',
  'from': '来自',
  'about': '关于',
  'using': '使用',
  'use': '使用',
  'used': '已使用',
  'your': '你的',
  'more': '更多',
  'new': '新的',
  'data': '数据',
  'code': '代码',
  'language': '语言',
  'languages': '语言',
  'support': '支持',
  'supports': '支持',
  'supported': '支持',
  'feature': '功能',
  'features': '功能',
  'functionality': '功能',
  'work': '工作',
  'works': '运行',
  'run': '运行',
  'running': '运行中',
  'write': '编写',
  'read': '阅读',
  'help': '帮助',
  'page': '页面',
  'create': '创建',
  'created': '已创建',
  'make': '制作',
  'makes': '使',
  'need': '需要',
  'needs': '需要',
  'provide': '提供',
  'provides': '提供',
  'include': '包括',
  'includes': '包括',
  'allow': '允许',
  'allows': '允许',
  'enable': '启用',
  'enables': '启用',
  'enabled': '已启用',
  'disable': '禁用',
  'disabled': '已禁用',
  'show': '显示',
  'shows': '显示',
  'display': '显示',
  'menu': '菜单',
  'button': '按钮',
  'click': '点击',
  'choose': '选择',
  'option': '选项',
  'options': '选项',
  'style': '样式',
  'styles': '样式',
  'font': '字体',
  'fonts': '字体',
  'size': '大小',
  'small': '小型',
  'large': '大型',
  'dark': '深色',
  'light': '浅色',
  'background': '背景',
  'foreground': '前景',
  'sidebar': '侧边栏',
  'panel': '面板',
  'window': '窗口',
  'tab': '标签页',
  'tabs': '标签页',
  'section': '区块',
  'content': '内容',
  'document': '文档',
  'documentation': '文档',
  'docs': '文档',
  'readme': 'README',
  'example': '示例',
  'examples': '示例',
  'description': '描述',
  'default': '默认',
  'value': '值',
  'values': '值',
  'type': '类型',
  'types': '类型',
  'key': '按键',
  'keys': '按键',
  'based': '基于',
  'quick': '快速',
  'quickly': '快速地',
  'easy': '简单',
  'easily': '轻松地',
  'simply': '只需',
  'popular': '流行',
  'best': '最佳',
  'better': '更好',
  'latest': '最新',
  'advanced': '高级',
  'intelligent': '智能的',
  'quality': '高质量',
  'open-source': '开源',
  'available': '可用',
  'required': '必需',
  'optional': '可选',
  'recommended': '推荐',
  'platform': '平台',
  'windows': 'Windows',
  'macos': 'macOS',
  'linux': 'Linux',
  'vscode': 'VS Code',
  'marketplace': '扩展市场',
  'publisher': '发布者',
  'release': '发布',
  'releases': '发布版本',
  'stable': '稳定版',
  'beta': '测试版',
  'alpha': '内测版',
  'productivity': '工作效率',
  'development': '开发',
  'developer': '开发者',
  'developers': '开发者',
  'efficiently': '高效地',
  'automatically': '自动地',
  'settings': '设置',
  'keybindings': '按键绑定',
  'commands': '命令',
  'shortcuts': '快捷键',
  'tools': '工具',
  'utilities': '实用工具',
  'libraries': '代码库',
  'packages': '软件包',
  'dependencies': '依赖',
  'system': '系统',
  'shell': '命令行',
  'online': '在线',
  'offline': '离线',
  'database': '数据库',
  'security': '安全',
  'privacy': '隐私',
  'encryption': '加密',
  'password': '密码',
  'authentication': '身份验证',
  'authorization': '授权',
  'login': '登录',
  'account': '账户',
  'user': '用户',
  'users': '用户',
  'team': '团队',
  'teams': '团队',
  'collaboration': '协作',
  'sharing': '分享',
  'share': '分享',
  'shared': '共享',
  'synchronization': '同步',
  'backup': '备份',
  'restore': '恢复',
  'history': '历史记录',
  'recent': '最近',
  'favorite': '收藏',
  'favorites': '收藏',
  'loading': '加载中',
  'saving': '保存中',
  'saved': '已保存',
  'errors': '错误',
  'warnings': '警告',
  'success': '成功',
  'failed': '失败',
  'failure': '失败',
  'message': '消息',
  'messages': '消息',
  'dialog': '对话框',
  'prompt': '提示',
  'real-time': '实时',
  'realtime': '实时',
  'multi-platform': '多平台',
  'integration': '集成',
  'integrations': '集成',
  'safe': '安全',
  'performant': '高性能',
  'optimized': '已优化',
  'customize': '定制',
  'installer': '安装程序',
  'installed': '已安装',
  'active': '激活',
  'inactive': '未激活',
  'detect': '检测',
  'detection': '检测',
  'analyze': '分析',
  'analysis': '分析',
  'visualize': '可视化',
  'generate': '生成',
  'generated': '生成',
  'refactor': '重构',
  'refactoring': '重构',
  'response': '响应',
  'request': '请求',
  'network': '网络',
  'connection': '连接',
  'cache': '缓存',
  'memory': '内存',
  'storage': '存储',
  'environment': '环境',
  'context': '上下文',
  'suggestion': '建议',
  'suggestions': '建议',
  'predict': '预测',
  'translate': '翻译',
  'translation': '翻译',
  'dictionary': '词典',
  'price': '价格',
  'cost': '费用',
  'tutorial': '教程',
  'guide': '指南',
  'how to': '如何',
  'setup': '配置',
  'configure': '配置',
  'usage': '用法',
  'FAQ': '常见问题',
  'changelog': '更新日志',
  'issue': '问题',
  'issues': '问题',
  'feedback': '反馈',
  'report': '报告',
  'community': '社区',
  'contribute': '贡献',
  'contributing': '贡献指南',
  'donate': '捐赠',
};

// 模块加载时预排序：长词优先 → 每次 localTranslate 不再排序，O(1) 开销
const SORTED_ENTRIES: [string, string][] = Object.entries(DICT)
  .sort((a, b) => b[0].length - a[0].length);

const PAID_KEYS = new Set([
  'paid', 'pricing', 'subscription', 'billing', 'purchase',
  'monthly', 'annually', 'per seat', 'per user', 'per month',
  'starting at', 'starts at', 'freemium', 'trial', 'pro',
  'premium', 'enterprise', 'limited', 'restrictions',
  'watermark', 'ads', 'commercial',
]);

/** 统计中文字符占比（0~1） */
function chineseRatio(text: string): number {
  let ch = 0;
  let total = 0;
  for (const c of text) {
    if (c.trim() === '') continue;
    total++;
    const code = c.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) ch++;
  }
  return total === 0 ? 0 : ch / total;
}

/** 判断译文是否为「真的翻译了」（原文英文 → 译文含中文） */
function isRealTranslation(original: string, translated: string): boolean {
  if (!translated || !translated.trim()) return false;
  // 原文已含较多中文：视为无需翻译，直接认可
  if (chineseRatio(original) > 0.3) return true;
  return chineseRatio(translated) > 0.15;
}

/** 判断文本是否仍以英文为主（用于提示本地词典翻译不完整） */
function isMostlyEnglish(text: string): boolean {
  let en = 0;
  let total = 0;
  for (const c of text) {
    if (c.trim() === '') continue;
    total++;
    const code = c.charCodeAt(0);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) en++;
  }
  return total === 0 ? false : en / total > 0.4;
}

/** 按句子边界切分长文本，避免免费接口 URL 超长 */
function splitTextForTranslate(text: string, max = 1400): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  const sentences = text.split(/(?<=[.!?。！？\n])\s*/);
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > max) {
      parts.push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur) parts.push(cur);
  return parts.length > 0 ? parts : [text];
}

/** 免费在线翻译通道 */
type FreeProvider = 'google' | 'youdao';

interface FreeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** 构建免费翻译接口请求 */
function buildFreeTranslateRequest(provider: FreeProvider, chunk: string): FreeRequest {
  if (provider === 'google') {
    return {
      url:
        'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' +
        encodeURIComponent(chunk),
      method: 'GET',
      headers: { Accept: 'application/json' },
    };
  }
  // 有道翻译 demo 接口（国内可直连，无需 Key）
  return {
    url: 'https://aidemo.youdao.com/trans',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://fanyi.youdao.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
    body: 'q=' + encodeURIComponent(chunk) + '&from=auto&to=zh-CHS',
  };
}

/** 解析免费翻译接口响应，失败抛出异常 */
function parseFreeTranslateResult(provider: FreeProvider, raw: string): string {
  // 容忍响应尾部多余数据（取第一个完整 JSON 对象）
  const trimmed = raw.trim();
  const end = trimmed.lastIndexOf('}');
  const jsonText = end >= 0 ? trimmed.slice(0, end + 1) : trimmed;
  const data = JSON.parse(jsonText);
  if (provider === 'google') {
    const segs = (data?.[0] || []).map((s: any) => (s && s[0]) || '').join('');
    if (!segs) throw new Error('Google 返回为空');
    return segs;
  }
  if (Number(data.errorCode) !== 0) {
    throw new Error('有道 errorCode=' + data.errorCode);
  }
  const segs = ((data.translation || [])[0] || '').toString();
  if (!segs) throw new Error('有道返回为空');
  return segs;
}

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
  for (const kw of PAID_KEYS) {
    if (lowerText.includes(kw)) {
      paidWarning = ' ⚠️[注意收费]';
      break;
    }
  }

  // 长词优先替换（使用预排序数组）
  let result = text;
  for (const [en, zh] of SORTED_ENTRIES) {
    if (zh === en) continue;
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
//  HTTP 辅助 —— 用 Node 18+ 原生 fetch 替代手写 httpRequest
// ============================================================

/**
 * 简易 chunked 编码解码器（代理通道响应可能为分块传输）
 */
function decodeChunkedBody(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const lineEnd = body.indexOf('\r\n', i);
    if (lineEnd < 0) break;
    const sizeStr = body.slice(i, lineEnd).split(';')[0].trim();
    const size = parseInt(sizeStr, 16);
    if (!size) break;
    out += body.slice(lineEnd + 2, lineEnd + 2 + size);
    i = lineEnd + 2 + size + 2; // 跳过数据后的 CRLF
  }
  return out;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    return response;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`请求超时 (${timeoutMs}ms): ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 通过 HTTP CONNECT 代理发送 HTTPS 请求并返回响应体文本。
 * 用于免费在线翻译的代理通道（适配 Clash / 各类本地 HTTP 代理）。
 */
function httpsViaProxy(
  targetUrl: string,
  proxyUrl: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs: number = 8000
): Promise<string> {
  let target: URL;
  let proxy: URL;
  try {
    target = new URL(targetUrl);
    proxy = new URL(proxyUrl);
  } catch {
    return Promise.reject(new Error('代理地址格式错误: ' + proxyUrl));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const proxyReq = http.request({
      hostname: proxy.hostname,
      port: parseInt(proxy.port, 10) || (proxy.protocol === 'https:' ? 443 : 8080),
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      timeout: timeoutMs,
      headers: proxy.username
        ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') }
        : {},
    });

    proxyReq.on('connect', (_res, socket) => {
      const tlsSocket = tls.connect(
        { socket, servername: target.hostname, rejectUnauthorized: true },
        () => {
          const reqHeaders: Record<string, string> = {
            Host: target.hostname,
            Accept: 'application/json',
            Connection: 'close',
            ...headers,
          };
          if (body) {
            reqHeaders['Content-Length'] = String(Buffer.byteLength(body));
          }
          const headLines = Object.entries(reqHeaders)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n');
          tlsSocket.write(
            `${method} ${target.pathname}${target.search} HTTP/1.1\r\n${headLines}\r\n\r\n` +
              (body || '')
          );
        }
      );
      const chunks: Buffer[] = [];
      tlsSocket.on('data', (d: Buffer) => chunks.push(d));
      tlsSocket.on('end', () => {
        const all = Buffer.concat(chunks).toString('utf-8');
        const idx = all.indexOf('\r\n\r\n');
        if (idx < 0) {
          finish(() => reject(new Error('代理响应格式错误')));
          return;
        }
        const headerBlock = all.slice(0, idx);
        let resBody = all.slice(idx + 4);
        const statusMatch = headerBlock.match(/^HTTP\/\d\.\d (\d+)/);
        if (statusMatch && statusMatch[1] !== '200') {
          finish(() => reject(new Error('代理请求失败: HTTP ' + statusMatch[1])));
          return;
        }
        // 处理 Transfer-Encoding: chunked
        if (/transfer-encoding:\s*chunked/i.test(headerBlock)) {
          resBody = decodeChunkedBody(resBody);
        }
        finish(() => resolve(resBody));
      });
      tlsSocket.on('error', (err) => finish(() => reject(err)));
    });

    proxyReq.on('timeout', () => {
      finish(() => reject(new Error(`代理连接超时 (${timeoutMs}ms)`)));
      proxyReq.destroy();
    });
    proxyReq.on('error', (err) => finish(() => reject(err)));
    proxyReq.end();
  });
}