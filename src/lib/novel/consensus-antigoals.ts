/**
 * consensus-antigoals.ts — R-1 共识六条反目标纯函数判定核。
 *
 * 共识来源：DeepSeek-flash + GLM-5.2 两路探讨共识 §5 六条反目标
 * （qwen3.8-flash 配额不足本轮弃用）；批准计划 r2 §1 映射表 / R-1，
 * planHandoffKey 738a75141a5a6b2386f8b38eef21ef600dedf9461eca4972037b2f0b68f55113。
 *
 * 两层门禁分工：
 *   - 本模块 = 纯函数判定核（输入快照对象 → 输出违禁清单，零 IO，可单元测试）；
 *   - `scripts/guard-consensus-antigoals.mjs` = IO 采集层（读语料计数 / flag
 *     默认值 / 文件清单组装快照并执行等价判定，exit 0 通过 / 2 违禁）。
 *   .mjs 无法 import TS，两层判定逻辑互为镜像（改一处须改另一处，同步点见各常量注释）。
 *
 * 六条反目标：
 *   AG1 禁全量导入 W——corpus 条目数不得超 AG1_MAX_CORPUS_ENTRIES
 *       （现役 6 条，W 全量约 2435；增量策展走 R1 管线 + curation-gate）；
 *   AG2 禁提前开重机制——三检索 flag 必须等于期望默认值，任何翻转走
 *       `docs/kb-flag-promotion-flow.md` 双臂证据门（ADR-48：裁决≠开启）；
 *   AG3 禁同源自证——docs/p0 下出现收敛声称而无豁免标记即违禁；
 *   AG4 禁 novel 外平行复制检索主链——核心检索函数定义只许在 src/lib/novel/ 内；
 *   AG5 禁 P2 越门——rule-stack.ts 必须保留 Quality 永不短路护栏 + 优先级顺序引用；
 *   AG6 禁扩容跑在证据面之前——corpus 超基线时必须已有 R0-b 产物 + 同尺报告
 *       （任一缺失则直接 locked，防同源污染外溢；AG6 只看 corpus 集合，
 *       R1 的 world_ref/lexicon 资产填空不属"语料扩容"）。
 *
 * 机械层（ADR-19）：纯函数 + zod，零 IO / 零时钟 / 零模型调用。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"

// ============================================================================
// 阈值与期望常量（同步点：改一处须同步 scripts/guard-consensus-antigoals.mjs）
// ============================================================================

/** AG1：corpus 集合条目上限。现役 6 条；W 全量约 2435；上限允许增量策展、拦截整库导入。 */
export const AG1_MAX_CORPUS_ENTRIES = 64

/** AG6：corpus 基线规模（2026-09-16 实测 6 条）。超基线即视为"扩容"，须先有证据面文件。 */
export const CORPUS_BASELINE_COUNT = 6

/**
 * AG2：重机制 flag 期望默认值（hardInject=true 为 2026-09-07 三模型共识等效证据替代已翻转值，
 * 其余 false；真源 = src/stores/wiki-store.ts 默认配置）。
 */
export const EXPECTED_RETRIEVAL_FLAGS = {
  dualKbRoutingEnabled: false,
  hardInjectEnabled: true,
  usefulnessRerankEnabled: false,
} as const

export type RetrievalFlagKey = keyof typeof EXPECTED_RETRIEVAL_FLAGS

/** AG3：收敛声称模式（命中即声称精度收敛，须有豁免标记；同步点：门禁脚本内 CLAIM_PATTERN）。 */
export const CONVERGENCE_CLAIM_PATTERN = /收敛结论|已收敛|top3.{0,12}0\.7/

/** AG3：豁免标记（任一出现即视为已如实标注口径；同步点：门禁脚本内 EXEMPTION_PATTERN）。 */
export const CONVERGENCE_EXEMPTION_PATTERN =
  /同源回归口径|不可作收敛结论|非真实语料|只证非劣化|合成压力面|待裁决|未达裁决/

/**
 * AG4：检索主链核心函数名（定义必须只出现在 src/lib/novel/ 内；
 * 同步点：门禁脚本内 CORE_RETRIEVAL_FNS）。
 */
export const NOVEL_CORE_RETRIEVAL_FNS = [
  "rankByBm25",
  "routeByQueryIntent",
  "reorderByUsefulness",
  "retrieveDualTrack",
  "novelMixedSearch",
  "generateMultiQueries",
  "fuseAcrossQueries",
] as const

// ============================================================================
// 快照 schema（IO 层组装，本模块只消费）
// ============================================================================

/** 反目标判定输入快照（strict：未知字段视为契约违反）。 */
export const ANTIGOAL_SNAPSHOT_SCHEMA = z
  .object({
    /** kb-routing-view.generated.json 的 collectionCounts 面。 */
    collectionCounts: z.record(z.string(), z.number().int().nonnegative()),
    /** wiki-store 三检索 flag 默认值面。 */
    flags: z.object({
      dualKbRoutingEnabled: z.boolean(),
      hardInjectEnabled: z.boolean(),
      usefulnessRerankEnabled: z.boolean(),
    }),
    /** src/lib/novel/ 之外定义核心检索函数的文件清单（相对路径，空 = 通过）。 */
    externalRetrievalDefs: z.array(z.string().min(1)).max(256),
    /** docs/p0 下各 md 的声称/豁免扫描面（IO 层逐文件判定后传入）。 */
    convergenceClaims: z
      .array(
        z.object({
          file: z.string().min(1),
          hasClaim: z.boolean(),
          hasExemption: z.boolean(),
        }),
      )
      .max(256),
    /** R0-b 产物与同尺报告存在性面（AG6 硬依赖）。 */
    evidence: z.object({
      rerankTriggerEvidenceExists: z.boolean(),
      sameScaleReportExists: z.boolean(),
    }),
    /** rule-stack.ts 文本护栏模式存在性面（AG5）。 */
    ruleStackQualityGuardPresent: z.boolean(),
    ruleStackPriorityOrderPresent: z.boolean(),
  })
  .strict()

