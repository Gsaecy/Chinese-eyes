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

/**
 * 调用 VS Code Marketplace API 查询扩展
 * 这是 VS Code 本身使用的公开 API
 */
/**
 * Marketplace 过滤器类型（与 VS Code 官方 vsce 一致）
 * 1=Tag 4=ExtensionId 5=Category 7=ExtensionName 8=Target 10=SearchText
 */
const FILTER = {
  TAG: 1,
  EXTENSION_ID: 4,
  CATEGORY: 5,
  EXTENSION_NAME: 7,
  TARGET: 8,
  SEARCH_TEXT: 10,
} as const;

function buildRequestBody(
  criteria: any[],
  pageNumber: number,
  pageSize: number,
  sortBy?: string
): string {
  return JSON.stringify({
    filters: [
      {
        criteria,
        pageNumber,
        pageSize,
        sortBy: getSortByValue(sortBy),
        sortOrder: 0,
      },
    ],
    flags: 0x1 | 0x2 | 0x4 | 0x8 | 0x80 | 0x100 | 0x200,
  });
}

function parseResult(data: string): {
  extensions: RawGalleryExtension[];
  total: number;
} {
  const result = JSON.parse(data);
  const rawExtensions: RawGalleryExtension[] = result.results?.[0]?.extensions ?? [];
  const total =
    result.results?.[0]?.resultMetadata?.find(
      (m: any) => m.metadataType === 'ResultCount'
    )?.metadataItems?.[0]?.count ?? 0;
  return { extensions: rawExtensions, total };
}

