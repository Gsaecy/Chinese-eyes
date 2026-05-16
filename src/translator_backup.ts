import * as https from 'https';
import * as http from 'http';
import { TranslationConfig, TranslationProvider } from './types';

/**
 * 翻译服务模块
 * 支持 DeepL、Google Translate、LibreTranslate 和自定义 API
 */
export class Translator {
  private cache = new Map<string, string>();
  private config: TranslationConfig;

  constructor(config: TranslationConfig) {
    this.config = config;
  }

  /** 更新配置 */
  updateConfig(config: TranslationConfig): void {
    this.config = config;
  }

  /** 批量翻译文本 */
  async translateBatch(texts: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const toTranslate: string[] = [];

    for (const text of texts) {
      const cached = this.cache.get(text);
      if (cached) {
        result[text] = cached;
      } else if (text.trim()) {
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
      console.error('翻译失败:', err);
      // 失败时返回原文
      for (const text of toTranslate) {
        result[text] = text;
      }
    }

    return result;
  }

  /** 翻译单段文本 */
  async translate(text: string): Promise<string> {
    const results = await this.translateBatch([text]);
    return results[text] || text;
  }

  /** 清空缓存 */
  clearCache(): void {
    this.cache.clear();
  }

  /** 调用具体的翻译 API */
  private async callTranslationAPI(texts: string[]): Promise<string[]> {
    switch (this.config.provider) {
      case 'deepl':
        return this.translateDeepL(texts);
      case 'google':
        return this.translateGoogle(texts);
      case 'libre':
        return this.translateLibre(texts);
      case 'custom':
        return this.translateCustom(texts);
      default:
        // 默认尝试 DeepL
        return this.translateDeepL(texts);
    }
  }

  /** DeepL API */
  private async translateDeepL(texts: string[]): Promise<string[]> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error('请配置 DeepL API Key（设置: chineseEyes.translation.apiKey）');
    }

    const targetLang = this.config.targetLanguage === 'zh-CN' ? 'ZH' : this.config.targetLanguage.toUpperCase();
    const text = texts.join('\n---\n');

    const data = JSON.stringify({
      text: [text],
      target_lang: targetLang,
    });

    const response = await httpsPost(
      'https://api-free.deepl.com/v2/translate',
      data,
      {
        'Content-Type': 'application/json',
        'Authorization': `DeepL-Auth-Key ${apiKey}`,
      }
    );

    const result = JSON.parse(response);
    const translated = result.translations?.[0]?.text ?? text;
    return translated.split('\n---\n');
  }

  /** Google Cloud Translation API */
  private async translateGoogle(texts: string[]): Promise<string[]> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error('请配置 Google Translate API Key');
    }

    const data = JSON.stringify({
      q: texts,
      target: this.config.targetLanguage || 'zh-CN',
    });

    const response = await httpsPost(
      `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`,
      data,
      { 'Content-Type': 'application/json' }
    );

    const result = JSON.parse(response);
    return result.data?.translations?.map((t: any) => t.translatedText) ?? texts;
  }

  /** LibreTranslate API */
  private async translateLibre(texts: string[]): Promise<string[]> {
    const endpoint = this.config.customEndpoint || 'https://libretranslate.com';
    const data = JSON.stringify({
      q: texts.join('\n---\n'),
      source: 'en',
      target: this.config.targetLanguage || 'zh-CN',
      format: 'text',
    });

    const response = await httpsPost(
      `${endpoint}/translate`,
      data,
      {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      }
    );

    const result = JSON.parse(response);
    const translated = result.translatedText ?? texts.join('\n---\n');
    return translated.split('\n---\n');
  }

  /** 自定义翻译 API */
  private async translateCustom(texts: string[]): Promise<string[]> {
    const endpoint = this.config.customEndpoint;
    if (!endpoint) {
      throw new Error('请配置自定义翻译 API 地址（设置: chineseEyes.translation.customEndpoint）');
    }

    const data = JSON.stringify({
      texts,
      source: 'en',
      target: this.config.targetLanguage || 'zh-CN',
      model: this.config.customModel || undefined,
    });

    const urlObj = new URL(endpoint);
    const isHttps = urlObj.protocol === 'https:';

    const response = await httpRequest(
      endpoint,
      'POST',
      data,
      {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      isHttps
    );

    const result = JSON.parse(response);
    // 支持多种自定义 API 返回格式
    return result.translations ?? result.data ?? result;
  }
}

/** HTTP/HTTPS 请求辅助函数 */
function httpsPost(
  url: string,
  data: string,
  headers: Record<string, string>
): Promise<string> {
  const urlObj = new URL(url);
  return httpRequest(url, 'POST', data, headers, urlObj.protocol === 'https:');
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
    const module = useHttps ? https : http;

    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      port: urlObj.port || (useHttps ? 443 : 80),
      method,
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 30000,
    };

    const req = module.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const result = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip') {
          try {
            const zlib = require('zlib');
            zlib.gunzip(result, (err: Error | null, decompressed: Buffer) => {
              if (err) reject(err);
              else resolve(decompressed.toString('utf-8'));
            });
          } catch (e) {
            reject(e);
          }
        } else {
          resolve(result.toString('utf-8'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });

    req.write(data);
    req.end();
  });
}
