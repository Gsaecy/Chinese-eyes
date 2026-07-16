import { httpsRequest, resetTlsCache } from './tlsCompat';
import {
  RawGalleryExtension,
  RawGalleryExtensionStatistic,
  ExtensionItem,
  MarketplaceQueryOptions,
} from './types';

/** VS Code Marketplace 公开 API 地址 */
const MARKETPLACE_API_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';

/** 每页数量 */
const DEFAULT_PAGE_SIZE = 30;

const CONTENT_DETAILS = 'Microsoft.VisualStudio.Services.Content.Details';
const CONTENT_README = 'Microsoft.VisualStudio.Services.Content.Readme';

export interface MarketplaceHttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export type MarketplaceRequest = (
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  timeout?: number,
) => Promise<MarketplaceHttpResponse>;

export interface MarketplaceApiDependencies {
  request?: MarketplaceRequest;
  resetTls?: () => void;
}

export interface ExtensionContentAssets {
  detailUrl?: string;
  readmeUrl?: string;
  description?: string;
}

export interface ExtensionFileResult extends ExtensionContentAssets {
  description?: string;
}

export class MarketplaceHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly url: string,
    public readonly responseBody: string,
  ) {
    super(`HTTP ${statusCode}: ${url}${responseBody ? ` - ${responseBody.slice(0, 200)}` : ''}`);
    this.name = 'MarketplaceHttpError';
  }
}

/**
 * Marketplace 客户端。生产环境使用 tlsCompat，测试可注入无网络传输层。
 */
export class MarketplaceClient {
  private readonly request: MarketplaceRequest;
  private readonly resetTls: () => void;

  constructor(dependencies: MarketplaceApiDependencies = {}) {
    this.request = dependencies.request ?? httpsRequest;
    this.resetTls = dependencies.resetTls ?? resetTlsCache;
  }

  /** 调用 VS Code Marketplace API 查询扩展。 */
  async queryExtensions(
    options: MarketplaceQueryOptions,
  ): Promise<{ extensions: ExtensionItem[]; total: number }> {
    const { text = '', pageNumber = 1, pageSize = DEFAULT_PAGE_SIZE, category, sortBy } = options;
    const criteria: Array<{ filterType: number; value: string }> = [
      { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
    ];

    if (text) {
      const idMatch = text.match(/^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)$/);
      criteria.push({ filterType: idMatch ? 7 : 1, value: text });
    }

    if (category) {
      criteria.push({ filterType: 5, value: category });
    }

    const requestBody = JSON.stringify({
      filters: [{
        criteria,
        pageNumber,
        pageSize,
        sortBy: getSortByValue(sortBy),
        sortOrder: 0,
      }],
      flags: 0x1 | 0x2 | 0x4 | 0x8 | 0x80 | 0x100 | 0x200,
    });

    const data = await this.requestText(MARKETPLACE_API_URL, 'POST', requestBody);
    const result = JSON.parse(data);
    const rawExtensions: RawGalleryExtension[] = result.results?.[0]?.extensions ?? [];
    const total = result.results?.[0]?.resultMetadata?.find(
      (metadata: { metadataType?: string }) => metadata.metadataType === 'ResultCount',
    )?.metadataItems?.[0]?.count ?? 0;

    return {
      extensions: rawExtensions.map(rawToExtensionItem),
      total,
    };
  }

  async getExtensionDetail(publisher: string, name: string): Promise<ExtensionItem | null> {
    const { extensions } = await this.queryExtensions({ text: `${publisher}.${name}`, pageSize: 1 });
    return extensions[0] ?? null;
  }

