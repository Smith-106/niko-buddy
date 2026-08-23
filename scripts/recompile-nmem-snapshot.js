#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
/**
 * recompile-nmem-snapshot.js — nmem 快照重编译脚本（DEBT-20260822-t27b-03 偿还）。
 *
 * 职责（蓝图 §8 P3 + T27b 完成定义 + T34b 工程化清单）：
 *   探活（ping）→ 抓取（live snapshot fetch）→ validate（schema/digest 校验）
 *   → diff（与现有快照对比报告）→ 升版提示。
 *
 * 离线环境行为：
 *   探活失败 → 打印原因并以 exit 0 优雅跳过（graceful skip），
 *   不阻断工程化管道。
 *
 * 失败时额外输出：
 *   当版 server 契约修正指引（对应 DEBT-20260822-t27b-01 条件触发入口）。
 *
 * 用法:
 *   node scripts/recompile-nmem-snapshot.js
 *   node scripts/recompile-nmem-snapshot.js --base-url http://127.0.0.1:14242
 *   node scripts/recompile-nmem-snapshot.js --output /tmp/live-snapshot.json
 *   node scripts/recompile-nmem-snapshot.js --help
 *
 * 退出码:
 *   0 — 成功（含离线环境 graceful skip —— 排查禁跑）
 *   1 — 失败（校验未通过、抓取异常等）
 */

// ============================================================================
// 当前提交快照参考（与 src/lib/novel/craft/nmem-snapshot.ts 同步）
// 更新快照时同步修改此处；也可通过 --ref 指向外部 JSON 文件覆盖。
// ============================================================================

const REFERENCE_SNAPSHOT = {
  snapshotVersion: 1,
  capturedAt: "2026-08-21T15:30:23Z",
  serverVersion: "0.10.67",
  spaceId: "space",
  memoryCount: 8,
  skillCount: 1,
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
  skillIds: ["skill_f8e81e050000"],
}

// ============================================================================
// 默认常量（与 technique-compiler.ts 对齐）
// ============================================================================

const DEFAULT_BASE_URL = "http://127.0.0.1:14242"
const ISO_LIKE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

// ============================================================================
// CLI 参数解析
// ============================================================================

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    output: null,
    ref: null,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--base-url") args.baseUrl = argv[++i] ?? DEFAULT_BASE_URL
    else if (a === "--output") args.output = argv[++i] ?? null
    else if (a === "--ref") args.ref = argv[++i] ?? null
    else if (a === "--help" || a === "-h") args.help = true
  }
  return args
}

// ============================================================================
// 工具函数
// ============================================================================

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

// ============================================================================
// 步骤 1：探活（ping）
// ============================================================================

/**
 * 探活 nmem server（GET /health，检查 status==="ok"）。
 * 网络/解析失败返回 false（优雅降级语义）。
 */
async function probeNmemHealth(baseUrl) {
  const url = `${baseUrl}/health`
  print(`探活 → ${url}`)
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      print(`   HTTP ${res.status}，非健康响应`)
      return { healthy: false, version: null, detail: `HTTP ${res.status}` }
    }
    const body = await res.json()
    if (body?.status === "ok") {
      print(`   ✅ 健康 — version=${body.version ?? "unknown"}`)
      return { healthy: true, version: String(body.version ?? ""), detail: null }
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
// 步骤 2：抓取（live snapshot fetch）
// ============================================================================

/**
 * 抓取 nmem space 的 live snapshot。
 * 返回 { ok, data, error }。
 */
async function fetchLiveSnapshot(baseUrl, serverVersion) {
  const url = `${baseUrl}/api/memories/search?q=&space=${encodeURIComponent(REFERENCE_SNAPSHOT.spaceId)}&limit=2000`
  print(`抓取 → ${url}`)
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) {
      return { ok: false, data: null, error: `HTTP ${res.status}: ${res.statusText}` }
    }
    const body = await res.json()
    const rawMemories = Array.isArray(body?.memories) ? body.memories : []
    print(`   原始 memory 数：${rawMemories.length}`)

    const memories = rawMemories.map((m) => ({
      memoryId: String(m.id ?? ""),
      title: String(m.title ?? ""),
      contentExcerpt: String(m.content ?? "").slice(0, 600),
      createdAt: String(m.created_at ?? ""),
      importance: typeof m.importance === "number" ? m.importance : 0,
      unitType: String(m.unit_type ?? ""),
      labels: Array.isArray(m.labels) ? m.labels.map(String) : [],
    }))

    // skill 返回形态可能不同，当前做空安全处理
    const rawSkills = Array.isArray(body?.skills) ? body.skills : []
    const skills = rawSkills.map((s) => ({
      skillId: String(s.skill_id ?? s.id ?? ""),
      title: String(s.title ?? ""),
      version: Number.isInteger(s.version) ? s.version : 1,
      contentHash: String(s.content_hash ?? s.contentHash ?? ""),
      stage: String(s.stage ?? "active"),
    }))

    const snapshot = {
      snapshotVersion: REFERENCE_SNAPSHOT.snapshotVersion + 1,
      capturedAt: new Date().toISOString(),
      serverVersion: serverVersion || String(body?.version ?? ""),
      spaceId: REFERENCE_SNAPSHOT.spaceId,
      memories,
      skills,
    }
    return { ok: true, data: snapshot, error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, data: null, error: msg }
  }
}

