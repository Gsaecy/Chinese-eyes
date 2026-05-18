import { httpsRequest } from './tlsCompat';
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
export async function queryExtensions(
  options: MarketplaceQueryOptions
): Promise<{ extensions: ExtensionItem[]; total: number }> {
  const { text = '', pageNumber = 1, pageSize = DEFAULT_PAGE_SIZE, category, sortBy } = options;

  // 构建查询条件
  const criteria: any[] = [
    { filterType: 8, value: 'Microsoft.VisualStudio.Code' }, // Target filter
  ];

  if (text) {
    criteria.push({ filterType: 1, value: text }); // Search text
  }

  if (category) {
    criteria.push({ filterType: 5, value: category }); // Category filter
  }

  // 构建请求体
  const requestBody = JSON.stringify({
    filters: [
      {
        criteria,
        pageNumber,
        pageSize,
        sortBy: getSortByValue(sortBy),
        sortOrder: 0,
      },
    ],
    flags: 0x1 | 0x2 | 0x4 | 0x8 | 0x80,
  });

  const data = await httpsPost(MARKETPLACE_API_URL, requestBody);

  const result = JSON.parse(data);
  const rawExtensions: RawGalleryExtension[] = result.results?.[0]?.extensions ?? [];

  // 解析总数
  const total =
    result.results?.[0]?.resultMetadata?.find(
      (m: any) => m.metadataType === 'ResultCount'
    )?.metadataItems?.[0]?.count ?? 0;

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
      return 4; // InstallCount
    case 'rating':
      return 12; // AverageRating
    case 'publishedDate':
      return 10; // PublishedDate
    case 'relevance':
    default:
      return 0; // Relevance
  }
}

/** 按扩展 ID 精确查询以获取完整文件列表（含 README） */
async function getExtensionFilesById(publisher: string, name: string): Promise<{readmeUrl?: string; detailUrl?: string} | null> {
  try {
    // POST 请求，按扩展 ID 精确过滤
    const requestBody = JSON.stringify({
      filters: [{
        criteria: [
          { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
          { filterType: 4, value: `${publisher}.${name}` },
        ],
        pageNumber: 1,
        pageSize: 1,
        sortBy: 0,
        sortOrder: 0,
      }],
      flags: 0x1 | 0x2 | 0x4 | 0x8 | 0x80,
    });

    const data = await httpsPost(MARKETPLACE_API_URL, requestBody);
    const result = JSON.parse(data);
    const rawExtensions: RawGalleryExtension[] = result.results?.[0]?.extensions ?? [];
    if (rawExtensions.length === 0) return null;

    const files = rawExtensions[0].versions?.[0]?.files ?? [];
    const readmeFile = files.find(
      (f: any) => f.assetType === 'Microsoft.VisualStudio.Services.Content.Readme'
    );
    const detailFile = files.find(
      (f: any) => f.assetType === 'Microsoft.VisualStudio.Services.Content.Details'
    );
    return {
      readmeUrl: readmeFile?.source,
      detailUrl: detailFile?.source,
    };
  } catch (e) {
    console.warn(`[getExtensionFilesById] 失败: ${publisher}.${name}`, e);
    return null;
  }
}

/** 先按 ID精确查询扩展，再获取 README（HTML 格式）
 * @param publisher 发布者名称
 * @param name 扩展技术名，如 "prettier-vscode" 
 * @param readmeUrl 可选的 README 直链 URL（优先使用）
 */
export async function getExtensionReadme(publisher: string, name: string, readmeUrl?: string): Promise<string> {
  try {
    // 1. 如果有直链，直接下载
    if (readmeUrl) {
      try {
        const readmeResp = await httpsGet(readmeUrl);
        if (readmeResp.trim()) {
          return simpleMarkdownToHtml(readmeResp);
        }
      } catch (e) {
        console.error(`[getExtensionReadme] 直链下载失败: ${readmeUrl}`, e);
      }
    }

    // 2. 按扩展 ID 精确查询（比文本搜索更可靠，且包含完整文件列表）
    const files = await getExtensionFilesById(publisher, name);
    if (files?.readmeUrl) {
      try {
        const readmeResp = await httpsGet(files.readmeUrl);
        if (readmeResp.trim()) {
          return simpleMarkdownToHtml(readmeResp);
        }
      } catch (e) {
        console.warn(`[getExtensionReadme] 精确查询 readmeUrl 下载失败`, e);
      }
    }
    // 3. 备用：尝试获取长描述（Content.Details），几乎每个扩展都有
    if (files?.detailUrl) {
      try {
        const detailResp = await httpsGet(files.detailUrl);
        if (detailResp.trim()) {
          return simpleMarkdownToHtml(detailResp);
        }
      } catch (e) {
        console.warn(`[getExtensionReadme] detailUrl 下载失败`, e);
      }
    }

    // 4. 最坏情况：用缓存中的扩展描述
    try {
      const { extensions } = await queryExtensions({
        text: `${publisher}.${name}`,
        pageSize: 1,
        sortBy: 'relevance',
      });
      if (extensions.length > 0 && extensions[0].description) {
        return `<p>${extensions[0].description}</p>`;
      }
    } catch { /* 忽略 */ }

    return '';
  } catch (err) {
    console.error('[getExtensionReadme] 最终失败:', err);
    return '';
  }
}
/** HTTPS POST 请求（使用 tlsCompat 的重试机制自动处理 BAD_DECRYPT） */
function httpsPost(url: string, data: string): Promise<string> {
  return httpsRequest(url, 'POST', {
    'Content-Type': 'application/json',
    'Accept': 'application/json;api-version=3.0-preview.1',
    'Accept-Encoding': 'gzip',
  }, data, 30000).then(res => res.body);
}

/** HTTPS GET 请求（使用 tlsCompat 的重试机制自动处理 BAD_DECRYPT） */
function httpsGet(url: string): Promise<string> {
  return httpsRequest(url, 'GET', {
    'Accept': '*/*',
    'Accept-Encoding': 'gzip',
  }, undefined, 30000).then(res => res.body);
}

/** Markdown → HTML 转换（增强版，支持纯 HTML 透传） */
function simpleMarkdownToHtml(md: string): string {
  // 如果已经是 HTML 内容（包含标签），直接返回
  if (/<html|<body|<div|<p|<h[1-6]|<table|<pre|<img|<a|<ul|<ol/i.test(md)) {
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