  /** 按 publisher.extension 精确查询最新版本的内容资源。 */
  async getExtensionFilesById(publisher: string, name: string): Promise<ExtensionFileResult | null> {
    try {
      const extensionId = `${publisher}.${name}`;
      const requestBody = JSON.stringify({
        filters: [{
          criteria: [
            { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
            { filterType: 7, value: extensionId },
          ],
          pageNumber: 1,
          pageSize: 1,
          sortBy: 0,
          sortOrder: 0,
        }],
        flags: 0x1 | 0x2 | 0x4 | 0x8 | 0x80 | 0x100,
      });

      const data = await this.requestText(MARKETPLACE_API_URL, 'POST', requestBody);
      const result = JSON.parse(data);
      const rawExtensions: RawGalleryExtension[] = result.results?.[0]?.extensions ?? [];
      const requestedId = extensionId.toLowerCase();
      const raw = rawExtensions.find((candidate) =>
        `${candidate.publisher.publisherName}.${candidate.extensionName}`.toLowerCase() === requestedId,
      );
      if (!raw) return null;

      const files = raw.versions?.[0]?.files ?? [];
      return {
        detailUrl: files.find((file) => file.assetType === CONTENT_DETAILS)?.source,
        readmeUrl: files.find((file) => file.assetType === CONTENT_README)?.source,
        description: raw.shortDescription || undefined,
      };
    } catch (error) {
      console.warn(`[getExtensionFilesById] 失败: ${publisher}.${name}`, error);
      return null;
    }
  }

  /**
   * 获取 README 原始 Markdown（兼容 Markdown/HTML 混排），不在数据层转换 HTML。
   */
  async getExtensionReadme(
    publisher: string,
    name: string,
    assets: ExtensionContentAssets | string = {},
  ): Promise<string> {
    const provided = typeof assets === 'string' ? { readmeUrl: assets } : assets;
    const triedUrls = new Set<string>();

    const tryContentUrl = async (url: string | undefined, label: string): Promise<string> => {
      if (!url || triedUrls.has(url)) return '';
      triedUrls.add(url);
      try {
        const content = await this.requestText(url, 'GET');
        if (content.trim()) return content;
      } catch (error) {
        console.warn(`[getExtensionReadme] ${label} 下载失败: ${url}`, error);
      }
      return '';
    };

    // Content.Details 是 Marketplace 详情页的主要内容资源。
    let content = await tryContentUrl(provided.detailUrl, 'Content.Details');
    if (content) return content;

    const exact = await this.getExtensionFilesById(publisher, name);
    content = await tryContentUrl(exact?.detailUrl, 'Content.Details');
    if (content) return content;

    content = await tryContentUrl(provided.readmeUrl, 'Content.Readme');
    if (content) return content;

    content = await tryContentUrl(exact?.readmeUrl, 'Content.Readme');
    if (content) return content;

    if (exact?.description?.trim()) return exact.description;
    return provided.description?.trim() ? provided.description : '';
  }

  /** 执行请求，检查状态码，仅对瞬态错误额外重试一次。 */
  async requestText(url: string, method: 'GET' | 'POST', body?: string): Promise<string> {
    const headers: Record<string, string> = method === 'POST'
      ? {
          'Content-Type': 'application/json',
          'Accept': 'application/json;api-version=3.0-preview.1',
          'Accept-Encoding': 'gzip',
        }
      : {
          'Accept': '*/*',
          'Accept-Encoding': 'gzip',
        };

    for (let attempt = 0; attempt < 2; attempt++) {
      let response: MarketplaceHttpResponse;
      try {
        response = await this.request(url, method, headers, body, 30000);
      } catch (error) {
        if (attempt === 0) {
          console.warn(`[marketplaceApi] ${method} 传输失败，重置 TLS 后重试:`, (error as Error).message);
          this.resetTls();
          continue;
        }
        throw error;
      }

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return response.body;
      }

      const error = new MarketplaceHttpError(response.statusCode, url, response.body);
      if (attempt === 0 && isRetryableStatus(response.statusCode)) {
        console.warn(`[marketplaceApi] ${method} HTTP ${response.statusCode}，重试一次: ${url}`);
        continue;
      }
      throw error;
    }

    throw new Error(`请求失败: ${url}`);
  }
}

const defaultClient = new MarketplaceClient();

export function queryExtensions(
  options: MarketplaceQueryOptions,
): Promise<{ extensions: ExtensionItem[]; total: number }> {
  return defaultClient.queryExtensions(options);
}

export function getExtensionDetail(publisher: string, name: string): Promise<ExtensionItem | null> {
  return defaultClient.getExtensionDetail(publisher, name);
}

export function getExtensionFilesById(
  publisher: string,
  name: string,
): Promise<ExtensionFileResult | null> {
  return defaultClient.getExtensionFilesById(publisher, name);
}

export function getExtensionReadme(
  publisher: string,
  name: string,
  assets: ExtensionContentAssets | string = {},
): Promise<string> {
  return defaultClient.getExtensionReadme(publisher, name, assets);
}

function rawToExtensionItem(raw: RawGalleryExtension): ExtensionItem {
  const latestVersion = raw.versions?.[0];
  const files = latestVersion?.files ?? [];
  const iconFile = files.find((file) => file.assetType === 'Microsoft.VisualStudio.Services.Icons.Default');
  const detailFile = files.find((file) => file.assetType === CONTENT_DETAILS);
  const readmeFile = files.find((file) => file.assetType === CONTENT_README);

  const getStat = (name: string): number =>
    raw.statistics?.find((stat: RawGalleryExtensionStatistic) => stat.statisticName === name)?.value ?? 0;

  const tags = raw.tags ?? [];
  const hasPaidTag = tags.some((tag) => {
    const normalized = tag.toLowerCase();
    return normalized.includes('paid') ||
      normalized.includes('pricing') ||
      normalized.includes('subscription') ||
      normalized.includes('trial');
  });
  const pricingInfo = latestVersion?.properties?.find(
    (property) => property.key === 'Microsoft.VisualStudio.Code.Pricing',
  )?.value;
  const pricingStatus = pricingInfo ? 'paid' : hasPaidTag ? 'maybePaid' : 'free';

  return {
    id: `${raw.publisher.publisherName}.${raw.extensionName}`,
    extensionName: raw.extensionName,
    displayName: raw.displayName || raw.extensionName,
    publisher: raw.publisher.publisherName,
    publisherDisplayName: raw.publisher.displayName,
    description: raw.shortDescription || '',
    version: latestVersion?.version ?? '',
    installCount: getStat('install'),
    ratingScore: getStat('averagerating'),
    ratingCount: getStat('ratingcount'),
    categories: raw.categories ?? [],
    tags,
    iconUrl: iconFile?.source,
    pricingStatus,
    pricingInfo,
    detailUrl: detailFile?.source,
    readmeUrl: readmeFile?.source,
    repositoryUrl: latestVersion?.properties?.find(
      (property) => property.key === 'Microsoft.VisualStudio.Services.Links.Source',
    )?.value,
    licenseUrl: latestVersion?.properties?.find(
      (property) => property.key === 'Microsoft.VisualStudio.Services.Content.License',
    )?.value,
    lastUpdated: latestVersion?.lastUpdated || raw.lastUpdated,
  };
}

function getSortByValue(sortBy?: string): number {
  switch (sortBy) {
    case 'installCount': return 4;
    case 'rating': return 12;
    case 'publishedDate': return 10;
    default: return 0;
  }
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}
