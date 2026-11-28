#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
/**
 * recompile-nmem-snapshot.js — nmem 快照重编译脚本（DEBT-20260822-t27b-03 偿还 + v0.10.124 远程适配）。
 *
 * 职责（蓝图 §8 P3 + T27b 完成定义 + T34b 工程化清单）：
 *   探活（ping）→ 抓取（live snapshot fetch：memories + active skills + space rules 计数）
 *   → validate（schema/digest 校验）→ diff（与现有快照对比报告）→ 升版提示。
 *
 * 鉴权与地址解析顺序（绝不硬编码密钥）：
 *   --base-url / --api-key → 环境变量 NMEM_API_URL / NMEM_API_KEY
 *   → ~/.nowledge-mem/config.json → 默认回退 http://127.0.0.1:14242。
 *
 * 离线环境行为：
 *   探活失败 → 打印原因并以 exit 0 优雅跳过（graceful skip），不阻断工程化管道。
 *
 * 用法:
 *   node scripts/recompile-nmem-snapshot.js
 *   node scripts/recompile-nmem-snapshot.js --base-url https://your-nmem-host.example
 *   node scripts/recompile-nmem-snapshot.js --base-url http://127.0.0.1:14242 --output /tmp/live-snapshot.json
 *   node scripts/recompile-nmem-snapshot.js --help
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ============================================================================
// 当前提交快照参考（与 src/lib/novel/craft/nmem-snapshot.ts v5 同步）
// 更新快照时同步修改此处；也可通过 --ref 指向外部 JSON 文件覆盖。
// ============================================================================

const REFERENCE_SNAPSHOT = {
  snapshotVersion: 5,
  capturedAt: "2026-11-27T12:40:00.000Z",
  serverVersion: "0.10.124",
  spaceId: "space",
  memoryCount: 8,
  skillCount: 18,
  universalRuleCount: 13,
  memoryIds: [
    "20de3c24-0000-4000-8000-000000000000",
    "04644331-0000-4000-8000-000000000000",
    "84c7f90a-0000-4000-8000-000000000000",
    "akers-ghost-concept-char wound",
    "28dc7918-0000-4000-8000-000000000000",
    "786b0422-0000-4000-8000-000000000000",
    "edgerton-hooked-start-at-inciting-incident",
    "94a6af29-0000-4000-8000-000000000000",
  ],
  skillIds: [
    "skill_f8e81e050000",
    "skill_34b8da3fc971",
    "skill_6bfdc4f3b916",
    "skill_1f395eb26e7e",
    "skill_c115a9cef595",
    "skill_ad222a51ebdc",
    "skill_05a7cc9d09d6",
    "skill_303834196af4",
    "skill_c071a8e8fe12",
    "skill_76e61c2db391",
    "skill_adcd68a9ac71",
    "skill_b5213cc9196f",
    "skill_bfda7587df41",
    "skill_9dab6cee6365",
    "skill_190e3a5dce09",
    "skill_4da20cc16b68",
    "skill_af91619243bd",
    "skill_ca3125a66185",
  ],
}

const DEFAULT_BASE_URL = "http://127.0.0.1:14242"
const ISO_LIKE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function loadLocalNmemConfig() {
  const cfgPath = join(homedir(), ".nowledge-mem", "config.json")
  if (!existsSync(cfgPath)) return {}
  try {
    return JSON.parse(readFileSync(cfgPath, "utf-8"))
  } catch {
    return {}
  }
}

function parseArgs(argv) {
  const localCfg = loadLocalNmemConfig()
  const args = {
    baseUrl: process.env.NMEM_API_URL || localCfg.apiUrl || DEFAULT_BASE_URL,
    apiKey: process.env.NMEM_API_KEY || localCfg.apiKey || "",
    output: null,
    ref: null,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--base-url") args.baseUrl = argv[++i] ?? args.baseUrl
    else if (a === "--api-key") args.apiKey = argv[++i] ?? args.apiKey
    else if (a === "--output") args.output = argv[++i] ?? null
    else if (a === "--ref") args.ref = argv[++i] ?? null
    else if (a === "--help" || a === "-h") args.help = true
  }
  args.baseUrl = String(args.baseUrl).replace(/\/+$/, "")
  return args
}

function print(...args) {
  console.log("[nmem-recompile]", ...args)
}

function printError(...args) {
  console.error("[nmem-recompile] ERROR:", ...args)
}

function printSection(title) {
  console.log("")
  console.log("─".repeat(60))
  console.log(`  ${title}`)
  console.log("─".repeat(60))
}

function buildHeaders(apiKey) {
  const headers = { Accept: "application/json" }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

// ============================================================================
// 步骤 1：探活（ping）
// ============================================================================

async function probeNmemHealth(baseUrl, apiKey) {
  const url = `${baseUrl}/health`
  print(`探活 → ${url}`)
  try {
    const res = await fetch(url, {
      headers: buildHeaders(apiKey),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      print(`   HTTP ${res.status}，非健康响应`)
      return { healthy: false, version: null, detail: `HTTP ${res.status}` }
    }
    const body = await res.json()
    if (body?.status === "ok") {
      let version = String(body.version ?? "")
      // Nowledge Mem v0.10.124+ 的 /health 仅返回 { status: "ok" }，从 /openapi.json 补读版本号
      if (!version) {
        try {
          const specRes = await fetch(`${baseUrl}/openapi.json`, {
            headers: buildHeaders(apiKey),
            signal: AbortSignal.timeout(8000),
          })
          if (specRes.ok) {
            const spec = await specRes.json()
            version = String(spec?.info?.version ?? "")
          }
        } catch {
          // 版本探测失败不影响探活通过
        }
      }
      print(`   ✅ 健康 — version=${version || "unknown"}`)
      return { healthy: true, version, detail: null }
    }
    print(`   ❌ status=${body?.status ?? "unexpected"}`)
    return { healthy: false, version: null, detail: `status=${body?.status}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    print(`   ❌ 探活失败：${msg}`)
    return { healthy: false, version: null, detail: msg }
  }
}

// ============================================================================
// 步骤 2：抓取（live snapshot fetch — 兼容 v0.10.124 与旧版 v0.10.67）
// ============================================================================

async function fetchJsonChecked(url, apiKey, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: buildHeaders(apiKey),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText} (${url})`)
  }
  return res.json()
}

async function fetchLiveSnapshot(baseUrl, apiKey, serverVersion, ref) {
  const spaceId = ref.spaceId || REFERENCE_SNAPSHOT.spaceId
  const headers = buildHeaders(apiKey)

  try {
    // 2a. 抓取核心锚点记忆（优先按 id 精确读取，兼顾 v0.10.124 分页接口，避免全库 1600+ 记忆截断丢失核心锚点）
    let memories = []
    if (Array.isArray(ref.memoryIds) && ref.memoryIds.length > 0) {
      print(`抓取核心记忆 → ${ref.memoryIds.length} 条（/memories/{id}）`)
      const fetched = await Promise.all(
        ref.memoryIds.map(async (mid) => {
          const url = `${baseUrl}/memories/${encodeURIComponent(mid)}`
          const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
          if (!res.ok) return null
          return res.json()
        }),
      )
      memories = fetched.filter(Boolean).map((m) => ({
        memoryId: String(m.id ?? ""),
        title: String(m.title ?? ""),
        contentExcerpt: String(m.content ?? "").slice(0, 600),
        createdAt: String(m.created_at ?? ""),
        importance: typeof m.importance === "number" ? m.importance : 0,
        unitType: String(m.unit_type ?? ""),
        labels: Array.isArray(m.labels) ? m.labels.map(String) : [],
      }))
    }

    // 若未通过 id 拉到，回退全量列表（先试 v0.10.124 /memories，再试旧版 /api/memories/search）
    if (memories.length === 0) {
      let body
      const modernUrl = `${baseUrl}/memories?space=${encodeURIComponent(spaceId)}&limit=2000`
      const legacyUrl = `${baseUrl}/api/memories/search?q=&space=${encodeURIComponent(spaceId)}&limit=2000`
      print(`抓取记忆列表 → ${modernUrl}`)
      try {
        body = await fetchJsonChecked(modernUrl, apiKey)
      } catch {
        print(`   回退旧版端点 → ${legacyUrl}`)
        body = await fetchJsonChecked(legacyUrl, apiKey)
      }
      const rawMemories = Array.isArray(body?.memories) ? body.memories : []
      memories = rawMemories.map((m) => ({
        memoryId: String(m.id ?? ""),
        title: String(m.title ?? ""),
        contentExcerpt: String(m.content ?? "").slice(0, 600),
        createdAt: String(m.created_at ?? ""),
        importance: typeof m.importance === "number" ? m.importance : 0,
        unitType: String(m.unit_type ?? ""),
        labels: Array.isArray(m.labels) ? m.labels.map(String) : [],
      }))
    }

    // 2b. 抓取活跃 Skills（v0.10.124 原生 /skills?stage=active）
    let skills = []
    try {
      const skillsUrl = `${baseUrl}/skills?stage=active&limit=200`
      print(`抓取活跃 Skills → ${skillsUrl}`)
      const skillsBody = await fetchJsonChecked(skillsUrl, apiKey)
      const rawSkills = Array.isArray(skillsBody)
        ? skillsBody
        : Array.isArray(skillsBody?.skills)
          ? skillsBody.skills
          : Array.isArray(skillsBody?.items)
            ? skillsBody.items
            : []
      const refSkillSet = new Set(ref.skillIds || [])
      // 优先收敛到参考清单内的核心 Skills（若 ref 未指定则全收）
      const filteredSkills =
        refSkillSet.size > 0
          ? rawSkills.filter((s) => refSkillSet.has(String(s.id ?? s.skill_id ?? "")))
          : rawSkills
      skills = filteredSkills.map((s) => {
        const ver = s.verification || {}
        return {
          skillId: String(s.id ?? s.skill_id ?? ""),
          title: String(s.slug ?? s.title ?? s.name ?? ""),
          version: Number.isInteger(ver.version) ? ver.version : Number.isInteger(s.version) ? s.version : 1,
          contentHash: String(ver.content_hash ?? s.content_hash ?? s.contentHash ?? ""),
          stage: String(s.stage ?? "active"),
        }
      })
      print(`   活跃 Skills 总数：${rawSkills.length}，纳入快照核心 Skills：${skills.length}`)
    } catch (err) {
      print(`   ⚠ 抓取 /skills 失败（跳过技能 diff）：${err instanceof Error ? err.message : String(err)}`)
    }

    // 2c. 观测活跃 space Rules 数量（仅诊断报告，不破坏 NmemSnapshot schema）
    let activeSpaceRulesCount = null
    try {
      const rulesBody = await fetchJsonChecked(`${baseUrl}/settings/rules`, apiKey)
      const rawRules = Array.isArray(rulesBody?.rules) ? rulesBody.rules : []
      activeSpaceRulesCount = rawRules.filter((r) => r.status === "active" && r.spaceId === spaceId).length
      print(`   活跃 ${spaceId} Rules：${activeSpaceRulesCount} 条（全库 ${rawRules.length} 条）`)
    } catch {
      // 旧版服务无 /settings/rules 时静默跳过
    }

    const snapshot = {
      snapshotVersion: (ref.snapshotVersion || REFERENCE_SNAPSHOT.snapshotVersion) + 1,
      capturedAt: new Date().toISOString(),
      serverVersion: serverVersion || "unknown",
      spaceId,
      memories,
      skills,
    }
    return { ok: true, data: snapshot, activeSpaceRulesCount, error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, data: null, activeSpaceRulesCount: null, error: msg }
  }
}

// ============================================================================
// 步骤 3：validate（与 nmem-snapshot.ts 的 validateNmemSnapshot 同口径）
// ============================================================================

function validateSnapshot(snapshot) {
  const violations = []

  if (!Number.isInteger(snapshot.snapshotVersion) || snapshot.snapshotVersion < 1) {
    violations.push({ path: "snapshotVersion", message: `必须是正整数，实际=${String(snapshot.snapshotVersion)}` })
  }
  if (!ISO_LIKE_RE.test(snapshot.capturedAt)) {
    violations.push({ path: "capturedAt", message: `必须是 ISO 8601 形态，实际=${snapshot.capturedAt}` })
  }
  if (typeof snapshot.serverVersion !== "string" || snapshot.serverVersion.length === 0) {
    violations.push({ path: "serverVersion", message: "不得为空" })
  }
  if (typeof snapshot.spaceId !== "string" || snapshot.spaceId.length === 0) {
    violations.push({ path: "spaceId", message: "不得为空" })
  }

  const seenIds = new Set()
  if (!Array.isArray(snapshot.memories)) {
    violations.push({ path: "memories", message: "必须为数组" })
  } else {
    snapshot.memories.forEach((memory, i) => {
      const at = `memories[${i}]`
      if (typeof memory.memoryId !== "string" || memory.memoryId.length === 0) {
        violations.push({ path: `${at}.memoryId`, message: "memoryId 不得为空" })
      } else if (seenIds.has(memory.memoryId)) {
        violations.push({ path: `${at}.memoryId`, message: `memoryId 重复：${memory.memoryId}` })
      }
      seenIds.add(memory.memoryId)
      if (typeof memory.title !== "string" || memory.title.length === 0) {
        violations.push({ path: `${at}.title`, message: "title 不得为空" })
      }
      if (typeof memory.contentExcerpt !== "string" || memory.contentExcerpt.length === 0) {
        violations.push({ path: `${at}.contentExcerpt`, message: "contentExcerpt 不得为空（离线编译语料面）" })
      }
      if (typeof memory.createdAt !== "string" || !ISO_LIKE_RE.test(memory.createdAt)) {
        violations.push({ path: `${at}.createdAt`, message: `必须是 ISO 8601 形态，实际=${memory.createdAt}` })
      }
      if (
        typeof memory.importance !== "number" ||
        !Number.isFinite(memory.importance) ||
        memory.importance < 0 ||
        memory.importance > 1
      ) {
        violations.push({ path: `${at}.importance`, message: `必须是 [0,1] 内有限数字，实际=${String(memory.importance)}` })
      }
    })
  }

  if (!Array.isArray(snapshot.skills)) {
    violations.push({ path: "skills", message: "必须为数组" })
  } else {
    snapshot.skills.forEach((skill, i) => {
      const at = `skills[${i}]`
      if (typeof skill.skillId !== "string" || skill.skillId.length === 0) {
        violations.push({ path: `${at}.skillId`, message: "skillId 不得为空" })
      }
      if (typeof skill.title !== "string" || skill.title.length === 0) {
        violations.push({ path: `${at}.title`, message: "title 不得为空" })
      }
      if (!Number.isInteger(skill.version) || skill.version < 1) {
        violations.push({ path: `${at}.version`, message: `version 必须是正整数，实际=${String(skill.version)}` })
      }
      if (typeof skill.contentHash !== "string" || skill.contentHash.length === 0) {
        violations.push({ path: `${at}.contentHash`, message: "contentHash 不得为空" })
      }
    })
  }

  return { ok: violations.length === 0, violations }
}

// ============================================================================
// 步骤 4：diff
// ============================================================================

function diffSnapshot(live, ref) {
  const changes = []

  if (live.serverVersion !== ref.serverVersion) {
    changes.push({ field: "serverVersion", before: ref.serverVersion, after: live.serverVersion })
  }

  if (live.memories.length !== ref.memoryCount) {
    changes.push({
      field: "memories.count",
      before: ref.memoryCount,
      after: live.memories.length,
      note: live.memories.length > ref.memoryCount ? "新增记忆" : "记忆减少",
    })
  }

  if (live.skills.length !== ref.skillCount) {
    changes.push({
      field: "skills.count",
      before: ref.skillCount,
      after: live.skills.length,
      note: live.skills.length > ref.skillCount ? "新增 skill" : "skill 减少",
    })
  }

  const liveIds = new Set(live.memories.map((m) => m.memoryId))
  const refIds = new Set(ref.memoryIds)
  const added = live.memories.filter((m) => !refIds.has(m.memoryId))
  const removed = ref.memoryIds.filter((id) => !liveIds.has(id))
  if (added.length > 0) {
    changes.push({
      field: "memories.added",
      before: "—",
      after: added.map((m) => `${m.memoryId} (${m.title.slice(0, 40)})`).join("; "),
    })
  }
  if (removed.length > 0) {
    changes.push({ field: "memories.removed", before: removed.join("; "), after: "—" })
  }

  const liveSkillIds = new Set(live.skills.map((s) => s.skillId))
  const refSkillIds = new Set(ref.skillIds)
  const addedSkills = live.skills.filter((s) => !refSkillIds.has(s.skillId))
  const removedSkills = ref.skillIds.filter((id) => !liveSkillIds.has(id))
  if (addedSkills.length > 0) {
    changes.push({
      field: "skills.added",
      before: "—",
      after: addedSkills.map((s) => `${s.skillId} (${s.title})`).join("; "),
    })
  }
  if (removedSkills.length > 0) {
    changes.push({ field: "skills.removed", before: removedSkills.join("; "), after: "—" })
  }

  return changes
}

// ============================================================================
// 步骤 5：升版提示与失败修正指引
// ============================================================================

function generateUpgradeSuggestion(changes, liveSnapshot, ref) {
  if (changes.length === 0) {
    return "✅ 无差异，当前快照已是最新，无需升版。"
  }

  const lines = ["🔺 检测到差异，建议升版：", ""]
  for (const c of changes) {
    lines.push(`  • ${c.field}: ${String(c.before ?? "—").slice(0, 80)} → ${String(c.after ?? "—").slice(0, 80)}`)
    if (c.note) lines.push(`    备注: ${c.note}`)
  }

  lines.push("")
  lines.push("建议操作：")
  lines.push(`  1. 将 src/lib/novel/craft/nmem-snapshot.ts 的 NMEM_SNAPSHOT_VERSION 从 ${ref.snapshotVersion} 升为 ${liveSnapshot.snapshotVersion}`)
  lines.push(`  2. 更新 NMEM_SNAPSHOT_CAPTURED_AT 为 "${liveSnapshot.capturedAt}"`)
  lines.push(`  3. 更新 NMEM_SERVER_VERSION 为 "${liveSnapshot.serverVersion}"`)
  lines.push("  4. 同步更新 scripts/recompile-nmem-snapshot.js 的 REFERENCE_SNAPSHOT 常量")
  lines.push("  5. 运行 npx vitest run src/lib/novel/craft/technique-compiler.spec.ts && npm run typecheck")
  return lines.join("\n")
}

function generateCorrectionGuide(errorDetail, serverVersion, baseUrl) {
  return [
    "=".repeat(60),
    "  ⚠  DEBT-20260822-t27b-01 条件触发：live 路失败",
    "  nmem server 契约或鉴权可能已漂移，需修正后重试。",
    "=".repeat(60),
    `当前 server 版本: ${serverVersion ?? "未知"}`,
    `API 基址: ${baseUrl}`,
    `错误详情: ${errorDetail}`,
    "排查建议：",
    "  1. 确认 ~/.nowledge-mem/config.json 或 NMEM_API_KEY 中的 Bearer Token 有效",
    "  2. 确认 GET /health 返回 status=ok，且 /memories/{id}、/skills?stage=active 可达",
    "  3. 离线环境探活失败会自动 graceful skip (exit 0)",
  ].join("\n")
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    console.log(`
用法: node scripts/recompile-nmem-snapshot.js [options]

选项:
  --base-url <url>      nmem server API 基址（默认读 NMEM_API_URL / ~/.nowledge-mem/config.json / ${DEFAULT_BASE_URL}）
  --api-key <token>     Bearer Token（默认读 NMEM_API_KEY / ~/.nowledge-mem/config.json）
  --output <path>       将 live snapshot 输出到 JSON 文件
  --ref <path>          参考快照 JSON 文件路径（覆盖内嵌 REFERENCE_SNAPSHOT）
  --help, -h            显示本帮助
`)
    return 0
  }

  let ref = { ...REFERENCE_SNAPSHOT }
  if (args.ref) {
    try {
      ref = JSON.parse(readFileSync(args.ref, "utf-8"))
      print(`使用外部参考快照: ${args.ref}`)
    } catch (err) {
      printError(`加载外部参考快照失败: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
  }

  print("nmem 快照重编译脚本 — v0.10.124 远程/本地双兼容版")
  print(`API 基址: ${args.baseUrl} | 鉴权: ${args.apiKey ? "Bearer Token 已加载" : "未设置（仅匿名本地可用）"}`)

  printSection("步骤 1/5：探活（ping）")
  const health = await probeNmemHealth(args.baseUrl, args.apiKey)
  if (!health.healthy) {
    print("⚠  离线环境 — graceful skip（exit 0）")
    print(`原因: ${health.detail ?? "无法连接 nmem server"}`)
    return 0
  }

  printSection("步骤 2/5：抓取（live snapshot fetch）")
  const fetchResult = await fetchLiveSnapshot(args.baseUrl, args.apiKey, health.version, ref)
  if (!fetchResult.ok) {
    printError(`抓取失败: ${fetchResult.error}`)
    print(generateCorrectionGuide(fetchResult.error, health.version, args.baseUrl))
    return 1
  }

  const liveSnapshot = fetchResult.data
  print(`✅ 抓取成功 — ${liveSnapshot.memories.length} memories, ${liveSnapshot.skills.length} skills`)

  if (args.output) {
    writeFileSync(args.output, `${JSON.stringify(liveSnapshot, null, 2)}\n`, "utf-8")
    print(`快照已落盘: ${args.output}`)
  }

  printSection("步骤 3/5：validate（schema/digest 校验）")
  const validation = validateSnapshot(liveSnapshot)
  if (!validation.ok) {
    printError("校验未通过:")
    for (const v of validation.violations) printError(`  ${v.path}: ${v.message}`)
    return 1
  }
  print("✅ 校验通过 — 结构完整")

  printSection("步骤 4/5：diff（与现有快照对比）")
  const changes = diffSnapshot(liveSnapshot, ref)
  if (changes.length === 0) {
    print("✅ 无差异 — 当前快照已是最新")
  } else {
    print(`发现 ${changes.length} 项差异:`)
    for (const c of changes) print(`  • ${c.field}: ${c.before} → ${c.after}`)
  }

  printSection("步骤 5/5：升版提示")
  console.log(generateUpgradeSuggestion(changes, liveSnapshot, ref))
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    printError(`未捕获异常: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
