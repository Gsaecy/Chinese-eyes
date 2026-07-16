import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const markdownRenderer = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
});

const allowedTags = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt',
  'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'kbd', 'li', 'ol', 'p',
  'pre', 's', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'u', 'ul',
];

const sanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags,
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    code: ['class'],
    th: ['align', 'colspan', 'rowspan'],
    td: ['align', 'colspan', 'rowspan'],
    details: ['open'],
  },
  allowedClasses: {
    code: [/^language-[a-z0-9_-]+$/i],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    img: ['http', 'https'],
  },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nonTextTags: ['style', 'script', 'textarea', 'option', 'iframe'],
};

export interface RenderedMarkdown {
  markdown: string;
  html: string;
}

export interface MarkdownTranslator {
  translateMarkdown(markdown: string): Promise<string>;
}

/** 将 Markdown/HTML 混排文档统一渲染并在进入 webview 前净化。 */
export function renderMarkdown(markdown: string): string {
  if (!markdown) return '';
  const rendered = markdownRenderer.render(markdown);
  return sanitizeHtml(rendered, sanitizeOptions);
}

export function prepareMarkdown(markdown: string): RenderedMarkdown {
  return {
    markdown,
    html: renderMarkdown(markdown),
  };
}

/** 保证翻译器接收原始 Markdown，译文仍以 Markdown 保存。 */
export async function translateMarkdownDocument(
  sourceMarkdown: string,
  translator: MarkdownTranslator,
): Promise<RenderedMarkdown> {
  const translatedMarkdown = await translator.translateMarkdown(sourceMarkdown);
  return prepareMarkdown(translatedMarkdown);
}
