// M10-2 切片：review-adapter prompt 纯组装块（单轮收敛）。
// 内容：门控键解析（CORR108 legacy 常量 + resolveReviewGateKey）/ 审查维度与阶段常量 /
// 章节分段（splitChapterForReview，ISS-20260711-001 截断语义）/ canon 模态上下文 /
// buildReviewPrompt / 题材激活段（buildGenreActivationSection）。
// 纯函数零 IO 零 LLM；依赖均为 review-adapter 原有依赖，未引入新依赖。
// review-adapter.ts 经同目录 import + re-export 保对外 import 面（符号名与签名不变）。

import i18n from "@/i18n"
import { contextPackToPrompt, type ContextPack } from "./context-engine"
import type { TemporalFact } from "./temporal-memory"
import { sliceChapterForReview } from "./chapter-window"
// T24 (TASK-P3-24): 审查 type → 门控键映射改读 T22 GATE_MAPPING（唯一真源）。
// getGateForDimension / ALL_AUDIT_DIMENSION_IDS 均为 audit-taxonomy 纯常量/纯函数
// 导出，零 IO 零 LLM，不破坏本模块依赖纪律。
import {
  ALL_AUDIT_DIMENSION_IDS,
  AUDIT_TAXONOMY,
  getGateForDimension,
  selectAuditDimensions,
  type AuditDimensionId,
  type GateKey,
} from "./audit-taxonomy"

// ==========================================================================
// T24 (TASK-P3-24): 审查 type → 门控键解析（改读 T22 GATE_MAPPING，唯一真源）
// ==========================================================================

/**
 * CORR-108 历史对照常量（原 deep-chapter-generation.ts CONSISTENCY_REVIEW_TYPES /
 * ANTI_AI_REVIEW_TYPES 硬编码集，CORR-108 overall 裁定修复所依赖的 type→gate
 * 归类口径）。T24 后 37 维 id 归类走 GATE_MAPPING（上方 resolveReviewGateKey），
 * 本两常量仅作 legacy alias 对照保留防丢失历史口径（任务要求：CORR-108 映射
 * 保留为代码常量）；deep-chapter-generation.resolveDecisionGateKey 运行时消费方
 * 迁移由其后续任务承接（不在 T24 文件范围）。
 */
export const CORR108_LEGACY_CONSISTENCY_REVIEW_TYPES: readonly string[] = [
  "consistency",
  "character_consistency",
  "timeline",
  "foreshadowing",
  "setting",
  "consistency_mechanical",
  // §GAP-88-01 (ainovel chapter_contract 写后核对): 契约 finding type 归
  // consistency 门 — 与 audit-taxonomy GATE_MAPPING.quality 的 quality 门三维
  // (thrill_density/pacing_tension/reading_power) 无隶属冲突。
  "contract",
]

/** CORR-108 历史对照常量（anti-AI legacy alias 集，见上注）。 */
export const CORR108_LEGACY_ANTI_AI_REVIEW_TYPES: readonly string[] = [
  "anti_ai",
  "style",
  "de_ai",
  "slop",
]

const AUDIT_DIMENSION_ID_SET: ReadonlySet<string> = new Set<string>(ALL_AUDIT_DIMENSION_IDS)

/**
 * 解析审查 finding type → 三门控键（consistency / anti_ai / quality）。
 *
 * 解析序（与 CORR-108 时代 resolveDecisionGateKey 优先级一致）：
 *   1. type ∈ T22 37 维注册表 → 经 GATE_MAPPING/AUDIT_TAXONOMY 取归属门
 *      （getGateForDimension，唯一真源路径）；
 *   2. type ∈ CORR108_LEGACY_CONSISTENCY_REVIEW_TYPES → "consistency"；
 *   3. type ∈ CORR108_LEGACY_ANTI_AI_REVIEW_TYPES → "anti_ai"；
 *   4. 其余（含未知 type）→ "quality"（保守缺省，P2 永不覆盖 P0/P1）。
 *
 * 纯函数零副作用；normalize 口径（trim + lowercase）与 resolveDecisionGateKey 一致。
 */
