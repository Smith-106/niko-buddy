/**
 * eval-second-signal.ts — L3 第二信号源（零 LLM 机械层）。
 *
 * 目标（eval-real-baseline-path.md §2.2 步骤 2 / §6 残余风险）：
 *  主 L3 通道 = checkContinuity → isL3CriticalFinding（critical +
 *  consistency_mechanical）过滤。盲区：生成段「吃了 superseded/former 设定」
 *  类 canon 违反不在 continuity critical 集。本模块提供独立 warning 通道：
 *  从快照/ContextPack 的义务类字段（former/superseded/invalidated）抽取义务
 *  三元组候选，与生成段正文做 subject+object 存在性比对，输出 mismatch
 *  warning 列表。该通道不进 L3 critical、不阻塞主 L3（C7：无义务字段或生成
 *  正文缺失 → 显式 SKIP，绝不伪造数据）。
 *
 * 零 LLM 机械比对语义（与 L1 layerContainsTriple 同源的存在性断言，非 rank）：
 *  - 义务三元组 former=true（TemporalFact.former / validUntil 已闭；
 *    CanonFact.invalidAt / archived）→「已失效设定，不得当作当前真值引用」。
 *  - 生成段抽取 = 反向存在性：义务三元组的 subject 与 object 是否同时出现在
 *    生成正文。谓词不参与机械匹配（散文谓词词形不可靠），故以 subject+object
 *    为机械存在性界，warning 为提示级（非阻塞），允许存在性误报。
 */
import { z } from "zod"
import type { ContextPack } from "../context-engine"
import type { TemporalFact } from "../temporal-memory"
import type { CanonFact } from "../canon-graph-client"
import { resolveCanonicalName } from "../character-cognition"

/** 义务三元组候选（从快照/ContextPack 义务类字段抽取）。 */
export interface ObligationTriple {
  subject: string
  predicate: string
  object: string
  /** former=true：已失效设定（superseded/negated/invalidated），生成段不得当作当前真值引用。 */
  former: boolean
  /** 溯源（provenance），如 "formerFacts" / "temporalFacts" / "canon-graph"。 */
  source: string
}

/** 第二信号 warning kind 契约（独立通道，不与主 L3 ContinuityFinding 混同）。 */
export const secondSignalWarningKindSchema = z.literal("superseded_fact_referenced")
export type SecondSignalWarningKind = z.infer<typeof secondSignalWarningKindSchema>

/** 单条 mismatch warning（生成段引用了已失效设定）。 */
export const secondSignalWarningSchema = z.object({
  kind: secondSignalWarningKindSchema,
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  source: z.string(),
  message: z.string(),
})
export type SecondSignalWarning = z.infer<typeof secondSignalWarningSchema>

/** 第二信号报告：status=skip 时显式标注原因（C7），warnings 为空。 */
export const secondSignalReportSchema = z.object({
  status: z.enum(["run", "skip"]),
  skipReason: z.string().optional(),
  obligationCount: z.number().int().nonnegative(),
  formerCount: z.number().int().nonnegative(),
  warnings: z.array(secondSignalWarningSchema),
})
export type SecondSignalReport = z.infer<typeof secondSignalReportSchema>

/** TemporalFact[] → 义务三元组（former = former flag 或 validUntil 已闭）。 */
export function extractObligationsFromTemporalFacts(
  facts: readonly TemporalFact[] | null | undefined,
): ObligationTriple[] {
  if (!facts || facts.length === 0) return []
  const out: ObligationTriple[] = []
  for (const f of facts) {
    out.push({
      subject: resolveCanonicalName(f.subject),
      predicate: f.predicate,
      object: f.object,
      former: f.former === true || f.validUntil !== undefined,
      source: f.former === true ? "formerFacts" : "temporalFacts",
    })
  }
  return out
}

/** CanonFact[] → 义务三元组（former = archived 或 invalidAt 已闭）。 */
export function extractObligationsFromCanonFacts(
  facts: readonly CanonFact[] | null | undefined,
): ObligationTriple[] {
  if (!facts || facts.length === 0) return []
  const out: ObligationTriple[] = []
  for (const f of facts) {
    out.push({
      subject: resolveCanonicalName(f.sourceId),
      predicate: f.predicate,
      object: resolveCanonicalName(f.targetId),
      former: f.archived === true || (f.invalidAt !== null && f.invalidAt !== undefined),
      source: "canon-graph",
    })
  }
  return out
}

/** ContextPack → 义务三元组（formerFacts + temporalFacts 并集，按三元组键去重）。 */
export function extractObligationsFromContextPack(pack: ContextPack): ObligationTriple[] {
  const seen = new Set<string>()
  const out: ObligationTriple[] = []
  const push = (facts: readonly TemporalFact[] | null | undefined): void => {
    for (const ob of extractObligationsFromTemporalFacts(facts)) {
      const key = [ob.subject, ob.predicate, ob.object].join("\u0000")
      if (seen.has(key)) continue
      seen.add(key)
      out.push(ob)
    }
  }
  push(pack.formerFacts)
  push(pack.temporalFacts)
  return out
}

/** former 义务 vs 生成段正文存在性比对 → mismatch warning 列表。 */
export function compareObligationsToGenerated(
  obligations: readonly ObligationTriple[],
  generatedText: string,
): SecondSignalWarning[] {
  const warnings: SecondSignalWarning[] = []
  for (const ob of obligations) {
    if (!ob.former) continue
    if (!ob.subject || !ob.object) continue
    if (generatedText.includes(ob.subject) && generatedText.includes(ob.object)) {
      warnings.push({
        kind: "superseded_fact_referenced",
        subject: ob.subject,
        predicate: ob.predicate,
        object: ob.object,
        source: ob.source,
        message: `生成段引用了已失效设定「${ob.subject} ${ob.predicate} ${ob.object}」（superseded/former）`,
      })
    }
  }
  return warnings
}

/** 第二信号主入口：义务候选 + 生成正文 → report（无输入时显式 SKIP，C7）。 */
export function runSecondSignal(
  obligations: readonly ObligationTriple[] | null | undefined,
  generatedText: string | null | undefined,
): SecondSignalReport {
  const list = obligations ?? []
  if (generatedText === null || generatedText === undefined || generatedText.trim() === "") {
    return {
      status: "skip",
      skipReason: "生成段正文缺失（第二信号源需生成正文输入，C7 显式 SKIP）",
      obligationCount: list.length,
      formerCount: list.filter((o) => o.former).length,
      warnings: [],
    }
  }
  if (list.length === 0) {
    return {
      status: "skip",
      skipReason: "无义务三元组候选（快照/ContextPack 无 former/superseded 字段，C7 显式 SKIP）",
      obligationCount: 0,
      formerCount: 0,
      warnings: [],
    }
  }
  return {
    status: "run",
    obligationCount: list.length,
    formerCount: list.filter((o) => o.former).length,
    warnings: compareObligationsToGenerated(list, generatedText),
  }
}
