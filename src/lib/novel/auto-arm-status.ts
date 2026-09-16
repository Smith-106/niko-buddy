/**
 * auto-arm-status.ts — 波2-A：draft-autoarm → status.json 唯一真源契约接线。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波2 + 模块 10）：
 *   - DS P0 缺口「autoarm→status.json 契约接线」：evaluateDraftAutoArm 仍是
 *     纯函数裁定，未落 status.json——本模块把裁定固化为 additive 字段
 *     `draft_auto_arm`（DraftAutoArmStatus，zod strict）+ 草稿态补丁纯函数；
 *   - 验收语义：机械门 P0+P1 全 pass → status.json 草稿态置 ready，且**任何
 *     自动化路径均无法写入 accepted**（补丁类型层只有 "ready"；运行时
 *     assertAutoArmPatchNeverAccepts 深扫兜底；armTo 仅 ready 复用
 *     director-modes 单字面量契约）；
 *   - autoarm 永不覆盖人工裁定：applyDraftAutoArmPatch 只把 pending 升
 *     ready；ready/accepted/rejected/superseded 现态原样保留（Draft-first
 *     红线：accept 永远是人的动作）。
 *
 * 机械层（ADR-19）：纯函数 + zod strict，零 IO / 零时钟（decidedAt 由调用方
 * 注入）/ 零模型调用。禁止 import novel-session-status（防循环：后者反向
 * import 本模块 schema 做加载护栏），补丁应用端用结构类型收口。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"
import { assertAutoArmNeverAccepts, type DraftAutoArmDecision } from "./director-modes"

// ============================================================================
// zod 契约（additive 字段 draft_auto_arm 的形状真源）
// ============================================================================

/** autoarm 落盘记录（status.json `draft_auto_arm` 字段；strict 校验）。 */
export const DRAFT_AUTO_ARM_SCHEMA = z
  .object({
    /** 裁定结果：机械门全 pass 才 true。 */
    armed: z.boolean(),
    /** armed 时恒 "ready"；未 arm 为 null（类型层无 accepted——accept 永远人工）。 */
    target: z.enum(["ready"]).nullable(),
    /** 机器可读裁定原因（透传 director-modes reason）。 */
    reason: z.string().min(1).max(256),
    /** 裁定时间（ISO-8601；调用方注入，零时钟）。 */
    decidedAt: z.string().min(1).max(64),
    /** 门显示三态快照（R-04：未评估永不显示为通过；UI 证据链渲染输入）。 */
    gateSnapshot: z
      .object({
        consistency: z.enum(["pass", "fail", "not_evaluated"]),
        anti_ai: z.enum(["pass", "fail", "not_evaluated"]),
        quality: z.enum(["pass", "fail", "not_evaluated"]),
      })
      .strict(),
  })
  .strict()

/** autoarm 落盘记录类型。 */
export type DraftAutoArmStatus = z.infer<typeof DRAFT_AUTO_ARM_SCHEMA>

/** 草稿态补丁（draft_status=null 表示不碰草稿态）。 */
export interface DraftAutoArmPatch {
  readonly draft_auto_arm: DraftAutoArmStatus
  /** armed → "ready"（升 ready 非 accept）；未 armed → null。 */
  readonly draft_status: "ready" | null
}

/** autoarm 契约错误（accept 语义混入 / armed-target 不一致等）。 */
export class AutoArmStatusError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AutoArmStatusError"
  }
}

// ============================================================================
// 裁定 → 落盘记录 → 补丁（纯函数链）
// ============================================================================

/**
 * 裁定固化为落盘记录：armed=true 时 target 必为 "ready"（director-modes
 * 单字面量）；先过 assertAutoArmNeverAccepts 运行时兜底，再过 zod strict。
 */
export function buildDraftAutoArmRecord(
  decision: DraftAutoArmDecision,
  decidedAt: string,
): DraftAutoArmStatus {
  assertAutoArmNeverAccepts(decision.target ?? "")
  if (decision.armed && decision.target !== "ready") {
    throw new AutoArmStatusError(
      `autoarm 裁定不一致：armed=true 但 target=${String(decision.target)}（只允许 "ready"）`,
    )
  }
  return DRAFT_AUTO_ARM_SCHEMA.parse({
    armed: decision.armed,
    target: decision.armed ? decision.target : null,
    reason: decision.reason,
    decidedAt,
    gateSnapshot: decision.gateSnapshot,
  })
}

/**
 * 落盘记录 → 草稿态补丁（入参先过 zod strict 防手搓脏对象）。
 * armed → draft_status "ready"；未 armed → null（不碰草稿态）。
 */
export function buildDraftAutoArmPatch(record: DraftAutoArmStatus): DraftAutoArmPatch {
  const parsed = DRAFT_AUTO_ARM_SCHEMA.parse(record)
  return { draft_auto_arm: parsed, draft_status: parsed.armed ? "ready" : null }
}

/**
 * 深扫补丁对象：任何字符串值等于 "accepted" 或以 "accept" 开头即抛错。
 * 供编排层在序列化写回 status.json 前复核——自动化路径零 accept 语义。
 */
export function assertAutoArmPatchNeverAccepts(patch: unknown): void {
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      if (node === "accepted" || node.startsWith("accept")) {
        throw new AutoArmStatusError(
          `autoarm 补丁语义违反：${path} 出现 accept 语义 "${node}"——accept 永远是人的动作`,
        )
      }
      return
    }
    if (node === null || typeof node !== "object") return
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`))
      return
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      walk(value, `${path}.${key}`)
    }
  }
  walk(patch, "patch")
}

/**
 * 应用补丁到 status.json 会话状态对象（纯函数，不改输入；结构类型收口
 * 避免 import novel-session-status 造成循环依赖）：
 *   1. 前置 assertAutoArmPatchNeverAccepts（accept 语义即抛）；
 *   2. 仅当 patch.draft_status==="ready" 且现态为 "pending" 时才置 ready；
 *      ready/accepted/rejected/superseded 现态原样保留——autoarm 永不覆盖
 *      人工裁定（Draft-first：accept 永远是人的动作）；
 *   3. draft_auto_arm 恒写入（无论是否 arm）。
 */
export function applyDraftAutoArmPatch<S extends { draft: { draft_status: string } }>(
  status: S,
  patch: DraftAutoArmPatch,
): S & { draft_auto_arm: DraftAutoArmStatus } {
  assertAutoArmPatchNeverAccepts(patch)
  const current = status.draft.draft_status
  const next =
    patch.draft_status === "ready" && current === "pending"
      ? ("ready" as typeof current)
      : current
  return {
    ...status,
    draft: { ...status.draft, draft_status: next },
    draft_auto_arm: patch.draft_auto_arm,
  }
}