export function resolveReviewGateKey(type: string): GateKey {
  const normalized = type.trim().toLowerCase()
  if (AUDIT_DIMENSION_ID_SET.has(normalized)) {
    return getGateForDimension(normalized as AuditDimensionId)
  }
  if (CORR108_LEGACY_CONSISTENCY_REVIEW_TYPES.includes(normalized)) return "consistency"
  if (CORR108_LEGACY_ANTI_AI_REVIEW_TYPES.includes(normalized)) return "anti_ai"
  return "quality"
}

/** 角色一致性相关的审查维度，用于 characterOnly 轻量审查模式 */
const CHARACTER_REVIEW_DIMENSIONS = [
  "是否人设崩坏",
  "是否人物动机不一致",
  "是否角色脱离记忆库设定",
  "是否提前泄露秘密",
  "是否角色知道了不该知道的信息",
]

const REVIEW_DIMENSIONS = [
  "是否违背总大纲",
  "是否违背分卷大纲",
  "是否违背章节目标",
  "本章必须完成项是否已完成",
  "本章避免违背项是否存在违背",
  "下一章推进建议是否被忽略或反向推进",
  "是否人设崩坏",
  "是否人物动机不一致",
  "是否角色脱离记忆库设定",
  "是否时间线错误",
  "是否地点错误",
  "是否能力体系崩坏",
  "是否伏笔遗忘",
  "是否提前泄露秘密",
  "是否角色知道了不该知道的信息",
  "是否新增未登记设定",
  "是否剧情水文",
  "是否缺少章节钩子",
]

const REVIEW_STAGES = [
  "阶段1：审查任务识别",
  "阶段2：上下文检索",
  "阶段3：章节目标对齐",
  "阶段4：事实与记忆核对",
  "阶段5：逐维度审查",
  "阶段6：阻断判定",
  "阶段7：二次复核",
]

const REVIEW_CHUNK_SIZE = 8000
const REVIEW_MAX_CHUNKS = 3

/**
 * 把超长章节分段用于审查。章节 ≤ 8000 字时返回单段；
 * 超过时按 8000 字一段切分，最多 3 段（覆盖 24000 字）。
 *
 * ISS-20260711-001: 超出 24000 字的部分**截断**而非追加到最后一段。
 * 之前 `chunks[REVIEW_MAX_CHUNKS - 1] += content.slice(totalCovered)` 会让第 3 段
 * 膨胀到任意长度（超长 UAT 稿可达 25 万字 → 第 3 段 24 万字），LLM 在如此
 * 长的输入上要么 token 上限截断要么直接放弃 JSON 输出，导致 review chunk parse
 * 失败 → fix-loop 死循环 → watchdog paused。审查只需覆盖足够正文即可，丢掉
 * 远超 24000 字的尾部比让 LLM 输出崩成非 JSON 更安全。
 */
// M10-2 过渡公开导出：原 review-adapter 私有 helper，reviewChapter 仍经此分段。
export function splitChapterForReview(content: string): string[] {
  if (content.length <= REVIEW_CHUNK_SIZE) return [content]
  const chunks: string[] = []
  for (let i = 0; i < content.length && chunks.length < REVIEW_MAX_CHUNKS; i += REVIEW_CHUNK_SIZE) {
    chunks.push(content.slice(i, i + REVIEW_CHUNK_SIZE))
  }
  return chunks
}