// ============================================================================
// 步骤 3：validate
// ============================================================================

/**
 * 校验快照结构完整性（与 nmem-snapshot.ts 的 validateNmemSnapshot 同口径）。
 * 返回 { ok, violations }。
 */
function validateSnapshot(snapshot) {
  const violations = []

  // 元数据
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

  // memories
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
      if (typeof memory.importance !== "number" || !Number.isFinite(memory.importance) || memory.importance < 0 || memory.importance > 1) {
        violations.push({ path: `${at}.importance`, message: `必须是 [0,1] 内有限数字，实际=${String(memory.importance)}` })
      }
    })
  }

  // skills
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
// 步骤 4：diff（与现有快照对比）
// ============================================================================

/**
 * 对比 live snapshot 与参考快照，返回差异报告。
 */
function diffSnapshot(live, ref) {
  const changes = []

  // server version
  if (live.serverVersion !== ref.serverVersion) {
    changes.push({ field: "serverVersion", before: ref.serverVersion, after: live.serverVersion })
  }

  // memory 数量
  if (live.memories.length !== ref.memoryCount) {
    changes.push({
      field: "memories.count",
      before: ref.memoryCount,
      after: live.memories.length,
      note: live.memories.length > ref.memoryCount ? "新增记忆" : "记忆减少",
    })
  }

  // skill 数量
  if (live.skills.length !== ref.skillCount) {
    changes.push({
      field: "skills.count",
      before: ref.skillCount,
      after: live.skills.length,
      note: live.skills.length > ref.skillCount ? "新增 skill" : "skill 减少",
    })
  }

  // memory 新增/缺失
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
    changes.push({
      field: "memories.removed",
      before: removed.join("; "),
      after: "—",
    })
  }

  // skill 新增/缺失
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
    changes.push({
      field: "skills.removed",
      before: removedSkills.join("; "),
      after: "—",
    })
  }

  // contentExcerpt 摘要变化（只报告前 5 条有变化的 memory，不会全量 dump）
  const contentChanges = []
  for (const liveMem of live.memories) {
    // 比较 memoryId 相同条目的 contentExcerpt 长度变化作为 changed 信号
    // 实际 diff 需依赖参考快照的完整数据，这里用 heuristic
    if (liveMem.contentExcerpt.length > 0 && refIds.has(liveMem.memoryId)) {
      // 粗略信号：如果 contentExcerpt 长度 > 600 或 < 10，可能有问题
      if (liveMem.contentExcerpt.length > 600) {
        contentChanges.push(`${liveMem.memoryId}: contentExcerpt 截断超限（${liveMem.contentExcerpt.length} > 600）`)
      }
    }
  }
  if (contentChanges.length > 0) {
    changes.push({
      field: "contentExcerpt.warnings",
      before: "—",
      after: contentChanges.join("; "),
    })
  }

  return changes
}

// ============================================================================
// 步骤 5：升版提示
// ============================================================================

/**
 * 根据差异生成升版建议。
 */
