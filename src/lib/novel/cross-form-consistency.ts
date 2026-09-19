/**
 * cross-form-consistency.ts — 波3-A：短剧/漫画跨形态一致性（单向派生子门
 * + VIS-CONT aura 判据接口 + L9 显式 N/A）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波3 + 模块 5/6 深化）：
 *   - GLM P1 缺口「跨形态一致性子门（单向派生）」：验收——短剧子门仅由小说
 *     母本单向派生评估且派生关系账本可追溯；
 *   - GLM P1「VIS-CONT」：漫画跨帧 aura 相似度阈值门可执行且结果落事件账本；
 *   - DS P2「多形态派生链」：小说母本 → 漫画/短剧**单向**派生（子门永不反向
 *     改写母本），派生评估结果落账本可追溯。
 *
 * 机械口径：
 *   - 单向派生：子门评估只读母本门状态（novelGateStatus）——母本未 pass →
 *     子门 verdict=blocked（不独立评估、永不反向改写母本）；母本 pass →
 *     子门按派生校验项（consistent 布尔）裁定 pass/fail；
 *   - VIS-CONT（漫画跨帧 aura 判据，机械）：相邻帧 auraSeeds 字符 2-gram
 *     shingle Jaccard ≥ 阈值（缺省 0.5）→ 一致；低于阈值 → 跨帧一致性 finding；
 *   - 子门事件 kind=stage（payload.subGate 显式标记）——**不用 gate-run**：
 *     三门账本覆盖口径（checkGateEventCoverage）专属三门注册表，子门事件
 *     不得污染 R-04 覆盖率语义；
 *   - L9 显式 N/A：漫画/短剧形态六维章级评审**显式 N/A**（na=true + reason），
 *     而非缺省漏报——L9 仅适用于小说母本。
 *
 * 机械层（ADR-19）：纯函数，零 IO / 零时钟（ts 注入）/ 零模型调用。
 *
 * @license MIT © Niko Buddy
 */

import { z } from "zod"
import { jaccardSimilarity, unionShinglesFromTexts } from "./aura-homogenization"
import type { RunEventAppendInput } from "./run-event-ledger-store"

// ============================================================================
// 契约
// ============================================================================

/** 跨形态种类（小说母本之外的派生形态）。 */
export const CROSS_FORM_KINDS = ["comic", "short_drama"] as const
export type CrossFormKind = (typeof CROSS_FORM_KINDS)[number]

/** 派生关系记录（账本可追溯的最小集，strict）。 */
export const CROSS_FORM_DERIVATION_SCHEMA = z
  .object({
    derivationId: z.string().min(1).max(128),
    form: z.enum(CROSS_FORM_KINDS),
    /** 母本锚（小说章 id）。 */
    sourceChapterId: z.number().int().min(0),
    /** 派生产物引用（漫画分镜稿 / 短剧剧本等工件引用）。 */
    derivedArtifactId: z.string().min(1).max(128),
  })
  .strict()

export type CrossFormDerivation = z.infer<typeof CROSS_FORM_DERIVATION_SCHEMA>

/** 派生校验项（子门输入：与母本锚的一致性布尔判定）。 */
export interface CrossFormCheck {
  readonly checkId: string
  readonly consistent: boolean
}

/** 子门裁定（单向派生）。 */
export interface CrossFormSubGateVerdict {
  readonly form: CrossFormKind
  readonly derivationId: string
  readonly verdict: "pass" | "fail" | "blocked"
  /** blocked 时的阻塞来源（母本门未过）。 */
  readonly blockedBy: "novel-baseline" | null
  /** 未通过的校验项 id（fail 时非空）。 */
  readonly failedChecks: readonly string[]
}

/** VIS-CONT 跨帧判据发现。 */
export interface VisContFinding {
  readonly frameA: string
  readonly frameB: string
  readonly similarity: number
  readonly threshold: number
}

/** VIS-CONT 判据结果。 */
export interface VisContVerdict {
  readonly verdict: "pass" | "fail"
  /** 相邻帧对比较数（0 或 1 帧 → 无可比对 → pass 平凡）。 */
  readonly pairsChecked: number
  readonly findings: readonly VisContFinding[]
}

/** 形态级 L9 状态（漫画/短剧显式 N/A）。 */
export interface FormL9Status {
  readonly form: CrossFormKind | "novel"
  readonly applicable: boolean
  /** 显式 N/A 标记（非缺省漏报）。 */
  readonly na: boolean
  readonly reason: string
}

/** 跨形态错误。 */
export class CrossFormConsistencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CrossFormConsistencyError"
  }
}

// ============================================================================
// 单向派生子门
// ============================================================================

/**
 * 单向派生子门裁定（纯函数）：
 *   - 母本门状态非 pass → 子门 blocked（子门仅由母本单向派生，不独立评估）；
 *   - 母本 pass → 全部校验项 consistent → pass；任一 false → fail（含 id）。
 */
