/**
 * scale-unlock-report.spec — R2 现役规模可观测输出（逐谓词 locked 理由）。
 *
 * 输入绑定（真实产物，非构造）：
 *   - 语料规模 ← kb-routing-view.generated.json collectionCounts（写作面四 collection 合计）
 *   - R0-b 证据面 ← docs/p0/rerank-trigger-evidence-<date>.md 存在性 + status 行
 *     （并与 golden `_meta.rerankTrigger` 交叉校验；产物不存在 → 谓词 locked，hard check）
 *   - λ ← RETRIEVAL_LAMBDA_INITIAL（R0-d 输出；calibrated=false）
 *   - 同源簇 / 扇出探针 ← 现役缺失（null）→ 相应谓词 locked
 *   - 文档结构 ← docs/kb-flag-promotion-flow.md 存在性
 *   - span 面 ← R0-c 契约序（六 stage；search-adapter.spec 真实链路已证适配器全量落 span）
 *
 * 常态零副作用（console.log 可观测输出）；`SCALE_UNLOCK_REPORT=1` 门控写
 * docs/p0/scale-unlock-<YYYYMMDD>.md（报告为门控产物，docs/ 被 gitignore，靠本 spec 重生成）。
 *
 * @license MIT © QMAI
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { evaluateUnlockGates, formatUnlockGateReport, type ScaleUnlockCtx } from "./scale-unlock-gates"
import { RETRIEVAL_LAMBDA_INITIAL } from "./retrieval-budget"
import { RETRIEVAL_SPAN_STAGES } from "./retrieval-span"
import kbRoutingView from "./kb/kb-routing-view.generated.json"

const REPO_ROOT = resolve(__dirname, "..", "..", "..")
const P0_DIR = resolve(REPO_ROOT, "docs", "p0")
const WRITING_COLLECTIONS = ["world_ref", "lexicon", "craft", "corpus"] as const

function readGoldRerankStatus(): "triggered" | "armed" {
  const golden = JSON.parse(
    readFileSync(resolve(__dirname, "__fixtures__", "golden-queries.json"), "utf8"),
  ) as { _meta?: { rerankTrigger?: { status?: string } } }
  const status = golden._meta?.rerankTrigger?.status
  return status === "triggered" ? "triggered" : "armed"
}

function findRerankEvidenceArtifact(): { path: string; status: "triggered" | "armed"; text: string } | null {
  if (!existsSync(P0_DIR)) return null
  const file = readdirSync(P0_DIR).find((f) => /^rerank-trigger-evidence-\d{4}-\d{2}-\d{2}\.md$/.test(f))
  if (!file) return null
  const text = readFileSync(resolve(P0_DIR, file), "utf8")
  const status: "triggered" | "armed" = /status：\*\*triggered\*\*/.test(text) ? "triggered" : "armed"
  return { path: resolve(P0_DIR, file), status, text }
}

const counts = (kbRoutingView as unknown as { collectionCounts: Record<string, number> })
  .collectionCounts
const corpusEntries = WRITING_COLLECTIONS.reduce((sum, c) => sum + (counts[c] ?? 0), 0)
const artifact = findRerankEvidenceArtifact()
const goldStatus = readGoldRerankStatus()

/** 现役 ctx（产物缺失时 present=false → 谓词 hard-lock）。 */
const liveCtx: ScaleUnlockCtx = {
  schemaVersion: 1,
  corpusEntries,
  chunkCount: 0,
  rerankEvidence: { present: artifact !== null, evidence: null },
  sameCluster: null,
  lambda: RETRIEVAL_LAMBDA_INITIAL,
  fanoutProbe: null,
  docs: { promotionFlowDocPresent: existsSync(resolve(REPO_ROOT, "docs", "kb-flag-promotion-flow.md")) },
  spans: { observedStages: [...RETRIEVAL_SPAN_STAGES] },
}

