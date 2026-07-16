import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MarketplaceClient,
  MarketplaceHttpError,
  MarketplaceHttpResponse,
  MarketplaceRequest,
} from '../marketplaceApi';
import { renderMarkdown, translateMarkdownDocument } from '../readmePipeline';
import { Translator } from '../translator';
import { RawGalleryExtension } from '../types';

function response(statusCode: number, body = ''): MarketplaceHttpResponse {
  return { statusCode, headers: {}, body };
}

function rawExtension(
  files: Array<{ assetType: string; source: string }> = [],
  shortDescription = 'Fallback description',
): RawGalleryExtension {
  return {
    extensionId: 'extension-id',
    extensionName: 'sample',
    displayName: 'Sample',
    shortDescription,
    publisher: {
      publisherId: 'publisher-id',
      publisherName: 'publisher',
      displayName: 'Publisher',
    },
    versions: [{
      version: '1.0.0',
      lastUpdated: '2026-01-01T00:00:00Z',
      assetUri: 'https://example.test/assets',
      files,
      properties: [],
    }],
    statistics: [],
    tags: [],
    categories: [],
    releaseDate: '2026-01-01T00:00:00Z',
    publishedDate: '2026-01-01T00:00:00Z',
    lastUpdated: '2026-01-01T00:00:00Z',
    flags: 'validated',
  };
}

function queryResponse(extension: RawGalleryExtension): string {
  return JSON.stringify({
    results: [{
      extensions: [extension],
      resultMetadata: [],
    }],
  });
}

test('getExtensionFilesById uses ExtensionName filterType 7 for an exact ID query', async () => {
  let postedBody = '';
  const request: MarketplaceRequest = async (_url, method, _headers, body) => {
    assert.equal(method, 'POST');
    postedBody = body || '';
    return response(200, queryResponse(rawExtension()));
  };
  const client = new MarketplaceClient({ request });

  await client.getExtensionFilesById('publisher', 'sample');

  const parsed = JSON.parse(postedBody) as {
    filters: Array<{ criteria: Array<{ filterType: number; value: string }> }>;
  };
  assert.deepEqual(parsed.filters[0].criteria, [
    { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
    { filterType: 7, value: 'publisher.sample' },
  ]);
  assert.equal(parsed.filters[0].criteria.some((criterion) => criterion.filterType === 4), false);
});

test('getExtensionReadme prefers Content.Details without an unnecessary exact query', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const request: MarketplaceRequest = async (url, method) => {
    calls.push({ url, method });
    return response(200, '# Details Markdown');
  };
  const client = new MarketplaceClient({ request });

  const markdown = await client.getExtensionReadme('publisher', 'sample', {
    detailUrl: 'https://example.test/details',
    readmeUrl: 'https://example.test/readme',
  });

  assert.equal(markdown, '# Details Markdown');
  assert.deepEqual(calls, [{ url: 'https://example.test/details', method: 'GET' }]);
});

