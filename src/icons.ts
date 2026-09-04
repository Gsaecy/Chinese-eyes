/**
 * 统一 SVG 图标集 —— 简洁线性风格（stroke=currentColor，随主题变色）
 * 所有 webview 共用这一套图标，保证视觉风格统一。
 */

export type IconName =
  | 'search'
  | 'clear'
  | 'globe'
  | 'settings'
  | 'close'
  | 'download'
  | 'star'
  | 'external'
  | 'sparkle'
  | 'trash'
  | 'swap'
  | 'clipboard'
  | 'upload'
  | 'doc'
  | 'key'
  | 'grid'
  | 'warning'
  | 'install'
  | 'home'
  | 'check';

const PATHS: Record<IconName, string> = {
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
  clear: '<path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5"/>',
  globe:
    '<circle cx="8" cy="8" r="6.25"/><path d="M1.75 8h12.5"/><path d="M8 1.75a9.6 9.6 0 0 1 0 12.5"/>',
  settings:
    '<circle cx="8" cy="8" r="1.8"/><circle cx="8" cy="8" r="4.6"/><path d="M8 1.3v2M8 12.7v2M1.3 8h2M12.7 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4"/>',
  close: '<path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5"/>',
  download:
    '<path d="M8 2.5v7.5"/><path d="M4.75 7.25 8 10.5l3.25-3.25"/><path d="M2.5 13.5h11"/>',
  star:
    '<path d="M8 1.75l1.85 3.75 4.15.6-3 2.93.7 4.12L8 11.16l-3.7 1.99.7-4.12-3-2.93 4.15-.6L8 1.75z"/>',
  external:
    '<path d="M9 3.5h3.5V7"/><path d="M12.5 9.75V12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 12V6A1.5 1.5 0 0 1 5 4.5h2.25"/><path d="M6.75 9.25 13 3"/>',
  sparkle:
    '<path d="M8 2.25 9.55 6.45 13.75 8 9.55 9.55 8 13.75 6.45 9.55 2.25 8 6.45 6.45 8 2.25z"/><path d="M12.75 12.5h.01"/><path d="M12 1.75h.01"/>',
  trash:
    '<path d="M2.75 4.5h10.5"/><path d="M6 4.5V2.75h4V4.5"/><path d="M4.25 4.5 5 13.25h6L11.75 4.5"/><path d="M6.75 7.25v4M9.25 7.25v4"/>',
  swap:
    '<path d="M2.5 7.5h11M10.75 4.75 13.5 7.5l-2.75 2.75"/><path d="M13.5 8.5h-11M5.25 11.25 2.5 8.5l2.75-2.75"/>',
  clipboard:
    '<rect x="4.75" y="3.75" width="6.5" height="9.25" rx="1"/><path d="M6.5 2.5h3a1 1 0 0 1 1 1v1.25h-5V3.5a1 1 0 0 1 1-1z"/>',
  upload:
    '<path d="M8 10.5V3.25"/><path d="M4.75 6 8 2.75 11.25 6"/><path d="M2.5 13.5h11"/>',
  doc:
    '<path d="M4.5 1.75h4.75L12.5 5v9.25H4.5z"/><path d="M9.25 1.75V5h3.25"/><path d="M6.75 8.25h2.5M6.75 10.75h2.5"/>',
  key:
    '<circle cx="5.25" cy="5.25" r="2.5"/><path d="M7 7l6.5 6.5"/><path d="M11 11l2.5 2.5"/>',
  grid:
    '<rect x="2" y="2" width="5.25" height="5.25" rx="1"/><rect x="8.75" y="2" width="5.25" height="5.25" rx="1"/><rect x="2" y="8.75" width="5.25" height="5.25" rx="1"/><rect x="8.75" y="8.75" width="5.25" height="5.25" rx="1"/>',
  warning:
    '<path d="M8 2.25 14.5 13.5h-13z"/><path d="M8 6.5v3.25"/><path d="M8 11.75h.01"/>',
  install:
    '<path d="M3.5 6.5V11a1.5 1.5 0 0 0 1.5 1.5h6A1.5 1.5 0 0 0 12.5 11V6.5"/><path d="M8 2.5v6.75"/><path d="M5.25 7 8 9.75 10.75 7"/>',
  home:
    '<path d="M2.5 7.5 8 2.75l5.5 4.75"/><path d="M4 6.75V13.5h8V6.75"/><path d="M6.5 13.5V9.75h3V13.5"/>',
  check:
    '<circle cx="8" cy="8" r="6.25"/><path d="M5.25 8.25l2 2 3.5-4"/>',
};

/**
 * 生成简洁线性 SVG 图标
 * @param name 图标名
 * @param size 尺寸（px）
 */
export function icon(name: IconName, size = 14): string {
  const inner = PATHS[name] || '';
  return (
    '<svg class="ico" viewBox="0 0 16 16" width="' + size + '" height="' + size +
    '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"' +
    ' stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>'
  );
}