/**
 * 落点③：把 canon 图投影的时序事实（携带 modality）组装为审查上下文片段，
 * 仅渲染 belief/hypothesis（角色认知，非事实陈述）与 retconned（回溯改写）这两类
 * 「非 Assertive」模态事实。assertive（叙述者断言）与无 modality 旧数据已由
 * context-engine 独立分块呈现，此处不重复注入，避免写放大与模态段重复。
 *
 * 纯函数零 IO 零 LLM：输入来自 ContextPack.temporalFacts / formerFacts（已由
 * context-engine 经 fromCanonGraph 折叠，modality 随 canon 边流入）。供
 * buildReviewPrompt 注入，使审稿模型区分「角色认为的事实」与「客观事实」，避免把
 * 角色误信（belief）当作客观矛盾去判 setting_conflict。
 *
 * 仅当存在 belief/hypothesis/retconned 事实时返回非空串；全 assertive（含无模态）
 * 或空输入均返回 ""（不污染 prompt，字节级等价未注入时的原行为）。
 */
export function buildCanonModalityContext(facts: readonly TemporalFact[]): string {
  const lines: string[] = []
  for (const f of facts) {
    const tail = f.object ? f.predicate + " " + f.object : ""
    const stmt = tail ? f.subject + " " + tail : f.subject
    if (f.modality === "belief" || f.modality === "hypothesis") {
      lines.push("- [角色认知·" + f.modality + "] " + stmt + "（角色所信，非客观事实，审稿勿视为矛盾）")
    } else if (f.modality === "retconned") {
      lines.push("- [回溯改写] " + stmt)
    }
    // assertive / 无模态事实已由 context-engine 独立分块呈现，此处不重复注入
  }
  if (lines.length === 0) return ""
  return "# canon 图事实（模态区分）\n" + lines.join("\n")
}