test('getExtensionReadme falls back from Details to Readme and deduplicates URLs', async () => {
  const detailsUrl = 'https://example.test/details';
  const readmeUrl = 'https://example.test/readme';
  const calls: Array<{ url: string; method: string }> = [];
  const extension = rawExtension([
    { assetType: 'Microsoft.VisualStudio.Services.Content.Details', source: detailsUrl },
    { assetType: 'Microsoft.VisualStudio.Services.Content.Readme', source: readmeUrl },
  ]);
  const request: MarketplaceRequest = async (url, method) => {
    calls.push({ url, method });
    if (method === 'POST') return response(200, queryResponse(extension));
    if (url === detailsUrl) return response(404, 'missing');
    if (url === readmeUrl) return response(200, '## Readme fallback');
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  const client = new MarketplaceClient({ request });

  const markdown = await client.getExtensionReadme('publisher', 'sample', {
    detailUrl: detailsUrl,
  });

  assert.equal(markdown, '## Readme fallback');
  assert.equal(calls.filter((call) => call.url === detailsUrl).length, 1);
  assert.equal(calls.filter((call) => call.url === readmeUrl).length, 1);
});

test('getExtensionReadme returns the short description as raw Markdown fallback', async () => {
  const request: MarketplaceRequest = async () =>
    response(200, queryResponse(rawExtension([], '**Fallback** description')));
  const client = new MarketplaceClient({ request });

  const markdown = await client.getExtensionReadme('publisher', 'sample');

  assert.equal(markdown, '**Fallback** description');
  assert.equal(markdown.includes('<p>'), false);
});

test('getExtensionReadme falls back to the provided description when the exact query fails', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const client = new MarketplaceClient({
    request: async (url, method) => {
      calls.push({ url, method });
      return response(404, 'missing');
    },
  });

  const markdown = await client.getExtensionReadme('publisher', 'sample', {
    detailUrl: 'https://example.test/details',
    description: '**Known** description',
  });

  assert.equal(markdown, '**Known** description');
  assert.equal(calls.filter((call) => call.method === 'GET').length, 1);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

for (const statusCode of [400, 404]) {
  test(`HTTP ${statusCode} is rejected without retry`, async () => {
    let calls = 0;
    const client = new MarketplaceClient({
      request: async () => {
        calls++;
        return response(statusCode, 'client error');
      },
    });

    await assert.rejects(
      client.requestText('https://example.test/content', 'GET'),
      (error: unknown) => error instanceof MarketplaceHttpError && error.statusCode === statusCode,
    );
    assert.equal(calls, 1);
  });
}

test('HTTP 500 is retried once', async () => {
  let calls = 0;
  const client = new MarketplaceClient({
    request: async () => {
      calls++;
      return calls === 1 ? response(500, 'temporary') : response(200, 'recovered');
    },
  });

  assert.equal(await client.requestText('https://example.test/content', 'GET'), 'recovered');
  assert.equal(calls, 2);
});

for (const statusCode of [400, 404]) {
  test(`getExtensionReadme does not repeat an exact query after HTTP ${statusCode}`, async () => {
    let calls = 0;
    const client = new MarketplaceClient({
      request: async () => {
        calls++;
        return response(statusCode, 'client error');
      },
    });

    assert.equal(await client.getExtensionReadme('publisher', 'sample'), '');
    assert.equal(calls, 1);
  });
}

test('getExtensionReadme limits a persistent HTTP 500 to one retry', async () => {
  let calls = 0;
  const client = new MarketplaceClient({
    request: async () => {
      calls++;
      return response(500, 'temporary server error');
    },
  });

  assert.equal(await client.getExtensionReadme('publisher', 'sample'), '');
  assert.equal(calls, 2);
});

test('renderMarkdown renders ordinary Markdown', () => {
  const html = renderMarkdown('# Heading\n\nA **bold** paragraph.');
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
});

test('renderMarkdown supports an HTML image in the middle of Markdown', () => {
  const html = renderMarkdown(
    '# Before\n\n<img src="https://example.test/image.png" alt="badge">\n\n## After',
  );
  assert.match(html, /<h1>Before<\/h1>/);
  assert.match(html, /<img src="https:\/\/example\.test\/image\.png" alt="badge" \/>/);
  assert.match(html, /<h2>After<\/h2>/);
});

test('renderMarkdown supports documents beginning with an HTML badge or paragraph', () => {
  const badgeDocument = '<img src="https://example.test/badge.svg" alt="badge">\n\n# Markdown title';
  const paragraphDocument = '<p>HTML introduction</p>\n\n- Markdown item';

  assert.match(renderMarkdown(badgeDocument), /<h1>Markdown title<\/h1>/);
  assert.match(renderMarkdown(paragraphDocument), /<ul>[\s\S]*<li>Markdown item<\/li>[\s\S]*<\/ul>/);
});

test('renderMarkdown renders tables, code blocks, lists, and links', () => {
  const markdown = [
    '| Name | Value |',
    '| --- | --- |',
    '| one | two |',
    '',
    '```ts',
    'const value = 1 < 2;',
    '```',
    '',
    '1. First',
    '2. Second',
    '',
    '[Docs](https://example.test/docs)',
  ].join('\n');
  const html = renderMarkdown(markdown);

  assert.match(html, /<table>/);
  assert.match(html, /<code class="language-ts">/);
  assert.match(html, /1 &lt; 2/);
  assert.match(html, /<ol>/);
  assert.match(html, /href="https:\/\/example\.test\/docs"/);
});

test('renderMarkdown removes active content, event handlers, styles, and dangerous URL protocols', () => {
  const malicious = [
    '<script>alert("script")</script>',
    '<style>body{display:none}</style>',
    '<iframe src="https://example.test/frame">hidden frame</iframe>',
    '<img src="javascript:alert(1)" onclick="steal()" style="display:none" alt="bad">',
    '<a href="javascript:alert(2)" onclick="steal()">bad link</a>',
    '[bad markdown link](javascript:alert(3))',
  ].join('\n\n');
  const html = renderMarkdown(malicious);

  assert.doesNotMatch(html, /<(script|style|iframe)\b/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /(href|src)="\s*javascript:/i);
  assert.doesNotMatch(html, /alert\("script"\)|body\{display:none\}|hidden frame/);
});

test('translation receives raw Markdown and preserves document structure', async () => {
  const source = [
    '# Title',
    '',
    '<img src="https://example.test/image.png" alt="image">',
    '',
    '- Install the extension',
    '',
    '| Name | Value |',
    '| --- | --- |',
    '| mode | fast |',
    '',
    '```sh',
    'code --install-extension publisher.sample',
    '```',
    '',
    '[Documentation](https://example.test/docs)',
  ].join('\n');
  let received = '';
  const translated = await translateMarkdownDocument(source, {
    async translateMarkdown(markdown: string): Promise<string> {
      received = markdown;
      return markdown
        .replace('# Title', '# 标题')
        .replace('Install the extension', '安装扩展')
        .replace('Documentation', '文档');
    },
  });

  assert.equal(received, source);
  for (const structuralToken of ['# ', '<img ', '- ', '| --- |', '```sh', '](https://']) {
    assert.equal(source.includes(structuralToken), true);
    assert.equal(translated.markdown.includes(structuralToken), true);
  }
  assert.match(translated.html, /<h1>标题<\/h1>/);
  assert.match(translated.html, /<pre><code class="language-sh">/);
});

test('the real local translator preserves HTML tags, code, and URL destinations', async () => {
  const source = [
    '<table>',
    '<tr><td>install package</td></tr>',
    '</table>',
    '',
    '```sh',
    'npm install package',
    '```',
    '',
    '[install package](https://example.test/install/package)',
    '',
    '[install package][install-package]',
    '',
    '[install-package]: ./install/package "install package"',
    '',
    '<img',
    '  src="https://example.test/install/package.png"',
    '  alt="install package">',
  ].join('\n');
  const translator = new Translator({ provider: 'local' });

  const translated = await translator.translateMarkdown(source);

  assert.match(translated, /<table>[\s\S]*<\/table>/);
  assert.equal(translated.includes('<表格>'), false);
  assert.match(translated, /```sh\nnpm install package\n```/);
  assert.match(translated, /\(https:\/\/example\.test\/install\/package\)/);
  assert.match(translated, /\[[^\]]+\]\[install-package\]/);
  assert.match(translated, /\[install-package\]: \.\/install\/package "install package"/);
  assert.match(translated, /src="https:\/\/example\.test\/install\/package\.png"/);
});

test('the real local translator preserves fenced code inside blockquotes', async () => {
  const source = [
    '> ```sh',
    '> npm install package',
    '> ```',
  ].join('\n');
  const translator = new Translator({ provider: 'local' });

  assert.equal(await translator.translateMarkdown(source), source);
});

test('the real local translator preserves fenced code inside list items', async () => {
  const source = [
    '- ```sh',
    '  npm install package',
    '  ```',
  ].join('\n');
  const translator = new Translator({ provider: 'local' });

  assert.equal(await translator.translateMarkdown(source), source);
});

test('the real local translator stops protecting an unclosed fence when its blockquote ends', async () => {
  const source = [
    '> ```sh',
    '> npm install package',
    '',
    'install package',
  ].join('\n');
  const translator = new Translator({ provider: 'local' });

  assert.equal(
    await translator.translateMarkdown(source),
    ['> ```sh', '> npm install package', '', '安装 包'].join('\n'),
  );
});

test('the real local translator preserves indented code beginning with a list marker', async () => {
  const source = [
    'Example:',
    '',
    '    - install package',
  ].join('\n');
  const translator = new Translator({ provider: 'local' });

  const translated = await translator.translateMarkdown(source);
  assert.match(translated, / {4}- install package$/);
  assert.doesNotMatch(translated, / {4}- 安装 包$/);
});

test('the real local translator translates nested list items', async () => {
  const source = [
    '- install package',
    '    - install package',
  ].join('\n');
  const translator = new Translator({ provider: 'local' });

  assert.equal(
    await translator.translateMarkdown(source),
    ['- 安装 包', '    - 安装 包'].join('\n'),
  );
});
