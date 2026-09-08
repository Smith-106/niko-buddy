/**
 * verify-dod-v267.js — v2.6.7 DoD 断言（蓝图 blueprint-v267 §3）
 *
 * 断言：黄金基线 manifest/漂移探针/埋点事件/契约 schema/提交纪律
 * 用法：node scripts/verify-dod-v267.js
 */
import { probeDrift, verifyStructural, structuralFingerprint } from "../src/lib/quality/golden-baseline.ts"
import { validateTelemetryEvent, privacyGate, shouldRoll } from "../src/lib/quality/telemetry.ts"
import { validateStatusSchema, STATUS_SCHEMA_VERSION } from "../src/lib/quality/status-schema.ts"
import { checkCommitDiscipline } from "../src/lib/quality/commit-discipline.ts"

let failures = 0
const check = (name, cond) => {
  if (cond) console.log(`[PASS] ${name}`)
  else { console.log(`[FAIL] ${name}`); failures++ }
}

// D1: 黄金基线（漂移探针 + 结构性约束）
const manifest = {
  schemaVersion: "golden-v1", commitSha: "abc", toolchain: { rust: "1.80", node: "24.19.0", tauri: "2.0" },
  buildArgs: ["--release"],
  artifacts: [{ path: "app.exe", sha256: "hash-a" }],
  structuralFingerprint: structuralFingerprint(),
}
check("D1 漂移探针: 一致", probeDrift(manifest, [{ path: "app.exe", sha256: "hash-a" }]).consistent === true)
check("D1 漂移探针: mismatch fail", probeDrift(manifest, [{ path: "app.exe", sha256: "x" }]).consistent === false)
check("D1 门控顺序不变量", verifyStructural(["Consistency(P0)", "Anti-AI(P1)", "Quality(P2)"]) === true)
check("D1 Quality 不得覆盖 Consistency", verifyStructural(["Quality(P2)", "Anti-AI(P1)", "Consistency(P0)"]) === false)

// D2: 埋点（3 事件 + 隐私门 + 滚动）
check("D2 事件白名单", validateTelemetryEvent({ type: "app_launch", ts: "t", payload: {} }).length === 0)
check("D2 未知事件拒绝", validateTelemetryEvent({ type: "chapter_save", ts: "t", payload: {} }).length > 0)
check("D2 隐私门 disabled 拒绝", privacyGate("disabled") === false)
check("D2 10MB 滚动", shouldRoll(10 * 1024 * 1024) === true)

// D3: 契约（schema 校验）
const valid = { schemaVersion: STATUS_SCHEMA_VERSION, chapters: [], memories: [], settings: {}, updatedAt: "t" }
check("D3 合法 status 通过", validateStatusSchema(valid).valid === true)
check("D3 未知字段拒绝", validateStatusSchema({ ...valid, extra: 1 }).valid === false)
check("D3 非法章节状态拒绝", validateStatusSchema({ ...valid, chapters: [{ id: "c", status: "draft" }] }).valid === false)

// D4: 提交纪律（单章闭环）
check("D4 单章闭环合规", checkCommitDiscipline({ chapterIds: ["ch1"], touchesStatusJson: true, touchesCanonicalContent: true, touchesCanonicalMemory: true }).ok === true)
check("D4 跨章批量拒绝", checkCommitDiscipline({ chapterIds: ["ch1", "ch2"], touchesStatusJson: true, touchesCanonicalContent: true, touchesCanonicalMemory: true }).ok === false)
check("D4 正文记忆成对", checkCommitDiscipline({ chapterIds: ["ch1"], touchesStatusJson: true, touchesCanonicalContent: true, touchesCanonicalMemory: false }).ok === false)

console.log(failures === 0 ? "\nDoD v2.6.7: ALL PASS" : `\nDoD v2.6.7: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