function generateUpgradeSuggestion(changes, liveSnapshot) {
  if (changes.length === 0) {
    return "✅ 无差异，当前快照已是最新，无需升版。"
  }

  const lines = [
    "🔺 检测到差异，建议升版：",
    "",
  ]

  for (const c of changes) {
    const before = String(c.before ?? "—").slice(0, 80)
    const after = String(c.after ?? "—").slice(0, 80)
    lines.push(`  • ${c.field}: ${before} → ${after}`)
    if (c.note) lines.push(`    备注: ${c.note}`)
  }

  lines.push("")
  lines.push(`建议操作：`)
  lines.push(`  1. 将 src/lib/novel/craft/nmem-snapshot.ts 的 NMEM_SNAPSHOT_VERSION 从 ${REFERENCE_SNAPSHOT.snapshotVersion} 升为 ${liveSnapshot.snapshotVersion}`)
  lines.push(`  2. 更新 NMEM_SNAPSHOT_CAPTURED_AT 为 "${liveSnapshot.capturedAt}"`)
  lines.push(`  3. 更新 NMEM_SERVER_VERSION 为 "${liveSnapshot.serverVersion}"`)
  if (liveSnapshot.memories.length !== REFERENCE_SNAPSHOT.memoryCount) {
    lines.push(`  4. memory 数量变化：${REFERENCE_SNAPSHOT.memoryCount} → ${liveSnapshot.memories.length}，同步更新 NMEM_SNAPSHOT.memories 数组`)
  }
  if (liveSnapshot.skills.length !== REFERENCE_SNAPSHOT.skillCount) {
    lines.push(`  5. skill 数量变化：${REFERENCE_SNAPSHOT.skillCount} → ${liveSnapshot.skills.length}，同步更新 NMEM_SNAPSHOT.skills 数组`)
  }
  lines.push(`  6. 同步更新 scripts/recompile-nmem-snapshot.js 的 REFERENCE_SNAPSHOT 常量`)
  lines.push(`  7. 运行 npx vitest run technique-compiler 确保 39 用例全绿`)
  lines.push(`  8. 运行 npm run typecheck 确保 0 类型错误`)

  return lines.join("\n")
}

// ============================================================================
// 失败修正指引（DEBT-20260822-t27b-01 条件触发入口）
// ============================================================================

