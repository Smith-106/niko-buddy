#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import ts from "typescript"
import { expectedPortableAssetName } from "./check-release-cadence.mjs"

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export const README_SYNC_START = "<!-- release-sync:current:start -->"
export const README_SYNC_END = "<!-- release-sync:current:end -->"
export const DOWNLOAD_SYNC_START = "<!-- release-sync:latest:start -->"
export const DOWNLOAD_SYNC_END = "<!-- release-sync:latest:end -->"
export const DOWNLOAD_ASSETS_START = "<!-- release-sync:assets:start -->"
export const DOWNLOAD_ASSETS_END = "<!-- release-sync:assets:end -->"

export async function loadChangelogEntries(root = DEFAULT_ROOT) {
  const source = readFileSync(resolve(root, "src/lib/changelog.ts"), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
  const mod = await import(moduleUrl)
  if (!Array.isArray(mod.ENTRIES)) {
    throw new Error("src/lib/changelog.ts 未导出 ENTRIES 数组")
  }
  return mod.ENTRIES
}

export function renderReadmeCurrentSection(entry) {
  const version = entry.version
  const portableName = expectedPortableAssetName(version)
  const installerName = `niko-buddy_${version}_windows_X64.exe`
  const bullets = (entry.highlights?.zh ?? []).slice(0, 6).map((item) => `- ${item}`)

  return [
    README_SYNC_START,
    `## v${version}（${entry.date} 发布，当前主干版本）`,
    "",
    `**当前主干版本（${entry.date} 同步）**：版本号以 \`package.json\` / \`src-tauri/tauri.conf.json\` / \`src-tauri/Cargo.toml\` 为唯一真源，实际发布产物见 [GitHub Releases](https://github.com/Smith-106/niko-buddy/releases)（Windows 安装包 \`${installerName}\`、便携版 \`${portableName}\`）。`,
    "",
    ...bullets,
    README_SYNC_END,
  ].join("\n")
}

export function applyReadmeSync(readmeText, entry) {
  const version = entry.version
  let next = readmeText.replace(
    /(https:\/\/img\.shields\.io\/badge\/version-)([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)(-blue)/g,
    `$1${version}$3`,
  )
  const section = renderReadmeCurrentSection(entry)
  const markerRe = new RegExp(`${README_SYNC_START}[\\s\\S]*?${README_SYNC_END}`)
  if (markerRe.test(next)) {
    next = next.replace(markerRe, section)
  } else {
    const legacySectionRe = /## v\d+\.\d+\.\d+[^\n]*\r?\n[\s\S]*?(?=\r?\n\*\*v\d+\.\d+\.\d+)/
    if (!legacySectionRe.test(next)) {
      throw new Error("README.md 中未找到受控同步区块或版本摘要起点")
    }
    next = next.replace(legacySectionRe, `${section}\n`)
  }
  return next
}

export function renderDownloadLatestSection(entry) {
  const version = entry.version
  const portableName = expectedPortableAssetName(version)
  const installerName = `niko-buddy_${version}_windows_X64.exe`
  const highlights = (entry.highlights?.zh ?? []).slice(0, 6).map((item) => `- ${item}`)

  return [
    DOWNLOAD_SYNC_START,
    `**v${version}**（${entry.date} 发布 —— **当前版本，GitHub Releases**）`,
    "",
    `- 前往 [GitHub Releases v${version}](https://github.com/Smith-106/niko-buddy/releases/tag/v${version}) 获取 Windows x64 构建资产：`,
    `  - 安装包：\`${installerName}\`（配签名 \`${installerName}.sig\`）`,
    `  - 便携版：\`${portableName}\``,
    `  - 自动更新清单：\`latest.json\``,
    "",
    `### v${version} 更新要点`,
    "",
    ...highlights,
    DOWNLOAD_SYNC_END,
  ].join("\n")
}

export function renderDownloadAssetsSection(entry) {
  const version = entry.version
  const portableName = expectedPortableAssetName(version)
  const installerName = `niko-buddy_${version}_windows_X64.exe`
  const portableNote = portableName.endsWith(".zip")
    ? "整目录便携压缩包，解压后运行 `niko-buddy.exe` 即可，内含 `pdfium.dll` 与 `skills/`，适合 U 盘随身携带或免安装场景。"
    : "便携免安装运行包，直接运行即可，适合 U 盘随身携带或免安装场景。"

  return [
    DOWNLOAD_ASSETS_START,
    "## Windows 安装包",
    "",
    `当前版本为 **v${version}**（${entry.date} 发布）。`,
    "",
    `下载 [\`${installerName}\`](https://github.com/Smith-106/niko-buddy/releases/download/v${version}/${installerName})，双击运行 NSIS 安装程序即可。`,
    "",
    "## 便携版",
    "",
    `下载 [\`${portableName}\`](https://github.com/Smith-106/niko-buddy/releases/download/v${version}/${portableName})（${portableNote}）`,
    DOWNLOAD_ASSETS_END,
  ].join("\n")
}

export function applyDownloadDocSync(downloadText, entry) {
  const section = renderDownloadLatestSection(entry)
  const markerRe = new RegExp(`${DOWNLOAD_SYNC_START}[\\s\\S]*?${DOWNLOAD_SYNC_END}`)
  let next = downloadText
  if (markerRe.test(next)) {
    next = next.replace(markerRe, section)
  } else {
    const legacyLatestRe = /(## 最新版本\r?\n\r?\n)([\s\S]*?)(?=\r?\n> \*\*上一稳定版 v|\r?\n### v\d+\.\d+\.\d+)/
    if (!legacyLatestRe.test(next)) {
      throw new Error("docs-site/src/content/docs/download.md 中未找到 ## 最新版本 受控区块")
    }
    next = next.replace(legacyLatestRe, `$1${section}\n`)
  }

  const assetsSection = renderDownloadAssetsSection(entry)
  const assetsMarkerRe = new RegExp(`${DOWNLOAD_ASSETS_START}[\\s\\S]*?${DOWNLOAD_ASSETS_END}`)
  if (assetsMarkerRe.test(next)) {
    next = next.replace(assetsMarkerRe, assetsSection)
  } else {
    const legacyAssetsRe = /## Windows 安装包[\s\S]*?(?=\r?\n## 系统要求)/
    if (legacyAssetsRe.test(next)) {
      next = next.replace(legacyAssetsRe, `${assetsSection}\n`)
    }
  }
  return next
}

export async function syncReleaseDocs({
  root = DEFAULT_ROOT,
  targetVersion,
  write = true,
} = {}) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
  const version = targetVersion ?? pkg.version
  const entries = await loadChangelogEntries(root)
  const entry = entries.find((e) => e?.version === version)
  if (!entry) {
    throw new Error(`src/lib/changelog.ts 中找不到版本 ${version} 的条目`)
  }

  const targets = [
    { rel: "README.md", transform: applyReadmeSync },
    { rel: "docs-site/src/content/docs/download.md", transform: applyDownloadDocSync },
  ]

  const changed = []
  for (const { rel, transform } of targets) {
    const absPath = resolve(root, rel)
    const current = readFileSync(absPath, "utf8")
    const updated = transform(current, entry)
    if (updated !== current) {
      changed.push(rel)
      if (write) {
        writeFileSync(absPath, updated, "utf8")
      }
    }
  }

  return { ok: changed.length === 0 || write, version, changed }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const checkOnly = args.includes("--check")
  const versionArg = args.find((a) => /^\d+\.\d+\.\d+/.test(a))
  const res = await syncReleaseDocs({ targetVersion: versionArg, write: !checkOnly })
  if (checkOnly && res.changed.length > 0) {
    console.error(`[sync-release-docs] 发现文档版本未同步至 ${res.version}：${res.changed.join(", ")}`)
    process.exit(1)
  }
  console.log(
    res.changed.length === 0
      ? `[sync-release-docs] 文档已同步（v${res.version}，无需修改）`
      : `[sync-release-docs] 已同步 v${res.version} 至：${res.changed.join(", ")}`,
  )
}
