/** VS Code Marketplace API 返回的原始扩展数据类型 */
export interface RawGalleryExtension {
  extensionId: string;
  extensionName: string;
  displayName: string;
  shortDescription?: string;
  publisher: {
    publisherId: string;
    publisherName: string;
    displayName: string;
  };
  versions: RawGalleryExtensionVersion[];
  statistics: RawGalleryExtensionStatistic[];
  tags: string[] | undefined;
  categories: string[] | undefined;
  releaseDate: string;
  publishedDate: string;
  lastUpdated: string;
  flags: string;
}

export interface RawGalleryExtensionVersion {
  version: string;
  lastUpdated: string;
  assetUri: string;
  files: {
    assetType: string;
    source: string;
  }[];
  properties: {
    key: string;
    value: string;
  }[];
}

export interface RawGalleryExtensionStatistic {
  statisticName: string;
  value: number;
}

/** 收费状态枚举 */
export type PricingStatus = 'free' | 'paid' | 'maybePaid';

/** 我们处理后的扩展数据模型 */
export interface ExtensionItem {
  /** 唯一标识，如 "publisher.name" */
  id: string;
  /** 显示名称（原始英文） */
  displayName: string;
  /** 发布者 */
  publisher: string;
  /** 发布者显示名 */
  publisherDisplayName: string;
  /** 简短描述（原始英文） */
  description: string;
  /** 简短描述（中文翻译） */
  descriptionZh?: string;
  /** 版本号 */
  version: string;
  /** 安装量统计 */
  installCount: number;
  /** 评分 */
  ratingScore: number;
  /** 评分人数 */
  ratingCount: number;
  /** 分类 */
  categories: string[];
  /** 标签 */
  tags: string[];
  /** 图标 URL */
  iconUrl?: string;
  /** 收费状态 */
  pricingStatus: PricingStatus;
  /** 定价信息原始文本 */
  pricingInfo?: string;
  /** 详细页 URL */
  detailUrl?: string;
  /** 仓库 URL */
  repositoryUrl?: string;
  /** 许可证 URL */
  licenseUrl?: string;
  /** README 文件 URL */
  readmeUrl?: string;
}

/** 翻译服务提供商枚举 */
export type TranslationProvider = 'local' | 'deepl' | 'google' | 'libre' | 'custom' | 'deepseek';

/** 翻译服务配置 */
export interface TranslationConfig {
  provider: TranslationProvider;
  apiKey: string;
  customEndpoint?: string;
  customModel?: string;
  targetLanguage: string;
}

/** Marketplace API 查询选项 */
export interface MarketplaceQueryOptions {
  text?: string;
  pageNumber?: number;
  pageSize?: number;
  category?: string;
  sortBy?: 'installCount' | 'rating' | 'publishedDate' | 'relevance';
}

/** Webview 与扩展之间通信的消息协议 */
export type MessageFromWebview =
  | { type: 'search'; query: string }
  | { type: 'loadMore' }
  | { type: 'install'; extensionId: string }
  | { type: 'openDetail'; extensionId: string }
  | { type: 'getDetail'; extensionId: string }
  | { type: 'translate'; texts: string[] }
  | { type: 'ready' };

export type MessageToWebview =
  | { type: 'searchResults'; items: ExtensionItem[]; hasMore: boolean; total: number }
  | { type: 'moreResults'; items: ExtensionItem[]; hasMore: boolean }
  | { type: 'detail'; item: ExtensionItem }
  | { type: 'translations'; data: Record<string, string> }
  | { type: 'error'; message: string };