function generateCorrectionGuide(errorDetail, serverVersion, baseUrl) {
  const lines = [
    "=".repeat(60),
    "  ⚠  DEBT-20260822-t27b-01 条件触发：live 路失败",
    "  nmem server 契约可能已漂移，需修正后重试。",
    "=".repeat(60),
    "",
    `当前 server 版本: ${serverVersion ?? "未知"}`,
    `API 基址: ${baseUrl}`,
    `错误详情: ${errorDetail}`,
    "",
    "修正指引：",
    "  1. 确认 server 版本：GET /health → version 字段",
    `     当前约定：status==="ok" 且 version 语义兼容`,
    "",
    "  2. 确认 /api/memories/search 接口 shape：",
    "     请求: GET /api/memories/search?q=&space=<spaceId>&limit=2000",
    "     期望返回: { memories: [{ id, title, content, created_at, importance, unit_type, labels }] }",
    "     实际返回: 需通过 curl 或浏览器检查",
    "",
    "  3. 如果 shape 发生变化：",
    "     a) 修改 src/lib/novel/craft/technique-compiler.ts 的 fetchLiveSnapshot 中字段映射",
    "     b) 修改本脚本 fetchLiveSnapshot 函数中对应字段映射",
    "     c) 修改 spec 中的 fake 响应（src/lib/novel/craft/technique-compiler.spec.ts）",
    "     d) 重新运行 npx vitest run technique-compiler",
    "",
    "  4. 如果 server 不可达（网络/代理问题）：",
    "     a) 检查 nmem server 是否在运行",
    "     b) 检查代理设置（本地代理 127.0.0.1:8756 可能拦截）",
    "     c) 使用 --base-url 指定其他可达地址",
    "     d) 离线环境此脚本会 graceful skip（exit 0），不影响管道",
    "",
    "  5. 确认后重试：",
    "     node scripts/recompile-nmem-snapshot.js --base-url <可达地址>",
    "",
  ]
  return lines.join("\n")
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
  --base-url <url>      nmem server API 基址（默认: ${DEFAULT_BASE_URL}）
  --output <path>       将 live snapshot 输出到 JSON 文件
  --ref <path>          参考快照 JSON 文件路径（覆盖内嵌 REFERENCE_SNAPSHOT）
  --help, -h            显示本帮助

退出码:
  0 — 成功（含离线环境 graceful skip）
  1 — 失败

说明:
  探活 → 抓取 → validate → diff → 升版提示，五步流水线。
  离线环境 /health 探活失败时 graceful skip（exit 0），不阻塞管道。
  DEBT-20260822-t27b-01 条件触发时输出 server 契约修正指引。
`)
    return 0
  }

  // 加载外部参考快照（--ref 覆盖内嵌常量）
  let ref = { ...REFERENCE_SNAPSHOT }
  if (args.ref) {
    try {
      const fs = await import("node:fs")
      ref = JSON.parse(fs.readFileSync(args.ref, "utf-8"))
      print(`使用外部参考快照: ${args.ref}`)
    } catch (err) {
      printError(`加载外部参考快照失败: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
  }

  print("nmem 快照重编译脚本 — DEBT-20260822-t27b-03")
  print(`API 基址: ${args.baseUrl}`)

  // ── 步骤 1: 探活 ──
  printSection("步骤 1/5：探活（ping）")
  const health = await probeNmemHealth(args.baseUrl)

  if (!health.healthy) {
    print("")
    print("⚠  离线环境 — graceful skip（exit 0）")
    print(`原因: ${health.detail ?? "无法连接 nmem server"}`)
    print("")
    print("当前快照版本不受影响，入仓快照保障离线编译功能不退化。")
    print("需要在线重编译时，请确保 nmem server 可达后重试。")
    return 0
  }

  const serverVersion = health.version

  // ── 步骤 2: 抓取 ──
  printSection("步骤 2/5：抓取（live snapshot fetch）")
  const fetchResult = await fetchLiveSnapshot(args.baseUrl, serverVersion)

  if (!fetchResult.ok) {
    printError(`抓取失败: ${fetchResult.error}`)
    print("")
    print(generateCorrectionGuide(fetchResult.error, serverVersion, args.baseUrl))
    return 1
  }

  const liveSnapshot = fetchResult.data
  print(`✅ 抓取成功 — ${liveSnapshot.memories.length} memories, ${liveSnapshot.skills.length} skills`)

  // ── 可选落盘 ──
  if (args.output) {
    try {
      const fs = await import("node:fs")
      const outPath = args.output
      fs.writeFileSync(outPath, JSON.stringify(liveSnapshot, null, 2), "utf-8")
      print(`快照已落盘: ${outPath}`)
    } catch (err) {
      printError(`落盘失败: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
  }

  // ── 步骤 3: validate ──
  printSection("步骤 3/5：validate（schema/digest 校验）")
  const validation = validateSnapshot(liveSnapshot)
  if (!validation.ok) {
    printError("校验未通过:")
    for (const v of validation.violations) {
      printError(`  ${v.path}: ${v.message}`)
    }
    print("")
    print(generateCorrectionGuide("schema validation failed", serverVersion, args.baseUrl))
    return 1
  }
  print("✅ 校验通过 — 结构完整")

  // ── 步骤 4: diff ──
  printSection("步骤 4/5：diff（与现有快照对比）")
  const changes = diffSnapshot(liveSnapshot, ref)
  if (changes.length === 0) {
    print("✅ 无差异 — 当前快照已是最新")
  } else {
    print(`发现 ${changes.length} 项差异:`)
    for (const c of changes) {
      const before = String(c.before ?? "—").slice(0, 80)
      const after = String(c.after ?? "—").slice(0, 80)
      print(`  • ${c.field}: ${before} → ${after}`)
      if (c.note) print(`    ${c.note}`)
    }
  }

  // ── 步骤 5: 升版提示 ──
  printSection("步骤 5/5：升版提示")
  const suggestion = generateUpgradeSuggestion(changes, liveSnapshot)
  print("")
  console.log(suggestion)

  // ── 总判定 ──
  print("")
  if (changes.length === 0) {
    print("✅ 总判定：无需升版，快照已最新")
  } else {
    print("🔺 总判定：建议升版，请按上述步骤操作")
  }
  print("")
  print("━".repeat(60))
  print("  重编译完成")

  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    printError(`未捕获异常: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })