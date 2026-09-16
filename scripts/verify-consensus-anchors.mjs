// verify-consensus-anchors.mjs — 共识撤销锚点机器校验（DeepSeek 轮3 撤销条件 a-e + 映射表在仓）。
// 用法：node scripts/verify-consensus-anchors.mjs（QMAI 根执行，exit 0 = 全 PASS）。
// 只读文件断言，不改任何产物；输出 PASS/FAIL逐项 + 汇总（ASCII only，防 PS 乱码）。
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => readFileSync(join(ROOT, rel), "utf8")

const CHECKS = [
  { id: "A1-kind-first", file: "src/lib/novel/run-event-ledger.ts", pattern: /if \(event\.kind !== "gate-run"/, note: "readGateRunPayload kind 首查，stage 系结构隔离" },
  { id: "A2-arm-conjunction", file: "src/lib/novel/director-modes.ts", pattern: /reason: `gate_not_evaluated/, note: "arm 缺事件 fail-closed" },
  { id: "A2b-arm-allpass", file: "src/lib/novel/director-modes.ts", pattern: /all_required_gates_pass/, note: "arm 仅全 pass 合取" },
  { id: "A3-appliesTo-required", file: "src/lib/novel/prompt-artifacts.ts", pattern: /appliesTo: z\.string\(\)\.min\(1\)/, note: "appliesTo 必填无 default" },
  { id: "A3b-assert-consumer", file: "src/lib/novel/visual-lineage.ts", pattern: /artifact\.appliesTo !== VISUAL_APPLIES_TO/, note: "唯一消费方 fail-loud" },
  { id: "A4-single-writer", file: "src/lib/novel/auto-arm-status.ts", pattern: /patch\.draft_status === "ready" && current === "pending"/, note: "唯一自动化写入者精确匹配仅产 ready" },
  { id: "A5-containment-spec", file: "src/lib/novel/dashboard-evidence.spec.ts", pattern: /事件收容矩阵回归/, note: "收容回归测试存在" },
  { id: "A6-matrix-comment", file: "src/lib/novel/run-event-ledger.ts", pattern: /事件种类收容矩阵/, note: "收容矩阵契约注释固化" },
  { id: "A7-mapping-table", file: "docs/consensus/coverage-mapping.md", pattern: /^\| 16 \|/m, note: "16 模块映射表在仓" },
]

let failed = 0
for (const check of CHECKS) {
  const path = join(ROOT, check.file)
  if (!existsSync(path)) {
    console.log(`FAIL ${check.id} (${check.file} 缺失)`)
    failed += 1
    continue
  }
  if (check.pattern.test(read(check.file))) {
    console.log(`PASS ${check.id} — ${check.note}`)
  } else {
    console.log(`FAIL ${check.id} (${check.file} 未命中模式)`)
    failed += 1
  }
}
console.log(failed === 0 ? `ALL PASS (${CHECKS.length}/${CHECKS.length})` : `FAILURES: ${failed}/${CHECKS.length}`)
process.exit(failed === 0 ? 0 : 1)
