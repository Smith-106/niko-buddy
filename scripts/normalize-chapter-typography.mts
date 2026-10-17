/**
 * normalize-chapter-typography.mts — 一次性修复历史章节的标题与排版。
 *
 * 背景：`autonomous-campaign` 早期产出的章节 frontmatter 只有裸标签 `title: "第N章"`，
 * 真实章节名留在正文 H1（部分章节还同时存在两条 H1），导致目录只显示「第3章」。
 * 写入路径已自动归一（campaign-runner / chapter-import），本脚本负责把历史章节补齐。
 *
 * 用法：
 *   node --experimental-strip-types scripts/normalize-chapter-typography.mts --root "C:/path/to/project"
 *   ...同上 + --write          # 真正落盘（默认 dry-run）
 *   ...同上 + --dirs wiki/chapters,QM/chapters   # 覆盖默认扫描目录
 *   ...同上 + --no-body        # 不在正文上跑排版规范化（只修标题/H1）
 *
 * 安全：
 *   - 默认 dry-run，只打印将变更的文件与统计；
 *   - --write 时先整目录备份到 <root>/.novel/typography-backup-<timestamp>/；
 *   - 幂等：已规范文件 changed=false，复跑应显示 0 变更。
 */

import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, relative } from "node:path"
import { normalizeChapterDocument, readFrontmatterTitle } from "../src/lib/novel/chapter-typography.ts"

interface Options {
  root: string
  write: boolean
  dirs: string[]
  normalizeBody: boolean
}

function parseArgs(argv: string[]): Options {
  const args = new Map<string, string | boolean>()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      args.set(key, next)
      i += 1
    } else {
      args.set(key, true)
    }
  }
  const root = String(args.get("root") ?? process.cwd())
  const dirsRaw = args.get("dirs")
  const dirs =
    typeof dirsRaw === "string" && dirsRaw.trim().length > 0
      ? dirsRaw.split(",").map((d) => d.trim()).filter(Boolean)
      : ["wiki/chapters", "QM/chapters"]
  return {
    root,
    write: args.get("write") === true,
    dirs,
    normalizeBody: args.get("no-body") !== true,
  }
}

interface FileReport {
  path: string
  from: string | undefined
  to: string
  reasons: string[]
}

async function listMarkdown(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue
      files.push(...(await listMarkdown(full)))
      continue
    }
    if (entry.name.toLowerCase().endsWith(".md")) files.push(full)
  }
  return files
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const targets: string[] = []
  for (const dir of options.dirs) targets.push(join(options.root, dir))

  const files: string[] = []
  for (const dir of targets) {
    if (!existsSync(dir)) {
      console.log(`[skip] ${dir} 不存在`)
      continue
    }
    files.push(...(await listMarkdown(dir)))
  }

  const changed: FileReport[] = []
  const titlesRecovered: FileReport[] = []
  const pending: Array<{ path: string; content: string }> = []

  for (const file of files) {
    const content = await readFile(file, "utf8")
    const result = normalizeChapterDocument(content, { normalizeBody: options.normalizeBody })
    if (!result.changed) continue
    const from = readFrontmatterTitle(content)
    const report: FileReport = {
      path: relative(options.root, file).replace(/\\/g, "/"),
      from,
      to: result.title,
      reasons: [
        result.changes.titleSynced ? "title" : "",
        result.changes.headingsDeduped > 0 ? `h1-${result.changes.headingsDeduped}` : "",
        result.changes.bodyNormalized ? "body" : "",
      ].filter(Boolean),
    }
    changed.push(report)
    if (from && from !== result.title) titlesRecovered.push(report)
    pending.push({ path: file, content: result.content })
  }

  console.log("=== normalize-chapter-typography ===")
  console.log(`root: ${options.root}`)
  console.log(`mode: ${options.write ? "WRITE" : "dry-run"}`)
  console.log(`dirs: ${options.dirs.join(", ")}`)
  console.log(`scanned: ${files.length} files`)
  console.log(`will change: ${changed.length} files (title recovered: ${titlesRecovered.length})`)

  const preview = changed.slice(0, 20)
  for (const item of preview) {
    console.log(`  - ${item.path}: 「${item.from ?? "(none)"}」 → 「${item.to}」 [${item.reasons.join(",")}]`)
  }
  if (changed.length > preview.length) console.log(`  ... 其余 ${changed.length - preview.length} 个文件省略`)

  if (!options.write || pending.length === 0) {
    if (!options.write) console.log("\n(dry-run) 未落盘；确认无误后追加 --write")
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const backupDir = join(options.root, ".novel", `typography-backup-${stamp}`)
  await mkdir(backupDir, { recursive: true })
  for (const item of pending) {
    const rel = relative(options.root, item.path)
    const dest = join(backupDir, rel)
    await mkdir(join(dest, ".."), { recursive: true })
    await cp(item.path, dest)
  }
  console.log(`\nbackup: ${backupDir}`)

  let written = 0
  for (const item of pending) {
    const before = await stat(item.path)
    await writeFile(item.path, item.content, "utf8")
    const after = await stat(item.path)
    if (after.size !== before.size || item.content.length > 0) written += 1
  }
  console.log(`written: ${written} files`)
  console.log("re-run without --write to verify 0 pending changes (idempotency check)")
}

await main()