describe("R2 现役规模可观测输出", () => {
  const report = evaluateUnlockGates(liveCtx)

  it("现役规模 = 80（world_ref 18 + lexicon 44 + craft 12 + corpus 6）", () => {
    expect(corpusEntries).toBe(80)
    expect(report.scale.corpusEntries).toBe(80)
  })

  it("R0-b 产物存在且与 golden _meta 状态一致（存在性硬检查的输入有效）", () => {
    expect(artifact).not.toBeNull()
    expect(artifact!.status).toBe(goldStatus)
  })

  it("逐谓词可观测输出：四目标全部 locked，各有理由（含规模理由）", () => {
    const text = formatUnlockGateReport(report)
    // 可观测输出落 stdout（人工审计/CI 日志）
    console.log(text)
    expect(text).toContain("corpus=80")
    expect(text).toContain("locked=4")
    expect(report.nominatedTargets).toEqual([])
    expect(report.decisions.map((d) => d.reasonCode)).toEqual([
      "rr_corpus_below_threshold",
      "mmr_corpus_below_threshold",
      "fanout_corpus_below_threshold",
      "ann_no_implementation",
    ])
    for (const d of report.decisions) {
      expect(d.reason.length).toBeGreaterThan(8)
    }
  })

  it("λ 现役值为未标定初值（25 ms/pp, calibrated=false）——MMR 谓词口径就绪但规模未达", () => {
    expect(report.thresholds["corpusMinEntries"]).toBe(1000)
    expect(liveCtx.lambda?.value).toBe(25)
    expect(liveCtx.lambda?.calibrated).toBe(false)
  })

  it("提名≠开启：报告不写配置（configMutated=false，全部 appliesToConfig=false）", () => {
    expect(report.configMutated).toBe(false)
    for (const d of report.decisions) expect(d.appliesToConfig).toBe(false)
  })

  it("门控写盘（SCALE_UNLOCK_REPORT=1）：docs/p0/scale-unlock-<date>.md；常态零副作用", () => {
    if (process.env["SCALE_UNLOCK_REPORT"] !== "1") {
      expect(existsSync(P0_DIR)).toBe(true) // 常态下不新增文件（仅断言目录存在）
      return
    }
    const stamp = new Date().toISOString().slice(0, 10)
    const out = resolve(P0_DIR, `scale-unlock-${stamp}.md`)
    const body = [
      `# 解冻提名谓词可观测报告（${stamp}）`,
      "",
      "## 输入绑定",
      "",
      `- 语料规模：${corpusEntries}（kb-routing-view.generated.json collectionCounts 写作面合计：${WRITING_COLLECTIONS.map((c) => `${c} ${counts[c] ?? 0}`).join(" / ")}）`,
      `- builtFrom：${(kbRoutingView as unknown as { builtFrom?: string }).builtFrom ?? "n/a"}`,
      `- R0-b 证据产物：${artifact ? artifact.path : "缺失（谓词 hard-lock）"}`,
      `- R0-d λ：${RETRIEVAL_LAMBDA_INITIAL.value} ${RETRIEVAL_LAMBDA_INITIAL.unit}（calibrated=${RETRIEVAL_LAMBDA_INITIAL.calibrated}）`,
      `- 同源簇实证：缺失（null）；扇出探针：缺失（null）`,
      `- 文档结构：kb-flag-promotion-flow.md ${liveCtx.docs.promotionFlowDocPresent ? "存在" : "缺失"}`,
      "",
      "## 判定（逐谓词）",
      "",
      "```",
      formatUnlockGateReport(report),
      "```",
      "",
      "## 口径声明",
      "",
      "- 提名 ≠ 开启：本报告只记录提名谓词输出，不改任何默认值（dualKbRouting/usefulnessRerank 默认 false，hardInject 默认 true）。",
      "- 开启路径：docs/kb-flag-promotion-flow.md 双臂离线评测（consistencyNoRegression && qualityGain && seedCaseCoverage ≥ MIN_SEED）→ gate PASS 判据包（ADR-48）。",
      "- 阈值 1000 语料 / 1e4 chunk / 30 簇均为**待标定初值**（非同源矩阵缺失期间不得当作已标定口径）。",
      "- MMR 净增益口径：净增益(pp) = 同源簇内 top3 增益(pp) − p95 延迟增量(ms) / λ(ms_per_pp)。",
      "- ANN 保持 locked（理由=无实现；版本前缀谓词已删除）。",
      "",
      "## status.json 同步位",
      "",
      "- 本报告为证据快照，未写入 `.novel/status.json`（状态真源唯一）；flag 默认值不变。",
      "",
    ].join("\n")
    mkdirSync(P0_DIR, { recursive: true })
    writeFileSync(out, body, "utf8")
    expect(existsSync(out)).toBe(true)
  })
})
