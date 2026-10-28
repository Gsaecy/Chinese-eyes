#!/usr/bin/env node
/**
 * 决定「这次该发布哪个版本」。
 *
 * CI 的目标：每次推送到 main 都构建，并且**自动升版本号**发布到
 * VS Code Marketplace 与 Open VSX。难点在于三个版本要互相对齐：
 *
 *   - 本地 package.json 的 version（可能已被人工改过）
 *   - VS Code Marketplace 上已发布的最高版本
 *   - Open VSX 上已发布的版本（可能还没有）
 *
 * 规则（mode = auto，默认）：
 *   - 本地版本 > 两个注册表里较高的那个 → 直接发本地这个版本（尊重人工改的版本号）
 *   - 本地版本 <= 已发布版本           → 在已发布版本上 +1 patch，作为本次发布版本
 * 其它 mode：patch / minor / major 强制递增；none 完全不改版本。
 *
 * 为什么不无脑 +1：工作流用 GITHUB_TOKEN 推的版本提交不会再触发新的工作流
 * （GitHub 内置行为），但人工在本地改过 package.json 时也不能把已经发过的版本
 * 再发一次——两个注册表都会拒绝重复版本。
 *
 * 用法：
 *   node .github/scripts/next-version.mjs <扩展目录> [auto|patch|minor|major|none]
 * 输出（追加到 $GITHUB_OUTPUT，同时打印到 stdout）：
 *   version=<目标版本>
 *   artifact=<扩展名>-<目标版本>.vsix   打包产物的文件名
 *   changed=<true|false>     是否需要修改 package.json
 *   marketplace=<已发布版本或 ->
 *   openvsx=<已发布版本或 ->
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MARKETPLACE_QUERY = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const OPEN_VSX_API = 'https://open-vsx.org/api';

const extDir = process.argv[2] ?? '.';
const mode = (process.argv[3] ?? 'auto').toLowerCase();

/** 只取主版本号，忽略 `-pre` 之类后缀：发布版本比较用不到。 */
function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compare(left, right) {
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function bump(version, kind) {
  const parsed = parse(version) ?? [0, 0, 0];
  if (kind === 'major') return `${parsed[0] + 1}.0.0`;
  if (kind === 'minor') return `${parsed[0]}.${parsed[1] + 1}.0`;
  return `${parsed[0]}.${parsed[1]}.${parsed[2] + 1}`;
}

async function marketplaceLatest(publisher, name) {
  try {
    const response = await fetch(MARKETPLACE_QUERY, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json;api-version=7.2-preview.1',
      },
      body: JSON.stringify({
        filters: [{ criteria: [{ filterType: 7, value: `${publisher}.${name}` }] }],
        flags: 914,
      }),
    });
    if (!response.ok) return { version: undefined, note: `http ${response.status}` };
    const payload = await response.json();
    const versions = (payload?.results?.[0]?.extensions?.[0]?.versions ?? [])
      .map((entry) => entry.version)
      .filter((value) => parse(value));
    return { version: versions.sort(compare).at(-1) };
  } catch (error) {
    return { version: undefined, note: `查询失败：${error.message}` };
  }
}

async function openVsxLatest(publisher, name) {
  try {
    const response = await fetch(`${OPEN_VSX_API}/${publisher}/${name}`, { headers: { Accept: 'application/json' } });
    if (response.status === 404) return { version: undefined, note: '尚未发布' };
    if (!response.ok) return { version: undefined, note: `http ${response.status}` };
    const payload = await response.json();
    return { version: payload?.version };
  } catch (error) {
    return { version: undefined, note: `查询失败：${error.message}` };
  }
}

const manifest = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf8'));
const local = String(manifest.version ?? '');
const publisher = String(manifest.publisher ?? '');
const name = String(manifest.name ?? '');

if (!publisher || !name || !parse(local)) {
  console.error(`package.json 缺少 publisher / name / version：${JSON.stringify({ publisher, name, local })}`);
  process.exit(1);
}

const [marketplace, openvsx] = await Promise.all([
  marketplaceLatest(publisher, name),
  openVsxLatest(publisher, name),
]);

const published = [marketplace.version, openvsx.version]
  .filter((value) => parse(value))
  .sort(compare)
  .at(-1);

let target = local;
let changed = false;

if (mode === 'none') {
  target = local;
} else if (mode !== 'auto') {
  target = bump(local, mode);
  changed = target !== local;
} else if (published && compare(local, published) <= 0) {
  // 本地版本发不出去（已存在）：在已发布版本上 +1 patch。
  target = bump(published, 'patch');
  changed = true;
}

/**
 * 把目标版本写进 package.json 与 package-lock.json（传 `--apply` 时）。
 *
 * 不用 `npm version`：它会做 git 工作树检查，在「仓库根有 .git、扩展在子目录」
 * 的情况下行为随 npm 版本变化（例如 env-sync 的扩展在 extension/ 里）。
 * 这里只改两个字段，格式与原文件保持一致（2 空格缩进 + 结尾换行）。
 */
function applyVersion(target) {
  for (const file of ['package.json', 'package-lock.json']) {
    const path = join(extDir, file);
    let source;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      continue; // 没有 lock 文件也允许
    }
    const indent = /\n( +)"/.exec(source)?.[1]?.length ?? 2;
    const data = JSON.parse(source);
    data.version = target;
    if (data.packages && data.packages['']) data.packages[''] = { ...data.packages[''], version: target };
    writeFileSync(path, `${JSON.stringify(data, null, indent)}\n`);
    console.log(`# 已写入 ${path} → ${target}`);
  }
}

const lines = [
  `version=${target}`,
  // 产物名用扩展自己的 name，避免 EXT_DIR 为 `.` 时拼出 `.-0.2.6.vsix` 这种名字。
  `artifact=${name}-${target}.vsix`,
  `changed=${changed}`,
  `marketplace=${marketplace.version ?? '-'}`,
  `openvsx=${openvsx.version ?? '-'}`,
];
if (process.argv.includes('--apply') && changed) applyVersion(target);
for (const line of lines) console.log(line);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
console.log(
  `# ${publisher}.${name} 本地 ${local} / Marketplace ${marketplace.version ?? '-'}`
  + `${marketplace.note ? `(${marketplace.note})` : ''}`
  + ` / OpenVSX ${openvsx.version ?? '-'}${openvsx.note ? `(${openvsx.note})` : ''}`
  + ` → 发布 ${target}`,
);
