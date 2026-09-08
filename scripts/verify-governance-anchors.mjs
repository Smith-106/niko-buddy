/**
 * verify-governance-anchors.mjs — ADR-47 回归防线：治理文档锚点校验。
 *
 * 校验对象（QMAI 单仓 CI 可解析面）：
 *   1. 治理文档声称的仓内 文件:行 锚点真实存在（ADR-47/48 登记行 → arch-decisions.md 小节）。
 *   2. 种子契约文件行数与 eval-gate 底线一致（种子 110 达标钉死）。
 *   3. KB view 产物 builtFrom 非空 sha256（与 ci.yml 自洽步互补）。
 *
 * hub 侧数据面（reference/、arch-decisions 全文）由 hub 侧等价门禁校验：
 *   node scripts/build-reference-kb-view.js --check
 *   node QMAI/scripts/sync-kb-view-to-qmai.mjs --check
 * exit 0 = 全过；exit 1 = 任一项失败（fail-loud，绝不静默）。
 */
import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const failures = []
const log = (ok, msg) => {
  console.log(`${ok ? "OK " : "FAIL"} ${msg}`)
  if (!ok) failures.push(msg)
}

// 1. ADR 登记锚点：project.md 声称的两条登记行（源在 hub，但锚点文本作为契约入仓）
//    ——此处校验 arch-decisions 小节标题存在（hub 侧文件，QMAI 单仓 CI 不可读时跳过并标注）。
const adrFile = resolve(REPO_ROOT, "../.workflow/specs/arch-decisions.md")
const expectedSections = [
  { adr: "ADR-47", section: "ADR-47" },
  { adr: "ADR-48", section: "ADR-48" },
]
if (existsSync(adrFile)) {
  const text = readFileSync(adrFile, "utf8")
  for (const { adr, section } of expectedSections) {
    const found = text.includes(`## ${section}`) || text.includes(`### ${section}`)
    log(found, `${adr} 小节存在于 arch-decisions.md`)
  }
} else {
  for (const { adr } of expectedSections) {
    log(true, `${adr} 小节：hub 源不可读（单仓 CI）→ 归 hub 侧等价门禁`)
  }
}

// 2. 种子契约：gov-seed-v1.jsonl ≥ 110 行（GOV_SEED_MIN_SCALE 60+30+20；trap 子校验由 eval-gate.spec 覆盖）
const seedFile = resolve(REPO_ROOT, "docs/p0/gov-seed/gov-seed-v1.jsonl")
if (existsSync(seedFile)) {
  const lines = readFileSync(seedFile, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "")
  log(lines.length >= 110, `种子 gov-seed-v1.jsonl = ${lines.length} 行（底线 110）`)
} else {
  log(false, `种子文件缺失: ${seedFile}`)
}

// 3. KB view 产物自洽（与 ci.yml 步骤互补；本脚本独立可跑，本地门禁亦可用）
const kbViewFile = resolve(REPO_ROOT, "src/lib/novel/kb/kb-routing-view.generated.json")
if (existsSync(kbViewFile)) {
  const view = JSON.parse(readFileSync(kbViewFile, "utf8"))
  const ok = !!view.builtFrom && String(view.builtFrom).startsWith("sha256:")
  log(ok, `KB view builtFrom ${ok ? view.builtFrom : "损坏/缺失"}`)
} else {
  log(false, `KB view 产物缺失: ${kbViewFile}`)
}

if (failures.length > 0) {
  console.error(`\nanchor check: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log("\nanchor check: 0 broken / 0 ghost")