export type AntigoalSnapshot = z.infer<typeof ANTIGOAL_SNAPSHOT_SCHEMA>

/** 反目标 id。 */
export const ANTIGOAL_ID_SCHEMA = z.enum(["AG1", "AG2", "AG3", "AG4", "AG5", "AG6"])

export type AntigoalId = z.infer<typeof ANTIGOAL_ID_SCHEMA>

/** 违禁项。 */
export interface AntigoalViolation {
  id: AntigoalId
  detail: string
}

// ============================================================================
// 判定核（纯函数）
// ============================================================================

/**
 * 扫描单文件文本：是否含收敛声称 / 是否含豁免标记（纯函数，零 IO）。
 * IO 层对 docs/p0 下每个 md 调用本函数，结果填入快照 convergenceClaims。
 */
export function scanConvergenceClaimText(text: string): { hasClaim: boolean; hasExemption: boolean } {
  return {
    hasClaim: CONVERGENCE_CLAIM_PATTERN.test(text),
    hasExemption: CONVERGENCE_EXEMPTION_PATTERN.test(text),
  }
}

/**
 * 六条反目标判定（纯函数）：返回违禁清单，空数组 = 全部通过。
 * 判定顺序固定 AG1→AG6，调用方可用 id 定位违禁条目。
 */
export function checkAntigoals(snapshot: AntigoalSnapshot): AntigoalViolation[] {
  const violations: AntigoalViolation[] = []
  const corpus = snapshot.collectionCounts["corpus"] ?? 0

  // AG1 禁全量导入 W。
  if (corpus > AG1_MAX_CORPUS_ENTRIES) {
    violations.push({
      id: "AG1",
      detail:
        `corpus 条目 ${corpus} 超上限 ${AG1_MAX_CORPUS_ENTRIES}` +
        `（现役基线 ${CORPUS_BASELINE_COUNT}，W 全量约 2435）：禁全量导入 W，须拆分批 + 走 curation-gate 准入`,
    })
  }

  // AG2 禁提前开重机制。
  const flagDiffs = (Object.keys(EXPECTED_RETRIEVAL_FLAGS) as RetrievalFlagKey[])
    .filter((key) => snapshot.flags[key] !== EXPECTED_RETRIEVAL_FLAGS[key])
    .map((key) => `${key}=${String(snapshot.flags[key])}（期望 ${String(EXPECTED_RETRIEVAL_FLAGS[key])}）`)
  if (flagDiffs.length > 0) {
    violations.push({
      id: "AG2",
      detail: `检索 flag 默认值漂移：${flagDiffs.join("；")}。禁提前开重机制，翻转走 kb-flag-promotion-flow 双臂证据门`,
    })
  }

  // AG3 禁同源自证。
  const unexempted = snapshot.convergenceClaims
    .filter((claim) => claim.hasClaim && !claim.hasExemption)
    .map((claim) => claim.file)
  if (unexempted.length > 0) {
    violations.push({
      id: "AG3",
      detail:
        `同源自证声称无豁免标记：${unexempted.join("、")}` +
        `。禁把 top3≥0.7 当收敛结论，须注"同源回归口径，不可作收敛结论"或补非同源裁决`,
    })
  }

  // AG4 禁 novel 外平行复制检索主链。
  if (snapshot.externalRetrievalDefs.length > 0) {
    violations.push({
      id: "AG4",
      detail: `novel 外定义检索主链函数：${snapshot.externalRetrievalDefs.join("、")}。新增能力必须落 src/lib/novel/ 既有锚点`,
    })
  }

  // AG5 禁 P2 越门。
  if (!snapshot.ruleStackQualityGuardPresent || !snapshot.ruleStackPriorityOrderPresent) {
    const missing = [
      ...(snapshot.ruleStackQualityGuardPresent ? [] : ['Quality 永不短路护栏（`gate !== "quality"`）']),
      ...(snapshot.ruleStackPriorityOrderPresent ? [] : ["GATE_PRIORITY_ORDER 优先级顺序引用"]),
    ]
    violations.push({
      id: "AG5",
      detail: `rule-stack 门序护栏缺失：${missing.join("；")}。禁 Quality(P2) 类增强越过 Consistency(P0)/Anti-AI(P1) 门`,
    })
  }

  // AG6 禁扩容跑在证据面之前（只看 corpus 集合；R1 的 world_ref/lexicon 填空不属语料扩容）。
  if (corpus > CORPUS_BASELINE_COUNT) {
    const missingEvidence = [
      ...(snapshot.evidence.rerankTriggerEvidenceExists
        ? []
        : ["R0-b 触发证据产物（docs/p0/rerank-trigger-evidence-*.md）"]),
      ...(snapshot.evidence.sameScaleReportExists ? [] : ["同尺报告（docs/p0/same-scale-*.md）"]),
    ]
    if (missingEvidence.length > 0) {
      violations.push({
        id: "AG6",
        detail:
          `corpus 已扩容至 ${corpus}（基线 ${CORPUS_BASELINE_COUNT}）但证据面缺失：` +
          `${missingEvidence.join("；")}。禁扩容跑在证据面之前`,
      })
    }
  }

  return violations
}