export async function queryExtensions(
  options: MarketplaceQueryOptions
): Promise<{ extensions: ExtensionItem[]; total: number }> {
  const { text = '', pageNumber = 1, pageSize = DEFAULT_PAGE_SIZE, category, sortBy } = options;

  // 构建查询条件
  const searchText = String(text || '').trim();

  const baseCriteria = (): any[] => {
    const criteria: any[] = [
      { filterType: FILTER.TARGET, value: 'Microsoft.VisualStudio.Code' }, // Target filter
    ];
    if (searchText) {
      // 检测 publisher.extension 格式，按扩展 ID 精确搜索。
      // 注意：ExtensionId(4) 过滤器要求 GUID，不能直接传 ID 字符串；
      // 实测 SearchText(10) 对完整 ID 可精确命中，再在本地做一次精确过滤兜底。
      const idMatch = searchText.match(/^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)$/);
      criteria.push({
        filterType: FILTER.SEARCH_TEXT,
        value: idMatch ? searchText.toLowerCase() : searchText,
      });
    }
    if (category) {
      criteria.push({ filterType: FILTER.CATEGORY, value: category }); // Category filter
    }
    return criteria;
  };

  const data = await httpsPost(
    MARKETPLACE_API_URL,
    buildRequestBody(baseCriteria(), pageNumber, pageSize, sortBy)
  );

  let { extensions: rawExtensions, total } = parseResult(data);

  // publisher.extension 精确搜索：本地再过滤一次，只保留完全匹配的扩展
  const idMatch = searchText.match(/^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)$/);
  if (idMatch && rawExtensions.length > 0) {
    const exact = rawExtensions.filter(
      (e) =>
        (e.publisher?.publisherName + '.' + e.extensionName).toLowerCase() ===
        searchText.toLowerCase()
    );
    if (exact.length > 0) {
      rawExtensions = exact;
      total = exact.length;
    }
  }

  // 多词或含特殊符号的关键词无结果时，用净化后的关键词重试一次，
  // 避免特殊字符/多余空格导致全文搜索失效。
  const isExactId = !!idMatch;
  if (rawExtensions.length === 0 && searchText && !isExactId) {
    const sanitized = searchText
      .replace(/[^\p{L}\p{N}\s._-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (sanitized && sanitized !== searchText) {
      const retryCriteria = [
        { filterType: FILTER.TARGET, value: 'Microsoft.VisualStudio.Code' },
        { filterType: FILTER.SEARCH_TEXT, value: sanitized },
        ...(category ? [{ filterType: FILTER.CATEGORY, value: category }] : []),
      ];
      const retryData = await httpsPost(
        MARKETPLACE_API_URL,
        buildRequestBody(retryCriteria, pageNumber, pageSize, sortBy)
      );
      const retry = parseResult(retryData);
      rawExtensions = retry.extensions;
      total = retry.total;
    }
  }

  const extensions = rawExtensions.map((raw) => rawToExtensionItem(raw));

  return { extensions, total };
}

/**
 * 获取单个扩展的详细信息（含 README）
 */
export async function getExtensionDetail(publisher: string, name: string): Promise<ExtensionItem | null> {
  const { extensions } = await queryExtensions({ text: `${publisher}.${name}`, pageSize: 1 });
  return extensions[0] ?? null;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 本地按真实数值排序（API 的排序值在带搜索词时不可靠） */
export function sortItemsBy(items: ExtensionItem[], sortBy?: string): ExtensionItem[] {
  if (!items || items.length < 2) return items;
  switch (sortBy) {
    case 'downloads':
    case 'installCount':
      return [...items].sort((a, b) => b.installCount - a.installCount);
    case 'rating':
      return [...items].sort(
        (a, b) => (b.ratingScore - a.ratingScore) || (b.ratingCount - a.ratingCount)
      );
    case 'publishedDate':
      return [...items].sort((a, b) => (b.lastUpdated || '').localeCompare(a.lastUpdated || ''));
    default:
      return items;
  }
}

/**
 * 按关键词匹配度重排搜索结果。
 * @param preserveOrder true=稳定分层（相关项保持 API 原序在前、无关项移到后面，适合下载量/评分等排序模式）；false=按匹配度精细排序（适合「相关」模式）
 */
export function reorderByRelevance(items: ExtensionItem[], query: string, preserveOrder = false): ExtensionItem[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (!words.length || items.length < 2) return items;

  // 单词边界匹配，避免 'javascript' 命中 'java'、'postcss' 命中 'css' 之类的子串误判
  const wordHit = (target: string, w: string): boolean =>
    new RegExp('\\b' + escapeRegExp(w) + '\\b', 'i').test(target);

  const score = (item: ExtensionItem): number => {
    const name = (item.displayName || '').toLowerCase();
    const extName = (item.extensionName || '').toLowerCase();
    const id = item.id.toLowerCase();
    const desc = (item.description || '').toLowerCase();
    const tags = (item.tags || []).join(' ').toLowerCase();
    let s = 0;
    for (const w of words) {
      if (extName === w || id === w) s += 10;
      else if (wordHit(name, w) || wordHit(id, w)) s += 5;
      if (wordHit(desc, w)) s += 2;
      if (wordHit(tags, w)) s += 1;
    }
    return s;
  };

  if (preserveOrder) {
    // 稳定分层（V8 sort 稳定，同层保持 API 真实排名顺序）：
    // 标题/ID 含词 > 仅描述/标签含词 > 完全无关
    const titleHit = (item: ExtensionItem): boolean => {
      const name = (item.displayName || '').toLowerCase();
      const extName = (item.extensionName || '').toLowerCase();
      const id = item.id.toLowerCase();
      return words.some((w) => extName === w || id === w || wordHit(name, w) || wordHit(id, w));
    };
    const tier = (item: ExtensionItem): number => (titleHit(item) ? 2 : score(item) > 0 ? 1 : 0);
    return [...items].sort((a, b) => tier(b) - tier(a));
  }
  return [...items].sort((a, b) => score(b) - score(a));
}

/** 将原始 API 数据转换为我们定义的模型 */
function rawToExtensionItem(raw: RawGalleryExtension): ExtensionItem {
  const latestVersion = raw.versions?.[0];
  const files = latestVersion?.files ?? [];

  const iconFile = files.find((f) => f.assetType === 'Microsoft.VisualStudio.Services.Icons.Default');
  const detailFile = files.find((f) => f.assetType === 'Microsoft.VisualStudio.Services.Content.Details');
  const manifestFile = files.find((f) => f.assetType === 'Microsoft.VisualStudio.Code.Manifest');

  const getStat = (name: string): number => {
    return raw.statistics?.find((s: RawGalleryExtensionStatistic) => s.statisticName === name)?.value ?? 0;
  };

  // 判断收费状态
  const tags = raw.tags ?? [];
  const hasPaidTag = tags.some(
    (t) =>
      t.toLowerCase().includes('paid') ||
      t.toLowerCase().includes('pricing') ||
      t.toLowerCase().includes('subscription') ||
      t.toLowerCase().includes('trial')
  );

  // 从 manifest 属性中提取定价信息
  const pricingProp = latestVersion?.properties?.find(
    (p) => p.key === 'Microsoft.VisualStudio.Code.Pricing'
  );
  const pricingInfo = pricingProp?.value;

  // 明确的收费信息存在 → Paid
  // 没有收费信息但有收费标签 → maybePaid
  // 都没有 → Free
  let pricingStatus: 'free' | 'paid' | 'maybePaid';
  if (pricingInfo) {
    pricingStatus = 'paid';
  } else if (hasPaidTag) {
    pricingStatus = 'maybePaid';
  } else {
    pricingStatus = 'free';
  }

  const readmeFile = files.find(
    (f) => f.assetType === 'Microsoft.VisualStudio.Services.Content.Readme'
  );

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
    readmeUrl: readmeFile?.source,
    detailUrl: detailFile?.source,
    repositoryUrl: latestVersion?.properties?.find(
      (p) => p.key === 'Microsoft.VisualStudio.Services.Links.Source'
    )?.value,
    licenseUrl: latestVersion?.properties?.find(
      (p) => p.key === 'Microsoft.VisualStudio.Services.Content.License'
    )?.value,
    lastUpdated: latestVersion?.lastUpdated || raw.lastUpdated,
  };
}

function getSortByValue(sortBy?: string): number {
  switch (sortBy) {
    case 'installCount':
    case 'downloads':
      return 4; // InstallCount（下载量/安装量）
    case 'rating':
      return 6; // AverageRating（真实平均评分从高到低）
    case 'popular':
      return 12; // WeightedRating（评分×评分数加权热度）
    case 'publishedDate':
      return 10; // PublishedDate（最新发布）
    case 'relevance':
    default:
      return 0; // Relevance（相关性）
  }
}

/** 按扩展 ID 精确查询以获取完整文件列表（含 README） */
async function getExtensionFilesById(publisher: string, name: string): Promise<{readmeUrl?: string; detailUrl?: string} | null> {
  try {
    // 精确 ID 搜索（SearchText + 本地过滤，见 queryExtensions）
    const { extensions } = await queryExtensions({
      text: `${publisher}.${name}`,
      pageSize: 1,
    });
    const item = extensions[0];
    if (!item) return null;
    return {
      readmeUrl: item.readmeUrl,
      detailUrl: item.detailUrl,
    };
  } catch (e) {
    console.warn(`[getExtensionFilesById] 失败: ${publisher}.${name}`, e);
    return null;
  }
}

/**
 * CDN 域名降级：中国大陆走 gallerycdn.azure.cn，海外走 gallerycdn.vsassets.io。
 * 返回原 URL 与换域后的候选列表（去重）。
 */
function cdnUrlVariants(url: string): string[] {
  const variants: string[] = [url];
  try {
    const u = new URL(url);
    const parts = u.hostname.split('.gallerycdn.');
    if (parts.length === 2) {
      const regions = ['gallerycdn.azure.cn', 'gallerycdn.vsassets.io', 'gallerycdn.visualstudio.com'];
      for (const region of regions) {
        const alt = new URL(url);
        alt.hostname = parts[0] + '.' + region;
        if (alt.hostname !== u.hostname && !variants.includes(alt.toString())) {
          variants.push(alt.toString());
        }
      }
    }
  } catch {
    // 忽略非法 URL
  }
  return variants;
}

/** 下载 CDN 文件：依次尝试各域名候选，返回第一个成功的内容 */
async function httpsGetWithCdnFallback(url: string): Promise<string> {
  const variants = cdnUrlVariants(url);
  let lastErr: unknown;
  for (const v of variants) {
    try {
      const body = await httpsGet(v);
      if (body && body.trim()) return body;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('所有 CDN 域名下载失败: ' + url);
}

/** 先按 ID 精确查询扩展，再获取 README（Markdown 或 HTML 格式）
 * @param publisher 发布者名称
 * @param name 扩展技术名，如 "prettier-vscode" 
 * @param readmeUrl 可选的 README 直链 URL（优先使用）
 * @param detailUrl 可选的详情内容直链（Content.Details，通常是完整 README）
 */
export async function getExtensionReadme(publisher: string, name: string, readmeUrl?: string, detailUrl?: string): Promise<string> {
  try {
    console.log(`[getExtensionReadme] 开始获取: ${publisher}.${name}, readmeUrl=${readmeUrl}, detailUrl=${detailUrl}`);

    // 1. 如果有直链，直接下载（支持 CDN 域名降级）
    if (readmeUrl) {
      try {
        console.log(`[getExtensionReadme] 通过直链下载: ${readmeUrl}`);
        const readmeResp = await httpsGetWithCdnFallback(readmeUrl);
        console.log(`[getExtensionReadme] 直链响应长度: ${readmeResp.length}`);
        if (readmeResp.trim()) {
          return simpleMarkdownToHtml(readmeResp);
        }
      } catch (e) {
        console.error(`[getExtensionReadme] 直链下载失败: ${readmeUrl}`, e);
      }
    }

    // 2. 按扩展 ID 精确查询（比文本搜索更可靠，且包含完整文件列表）
    console.log(`[getExtensionReadme] 通过 API 查询: ${publisher}.${name}`);
    const files = await getExtensionFilesById(publisher, name);
    console.log(`[getExtensionReadme] API 返回:`, JSON.stringify(files));

    if (files?.readmeUrl) {
      try {
        console.log(`[getExtensionReadme] 下载 README: ${files.readmeUrl}`);
        const readmeResp = await httpsGetWithCdnFallback(files.readmeUrl);
        console.log(`[getExtensionReadme] README 响应长度: ${readmeResp.length}`);
        if (readmeResp.trim()) {
          return simpleMarkdownToHtml(readmeResp);
        }
      } catch (e) {
        console.warn(`[getExtensionReadme] 精确查询 readmeUrl 下载失败`, e);
      }
    }

    // 3. 下载 Content.Details（通常是完整 README 的 Markdown/HTML）
    const detailsUrl = detailUrl || files?.detailUrl;
    if (detailsUrl) {
      try {
        console.log(`[getExtensionReadme] 下载 Details: ${detailsUrl}`);
        const detailResp = await httpsGetWithCdnFallback(detailsUrl);
        console.log(`[getExtensionReadme] Details 响应长度: ${detailResp.length}`);
        if (detailResp.trim()) {
          return simpleMarkdownToHtml(detailResp);
        }
      } catch (e) {
        console.warn(`[getExtensionReadme] detailUrl 下载失败`, e);
      }
    }

    // 4. 最坏情况：用缓存中的扩展描述
    try {
      console.log(`[getExtensionReadme] 回退到描述字段`);
      const { extensions } = await queryExtensions({
        text: `${publisher}.${name}`,
        pageSize: 1,
        sortBy: 'relevance',
      });
      if (extensions.length > 0 && extensions[0].description) {
        console.log(`[getExtensionReadme] 使用描述: ${extensions[0].description.substring(0, 100)}`);
        return `<p>${extensions[0].description}</p>`;
      }
    } catch { /* 忽略 */ }

    console.warn(`[getExtensionReadme] 所有方式都失败了`);
    return '';
  } catch (err) {
    console.error('[getExtensionReadme] 最终失败:', err);
    return '';
  }
}
/** HTTPS POST 请求（使用 tlsCompat 的重试机制自动处理 BAD_DECRYPT） */
async function httpsPost(url: string, data: string): Promise<string> {
  try {
    const res = await httpsRequest(url, 'POST', {
      'Content-Type': 'application/json',
      'Accept': 'application/json;api-version=3.0-preview.1',
      'Accept-Encoding': 'gzip',
    }, data, 30000);
    return res.body;
  } catch (err) {
    console.warn('[marketplaceApi] httpsPost 失败，重置 TLS 缓存后重试:', (err as Error).message);
    resetTlsCache();
    const res = await httpsRequest(url, 'POST', {
      'Content-Type': 'application/json',
      'Accept': 'application/json;api-version=3.0-preview.1',
      'Accept-Encoding': 'gzip',
    }, data, 30000);
    return res.body;
  }
}

/** HTTPS GET 请求（使用 tlsCompat 的重试机制自动处理 BAD_DECRYPT） */
async function httpsGet(url: string): Promise<string> {
  try {
    const res = await httpsRequest(url, 'GET', {
      'Accept': '*/*',
      'Accept-Encoding': 'gzip',
    }, undefined, 30000);
    return res.body;
  } catch (err) {
    console.warn('[marketplaceApi] httpsGet 失败，重置 TLS 缓存后重试:', (err as Error).message);
    resetTlsCache();
    const res = await httpsRequest(url, 'GET', {
      'Accept': '*/*',
      'Accept-Encoding': 'gzip',
    }, undefined, 30000);
    return res.body;
  }
}

/** Markdown → HTML 转换（增强版，支持纯 HTML 透传） */
function simpleMarkdownToHtml(md: string): string {
  // 只有块级容器标签开头才视为 HTML 直接透传，避免误判 Markdown 中内嵌的 <a> <pre> 等
  if (/^\s*<(html|body|div|table|section|article|main|header|footer)\b/i.test(md)) {
    console.log('[simpleMarkdownToHtml] 检测到 HTML 内容，直接透传');
    return md;
  }

  let h = md;
  // 1. 处理代码块 (fenced code blocks) - 必须在其他处理之前
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // 2. 内联代码
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 3. 图片 ![]()
  h = h.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
  // 4. 链接 []()
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // 5. 粗体 **text**
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // 6. 斜体 *text*
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // 7. 标题（按从大到小顺序，避免嵌套冲突）
  h = h.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  h = h.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // 8. 水平线
  h = h.replace(/^---$/gm, '<hr>');
  // 9. 引用 blockquote
  h = h.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  // 10. 列表 - 先统一收集 <li> 再根据上下文决定用 <ul> 或 <ol>
  h = h.replace(/^- (.+)$/gm, '<li>$1</li>');
  h = h.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // 将连续的 <li> 包裹在 <ul> 中
  h = h.replace(/((?:<li>[\s\S]*?<\/li>\s*)+)/g, '<ul>$1</ul>');
  // 11. 表格（简化版）
  h = h.replace(/^\|(.+)\|$/gm, function(match: string) {
    const cells = match.split('|').filter((c: string) => c.trim()).map((c: string) => c.trim());
    // 跳过表头分割行 (|---|)
    if (cells.length > 0 && /^[-: ]+$/.test(cells[0])) return '';
    return '<tr>' + cells.map((c: string) => '<td>' + c + '</td>').join('') + '</tr>';
  });
  h = h.replace(/((?:<tr>.*?<\/tr>\s*)+)/g, '<table>$1</table>');
  // 12. 段落 - 双换行为段落分隔
  let segments = h.split(/\n\n+/);
  h = segments.map((seg: string) => {
    const s = seg.trim();
    if (!s) return '';
    // 如果已经是块级元素，不额外包裹 <p>
    if (/^<(h[1-5]|ul|ol|li|table|tr|td|pre|blockquote|hr|p)/i.test(s)) return s;
    // 清理残留的单个换行
    return '<p>' + s.replace(/\n/g, '<br>') + '</p>';
  }).join('\n');
  return h;
}