export function evaluateCrossFormSubGate(input: {
  readonly derivation: CrossFormDerivation
  readonly novelGateStatus: "pass" | "fail" | "skipped"
  readonly checks: readonly CrossFormCheck[]
}): CrossFormSubGateVerdict {
  if (input.novelGateStatus !== "pass") {
    return { form: input.derivation.form, derivationId: input.derivation.derivationId, verdict: "blocked", blockedBy: "novel-baseline", failedChecks: [] }
  }
  const failedChecks = input.checks.filter((check) => !check.consistent).map((check) => check.checkId)
  return {
    form: input.derivation.form,
    derivationId: input.derivation.derivationId,
    verdict: failedChecks.length === 0 ? "pass" : "fail",
    blockedBy: null,
    failedChecks,
  }
}

// ============================================================================
// VIS-CONT（漫画跨帧 aura 判据，机械）
// ============================================================================

/** 漫画帧 aura 样本。 */
export interface ComicFrameAura {
  readonly frameId: string
  readonly auraSeeds: readonly string[]
}

/**
 * VIS-CONT 跨帧 aura 判据（机械）：相邻帧 auraSeeds 的 shingle Jaccard ≥
 * threshold（缺省 0.5）→ 一致；低于阈值 → finding。帧数 <2 → 平凡 pass
 * （无可比帧对，pairsChecked=0，不臆造不一致）。
 */
export function evaluateVisCont(frames: readonly ComicFrameAura[], threshold = 0.5): VisContVerdict {
  if (threshold < 0 || threshold > 1) throw new CrossFormConsistencyError(`threshold 越界 [0,1]: ${threshold}`)
  const findings: VisContFinding[] = []
  let pairsChecked = 0
  for (let i = 0; i + 1 < frames.length; i += 1) {
    const a = frames[i] as ComicFrameAura
    const b = frames[(i + 1) as number] as ComicFrameAura
    if (a.auraSeeds.length === 0 || b.auraSeeds.length === 0) continue
    const similarity = jaccardSimilarity(unionShinglesFromTexts(a.auraSeeds), unionShinglesFromTexts(b.auraSeeds))
    if (similarity === null) continue
    pairsChecked += 1
    if (similarity < threshold) {
      findings.push({ frameA: a.frameId, frameB: b.frameId, similarity, threshold })
    }
  }
  return { verdict: findings.length === 0 ? "pass" : "fail", pairsChecked, findings }
}

// ============================================================================
// L9 显式 N/A
// ============================================================================

/**
 * 形态级 L9 状态：L9（六维章级中位 ≥9.0 硬门）仅适用于小说母本；
 * 漫画/短剧 → 显式 N/A（na=true + reason），禁止缺省漏报。
 */
export function formL9Status(form: CrossFormKind | "novel"): FormL9Status {
  if (form === "novel") {
    return { form, applicable: true, na: false, reason: "小说母本适用 L9 六维章级硬门" }
  }
  return {
    form,
    applicable: false,
    na: true,
    reason: form === "comic" ? "漫画形态无六维章级评审基线：L9 显式 N/A" : "短剧形态无六维章级评审基线：L9 显式 N/A",
  }
}

// ============================================================================
// 账本事件（子门可追溯面）
// ============================================================================

/**
 * 子门评估事件输入（kind=stage + payload.subGate 显式标记；**不用 gate-run**，
 * 避免污染三门覆盖口径）。evidenceRefs：母本锚 + 派生产物可点开。
 */
export function crossFormSubGateEvents(input: {
  readonly verdict: CrossFormSubGateVerdict
  readonly derivation: CrossFormDerivation
  readonly ts: string
}): RunEventAppendInput[] {
  if (input.ts.length === 0) throw new CrossFormConsistencyError("ts 为空：事件落账前必须注入时间戳（零时钟纪律）")
  return [
    {
      ts: input.ts,
      kind: "stage" as const,
      actor: "system" as const,
      chapterId: input.derivation.sourceChapterId,
      evidenceRefs: [
        `novel-ch:${input.derivation.sourceChapterId}`,
        `derived:${input.derivation.derivedArtifactId}`,
      ],
      payload: {
        subGate: "cross-form-derivation",
        form: input.verdict.form,
        derivationId: input.verdict.derivationId,
        verdict: input.verdict.verdict,
        blockedBy: input.verdict.blockedBy,
        failedChecks: input.verdict.failedChecks,
      },
    },
  ]
}

/** VIS-CONT 结果事件输入（kind=stage + payload.subGate=vis-cont）。 */
export function visContEvents(input: { readonly verdict: VisContVerdict; readonly ts: string; readonly bookId?: string }): RunEventAppendInput[] {
  if (input.ts.length === 0) throw new CrossFormConsistencyError("ts 为空：事件落账前必须注入时间戳（零时钟纪律）")
  return [
    {
      ts: input.ts,
      kind: "stage" as const,
      actor: "system" as const,
      bookId: input.bookId,
      evidenceRefs: input.verdict.findings.map((f) => `vis-cont:${f.frameA}:${f.frameB}`),
      payload: {
        subGate: "vis-cont",
        verdict: input.verdict.verdict,
        pairsChecked: input.verdict.pairsChecked,
        findings: input.verdict.findings,
      },
    },
  ]
}