export function buildReviewPrompt(
  pack: ContextPack,
  chapterContent: string,
  characterOnly = false,
  genre?: string,
  /** P2-IMP-07: hardInject 渲染门穿参（缺省 undefined → flag 默认 false，零行为变化）。 */
  hardInjectEnabled?: boolean,
): string {
  const dimensions = characterOnly ? CHARACTER_REVIEW_DIMENSIONS : REVIEW_DIMENSIONS
  const modeTitle = characterOnly ? "角色一致性专项审查" : "阶段式深度审查工作流"
  const modeStages = characterOnly
    ? ["阶段1：角色提取", "阶段2：记忆库对照", "阶段3：脱离判定", "阶段4：二次复核"]
    : REVIEW_STAGES
  // 落点③：把 canon 图投影时序事实（携带 modality）组装为审查上下文，仅注入
  // belief/hypothesis/retconned 非 Assertive 模态；formerFacts 仅由 context-engine
  // 独立分块呈现（P0 护栏），不在此 spread。全 Assertive 或空 → 空串不注入。
  const canonModalityContext = buildCanonModalityContext(pack.temporalFacts ?? [])
  return `${contextPackToPrompt(pack, undefined, { hardInjectEnabled })}

${canonModalityContext ? canonModalityContext + "\n\n" : ""}${modeTitle}：
${modeStages.map((stage) => `- ${stage}：必须使用高级 thinking，先分析证据，再给结论。`).join("\n")}

${characterOnly ? "角色一致性专项审查要求：" : "阶段要求："}
${characterOnly
  ? [
      "1. 角色提取：从本章正文中提取所有出现的角色名（含别名、昵称），列出角色清单。",
      "2. 记忆库对照：逐个角色对照上下文中的角色光环/灵魂、人物状态、角色认知状态字段，标注命中状态。",
      "3. 脱离判定：角色行为若违背光环设定、人物状态、认知状态、大纲人物小传，视为脱离记忆库，按严重程度标为 error 或 warning。",
      "4. 二次复核：删除没有正文证据或没有记忆/大纲依据的主观评价，补上遗漏的阻断问题。",
    ].join("\n")
  : [
      "1. 审查任务识别：确认目标章节、章纲节点、正文范围、是否缺少必要上下文。",
      "2. 上下文检索：结合大纲、节点、上一章结尾、下一章建议、记忆库、人物信息、伏笔、时间线、角色认知状态。",
      "3. 章节目标对齐：判断正文是否完成本章必须推进项，是否偏离章纲或反向推进。",
      "4. 事实与记忆核对：逐项对照已登记设定、人物认知、伏笔状态、历史事件和相关检索结果。",
      "5. 逐维度审查：每个维度都必须有 pass 或 issue，不要只检查明显错误。",
      "6. 阻断判定：把会影响正式章节保存、后续生成、主线事实或人物一致性的问题标为 error。",
      "7. 二次复核：删除没有正文证据或没有记忆/大纲依据的主观评价，补上遗漏的阻断问题。",
    ].join("\n")}

${i18n.t("novel.reviewPrompt.reviewChapterInstruction")}
${dimensions.map((key, i) => `${i + 1}. ${i18n.t(key)}`).join("\n")}

${characterOnly ? "" : `${i18n.t("novel.reviewPrompt.specialChecksTitle")}
- ${i18n.t("novel.reviewPrompt.specialChecks.mustDo")}
- ${i18n.t("novel.reviewPrompt.specialChecks.mustAvoid")}
- ${i18n.t("novel.reviewPrompt.specialChecks.nextChapterAdvice")}

`}

角色命中记忆库检查（必须执行）：
1. 角色提取：先从本章正文中提取所有出现的角色名（含别名、昵称），列出角色清单。
2. 记忆库对照：逐个角色对照上下文中的"角色光环/灵魂"、"人物状态"、"角色认知状态"字段：
   - 标注该角色是否命中记忆库（已注入光环 / 仅有状态 / 完全缺失）。
   - 若角色已命中记忆库，检查正文行为是否符合光环设定（说话方式、心智模型、决策启发式、价值观反模式、诚实边界）。
   - 若角色未命中记忆库但在大纲/人物小传中存在，标注"未命中但应命中"。
3. 脱离判定：角色行为若违背光环设定、人物状态、认知状态（知道/不知道什么）、大纲人物小传，视为"脱离记忆库"，按严重程度标为 error 或 warning。
4. 输出要求：在审查 JSON 中，角色相关问题 type 使用 "character_consistency"，relatedMemory 必须引用对应的光环/状态/认知/大纲原文。

${i18n.t("novel.reviewPrompt.chapterContent")}
${sliceChapterForReview(chapterContent)}

${i18n.t("novel.reviewPrompt.outputFormat")}
[
  {
    "severity": "error|warning|info",
    "type": "character_consistency|timeline|foreshadowing|setting|plot|style",
    "message": "问题描述",
    "evidence": "正文片段",
    "relatedMemory": "相关记忆引用",
    "suggestion": "修改建议"
  }
]

${i18n.t("novel.reviewPrompt.emptyArrayFallback")}${buildGenreActivationSection(genre, characterOnly)}`
}

/**
 * 53 号报告 P0-3 接线① additive: 按题材激活维度子集注入审查 prompt
 * (inkos selectAuditDimensions 模式, AGPL 只借模式)。Consistency(15)+
 * Anti-AI(10) 恒全激活 (守门控优先级), Quality 按题材子集裁剪。
 * genre 未传或 characterOnly → 空串 (零行为变更, 全量 37 维现状)。
 */
function buildGenreActivationSection(genre: string | undefined, characterOnly: boolean): string {
  if (!genre || characterOnly) return ""
  const active = selectAuditDimensions(genre)
  if (!active || active.length >= ALL_AUDIT_DIMENSION_IDS.length) {
    // 未注册题材 → 全量激活, 无需注入 (现状)
    return ""
  }
  const labels = active.map((id) => AUDIT_TAXONOMY[id]?.label ?? id).join("、")
  return `\n\n## 本轮审查维度激活集（按题材《${genre}》裁剪）\n仅以下维度参与阻断与修复路由（未列出的 Quality 维度本轮跳过）: ${labels}`
}

