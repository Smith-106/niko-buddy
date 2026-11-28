#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
/**
 * apply-craft-preset.mjs — 小说流派与写作专家配方一键配装器。
 *
 * 职责：
 *   从 `craft-presets.json` 读取 8 套经过冲突消解的流派写作配方（主专家 + 辅助专家 + 大写作手法 + 角色框架 + 规则集），
 *   支持：
 *     1. `--list`：列出全部可选流派配方、适配题材、风格画像与互斥提醒；
 *     2. `--show <preset-id>`：打印该配方的完整技能名单与可直接粘贴进「设置 → 小说设置 → 任务提示词与技能」的配置；
 *     3. `--apply <preset-id> --project <小说项目目录> --pack-dir <导出包目录>`：
 *        - 自动把该配方用到的 `linked-skills/<slug>` 合并注册进 `<小说项目>/.niko-buddy/writing-skills.json`（先备份）；
 *        - 自动禁用与当前流派互斥的其他专家 Skill，防止「道诡民俗恐怖 + 脱力轻喜剧」串味打架；
 *        - 输出可直接填入「小说设置 → 任务提示词与技能」的 `outline / writing / review` 推荐名单。
 *
 * 用法：
 *   node scripts/apply-craft-preset.mjs --list
 *   node scripts/apply-craft-preset.mjs --show cuttlefish-mystery
 *   node scripts/apply-craft-preset.mjs --apply cuttlefish-mystery --project "<your-novel-project-dir>"
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..")
const DEFAULT_PACK_DIR = resolve(REPO_ROOT, "dist", "nmem-pack")

function writeFileAtomicSync(targetPath, content) {
  mkdirSync(dirname(targetPath), { recursive: true })
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmpPath, content, "utf8")
  renameSync(tmpPath, targetPath)
}

const FENCED_PRESET_HINT_RE = /<!--\s*preset-hint:start:[^\s>]+\s*-->[\s\S]*?<!--\s*preset-hint:end:[^\s>]+\s*-->/g

function mergeFencedPresetHint(existingExtra, presetId, hint) {
  const userText = String(existingExtra || "").replace(FENCED_PRESET_HINT_RE, "").replace(/\n{3,}/g, "\n\n").trim()
  const cleanHint = String(hint || "").trim()
  if (!cleanHint) return userText
  const fenced = `<!-- preset-hint:start:${presetId} -->\n${cleanHint}\n<!-- preset-hint:end:${presetId} -->`
  return userText ? `${userText}\n\n${fenced}` : fenced
}

function resolveDefaultPackDir() {
  const candidates = [
    process.env.NIKO_NMEM_PACK_DIR,
    DEFAULT_PACK_DIR,
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(join(c, "craft-presets.json"))) return c
  }
  return candidates[0]
}

function parseArgs(argv) {
  const opts = {
    list: false,
    show: null,
    apply: null,
    rollback: false,
    project: null,
    packDir: resolveDefaultPackDir(),
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--list") opts.list = true
    else if (a === "--show") opts.show = argv[++i] ?? null
    else if (a === "--apply") opts.apply = argv[++i] ?? null
    else if (a === "--rollback") opts.rollback = true
    else if (a === "--project") opts.project = argv[++i] ?? null
    else if (a === "--pack-dir") opts.packDir = resolve(argv[++i] ?? opts.packDir)
    else if (a === "--help" || a === "-h") opts.help = true
    else throw new Error(`未知参数: ${a}`)
  }
  return opts
}

function loadPresets(packDir) {
  const path = join(packDir, "craft-presets.json")
  if (!existsSync(path)) {
    throw new Error(`找不到配方文件: ${path}（请先运行 node scripts/export-nmem-to-niko-buddy.mjs）`)
  }
  return JSON.parse(readFileSync(path, "utf8"))
}

function printPresetDetail(preset) {
  console.log(`\n════════════════════════════════════════════════════════════`)
  console.log(`  流派配方：${preset.name} (${preset.id})`)
  console.log(`════════════════════════════════════════════════════════════`)
  console.log(`适配题材：${preset.genres.join(" / ")}`)
  console.log(`叙事基调：${preset.tone}`)
  console.log(`主写作专家：${preset.primaryExpert}`)
  console.log(`辅助专家：${preset.secondaryExpert || "无"}`)
  console.log(`核心大手法：${preset.craftSkills.join(", ")}`)
  console.log(`角色框架：${preset.characterSkills.join(", ")}`)
  console.log(`推荐角色灵魂参考（soulskill）：${(preset.suggestedSoulSkills || []).join(", ") || "按角色自选"}`)
  console.log(`核心硬规则：${preset.coreRules.join(", ")}`)
  if (preset.avoidExperts?.length) {
    console.log(`互斥防串味（自动禁用）：${preset.avoidExperts.join(", ")}`)
  }
  console.log(`\n▶ 可直接粘贴到 niko-buddy「设置 → 小说设置 → 任务提示词与技能」：`)
  console.log(`  [大纲 outline] : ${preset.taskSkillNames.outline.join(", ")}`)
  console.log(`  [正文 writing] : ${preset.taskSkillNames.writing.join(", ")}`)
  console.log(`  [审稿 review]  : ${preset.taskSkillNames.review.join(", ")}`)
  console.log(`  [写作附加提示] : ${preset.extraPromptHint}\n`)
}

function applyPresetToProject(preset, allPresets, projectDir, packDir) {
  const snippetPath = join(packDir, "linked-skills-config-snippet.json")
  const linkedBySlug = existsSync(snippetPath)
    ? new Map((JSON.parse(readFileSync(snippetPath, "utf8")).skills || []).map((s) => [s.name, s]))
    : new Map()

  const nikoDir = join(projectDir, ".niko-buddy")
  const novelDir = join(projectDir, ".novel")
  mkdirSync(nikoDir, { recursive: true })
  mkdirSync(novelDir, { recursive: true })

  const now = new Date()
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
  const txId = `tx-${now.getTime().toString(36)}`
  const backupRelDir = `.niko-buddy/preset-backups/${stamp}-${txId}`
  const backupDir = join(projectDir, backupRelDir)
  mkdirSync(backupDir, { recursive: true })

  const managed = [
    { rel: ".niko-buddy/writing-skills.json", bak: "writing-skills.json" },
    { rel: ".novel/book-rules.json", bak: "book-rules.json" },
    { rel: ".niko-buddy/novel-config.json", bak: "novel-config.json" },
    { rel: ".niko-buddy/preset-journal.json", bak: "preset-journal.json" },
  ]
  const snapshots = managed.map((m) => {
    const abs = join(projectDir, m.rel)
    const existedBefore = existsSync(abs)
    const raw = existedBefore ? readFileSync(abs, "utf8") : null
    if (existedBefore && raw !== null) {
      copyFileSync(abs, join(backupDir, m.bak))
    }
    return { ...m, abs, existedBefore, raw }
  })

  // 1. writing-skills.json
  const skillsConfig = snapshots[0].raw
    ? JSON.parse(snapshots[0].raw)
    : { version: 1, selectedSkillId: null, disabledSkillIds: [], skills: [], categories: [] }

  const wantedSlugs = new Set([
    "novel-craft-school-and-expert-selector",
    preset.primaryExpert,
    ...(preset.secondaryExpert ? [preset.secondaryExpert] : []),
    ...preset.craftSkills,
    ...preset.characterSkills,
  ])
  const allExpertSlugs = new Set(
    allPresets.flatMap((p) => [p.primaryExpert, ...(p.secondaryExpert ? [p.secondaryExpert] : [])]).filter(Boolean),
  )
  const existingById = new Map((skillsConfig.skills || []).map((s) => [s.id, s]))
  const added = []
  for (const slug of wantedSlugs) {
    const entry = linkedBySlug.get(slug)
    if (!entry) continue
    if (!existingById.has(entry.id)) {
      skillsConfig.skills.push(entry)
      existingById.set(entry.id, entry)
      added.push(slug)
    }
  }
  const disabledSet = new Set(skillsConfig.disabledSkillIds || [])
  for (const slug of allExpertSlugs) {
    const id = `nmem-linked:${slug}`
    if (wantedSlugs.has(slug)) disabledSet.delete(id)
    else if (existingById.has(id)) disabledSet.add(id)
  }
  for (const slug of preset.avoidExperts || []) {
    disabledSet.add(`nmem-linked:${slug}`)
  }
  skillsConfig.disabledSkillIds = [...disabledSet]
  skillsConfig.selectedSkillId = `nmem-linked:${preset.primaryExpert}`

  // 2. .novel/book-rules.json（无损合并）
  const bookRules = snapshots[1].raw
    ? JSON.parse(snapshots[1].raw)
    : { version: "1.1", prohibitions: [], allowedDeviations: [] }
  if (!bookRules.genreLock && Array.isArray(preset.genres) && preset.genres.length > 0) {
    bookRules.genreLock = { primary: preset.genres[0], forbidden: [] }
  }

  // 3. .niko-buddy/novel-config.json（无损围栏合并 prompt + taskSkillNames + activeCraftPresetId）
  const novelConfig = snapshots[2].raw ? JSON.parse(snapshots[2].raw) : {}
  novelConfig.activeCraftPresetId = preset.id
  novelConfig.taskSkillNames = {
    ...(novelConfig.taskSkillNames || {}),
    outline: [...preset.taskSkillNames.outline],
    writing: [...preset.taskSkillNames.writing],
    review: [...preset.taskSkillNames.review],
  }
  novelConfig.taskPrompts = {
    ...(novelConfig.taskPrompts || {}),
    writing: {
      extra: mergeFencedPresetHint(novelConfig.taskPrompts?.writing?.extra, preset.id, preset.extraPromptHint),
    },
  }

  // 4. .niko-buddy/preset-journal.json
  const journal = snapshots[3].raw ? JSON.parse(snapshots[3].raw) : { version: 1, entries: [] }
  journal.entries = [
    ...(Array.isArray(journal.entries) ? journal.entries : []),
    {
      txId,
      presetId: preset.id,
      presetName: preset.name,
      appliedAt: now.toISOString(),
      backupDir: backupRelDir,
      status: "committed",
      files: snapshots.slice(0, 3).map((s) => ({
        relativePath: s.rel,
        backupFileName: s.bak,
        existedBefore: s.existedBefore,
      })),
    },
  ]

  const payloads = [
    `${JSON.stringify(skillsConfig, null, 2)}\n`,
    `${JSON.stringify(bookRules, null, 2)}\n`,
    `${JSON.stringify(novelConfig, null, 2)}\n`,
    `${JSON.stringify(journal, null, 2)}\n`,
  ]
  const written = []
  try {
    for (let i = 0; i < snapshots.length; i += 1) {
      writeFileAtomicSync(snapshots[i].abs, payloads[i])
      written.push(snapshots[i])
    }
  } catch (err) {
    for (const snap of written.reverse()) {
      if (snap.existedBefore && snap.raw !== null) {
        writeFileAtomicSync(snap.abs, snap.raw)
      }
    }
    throw err
  }

  console.log(`[apply-craft-preset] ✅ 已原子应用配方「${preset.name}」到项目：${projectDir}`)
  console.log(`  - 事务 ID：${txId}`)
  console.log(`  - 备份目录：${backupDir}`)
  console.log(`  - 新增 linked 技能：${added.length > 0 ? added.join(", ") : "（均已存在，已刷新启停态）"}`)
  printPresetDetail(preset)
}

function rollbackPresetFromProject(projectDir) {
  const journalPath = join(projectDir, ".niko-buddy", "preset-journal.json")
  if (!existsSync(journalPath)) {
    throw new Error(`找不到事务日志：${journalPath}`)
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf8"))
  const entries = Array.isArray(journal.entries) ? journal.entries : []
  const revIdx = [...entries].reverse().findIndex((e) => e.status === "committed")
  if (revIdx < 0) {
    throw new Error("没有可回滚的已提交工艺预设记录")
  }
  const idx = entries.length - 1 - revIdx
  const entry = entries[idx]
  for (const file of entry.files || []) {
    if (file.existedBefore) {
      const bakPath = join(projectDir, entry.backupDir, file.backupFileName)
      writeFileAtomicSync(join(projectDir, file.relativePath), readFileSync(bakPath, "utf8"))
    }
  }
  entries[idx] = { ...entry, status: "rolled_back", rolledBackAt: new Date().toISOString() }
  writeFileAtomicSync(journalPath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
  console.log(`[apply-craft-preset] ↩️ 已回滚事务 ${entry.txId}（配方：${entry.presetName}）`)
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || (!opts.list && !opts.show && !opts.apply && !opts.rollback)) {
    console.log(`用法:
  node scripts/apply-craft-preset.mjs --list
  node scripts/apply-craft-preset.mjs --show <preset-id>
  node scripts/apply-craft-preset.mjs --apply <preset-id> --project <小说项目目录> [--pack-dir <导出包目录>]
  node scripts/apply-craft-preset.mjs --rollback --project <小说项目目录>`)
    return 0
  }

  if (opts.rollback) {
    if (!opts.project) throw new Error("--rollback 必须指定 --project <小说项目目录>")
    rollbackPresetFromProject(resolve(opts.project))
    return 0
  }

  const data = loadPresets(opts.packDir)
  const presets = data.presets || []

  if (opts.list) {
    console.log(`\n共 ${presets.length} 套可选小说流派与写作专家配方：\n`)
    for (const p of presets) {
      console.log(`  • ${p.id.padEnd(24)} | ${p.name}`)
      console.log(`    题材：${p.genres.join(" / ")}`)
      console.log(`    专家：${p.primaryExpert}${p.secondaryExpert ? ` + ${p.secondaryExpert}` : ""} | 手法：${p.craftSkills.join(", ")}`)
    }
    console.log(`\n查看详情：node scripts/apply-craft-preset.mjs --show <preset-id>`)
    return 0
  }

  const targetId = opts.show || opts.apply
  const preset = presets.find((p) => p.id === targetId)
  if (!preset) {
    console.error(`未找到配方: ${targetId}。可用 id: ${presets.map((p) => p.id).join(", ")}`)
    return 1
  }

  if (opts.show) {
    printPresetDetail(preset)
    return 0
  }

  if (!opts.project) {
    throw new Error("--apply 必须同时提供 --project <小说项目目录>")
  }
  applyPresetToProject(preset, presets, resolve(opts.project), opts.packDir)
  return 0
}

try {
  process.exit(main())
} catch (err) {
  console.error("[apply-craft-preset] ❌", err instanceof Error ? err.message : String(err))
  process.exit(1)
}
