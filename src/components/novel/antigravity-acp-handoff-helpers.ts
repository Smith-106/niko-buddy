// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

/**
 * Pure F1-F15 helpers for building deterministic, strictly read-only
 * Reviewer [RO] handoff pre-fill prompts in the Antigravity ACP panel.
 *
 * Strictly pre-fill only — never invokes IPC or sends prompts automatically,
 * and never suggests write tools.
 */

import type { AcpRoleSlotId, McpToolProfile } from "@/lib/antigravity-acp-client"
import type { ChapterDraft } from "@/lib/novel"
import type { AcpTranscriptItem } from "@/stores/antigravity-acp-store"

export interface ReviewerHandoffContext {
  draftId?: string | null
  chapterName?: string | null
  prepareId?: string | null
  mechanicalGateSummary?: string | null
  attachedLocalMcp?: boolean
}

/**
 * Omit `slot` on wire payloads for default writer sessions when server activeSlot
 * is unset or already `"writer"` to preserve backward compatibility.
 */
export function resolveSessionSlotArg(
  activeSlot: AcpRoleSlotId,
  serverActiveSlot?: AcpRoleSlotId | null,
): AcpRoleSlotId | undefined {
  if (activeSlot === "writer" && (!serverActiveSlot || serverActiveSlot === "writer")) {
    return undefined
  }
  return activeSlot
}

/** Resolve the wire `mcpProfile` argument for a given role slot. */
export function resolveEffectiveSlotProfileArg(
  activeSlot: AcpRoleSlotId,
  profile: McpToolProfile,
): McpToolProfile | undefined {
  if (activeSlot === "reviewer") return "reviewer"
  if (activeSlot === "architect") return "architect"
  return profile === "writer-sub" ? undefined : profile
}

/** Remove saved-draft badges belonging ONLY to messages in a reset/cleared slot. */
export function pruneSavedDraftMapForTranscript(
  prev: Record<string, string>,
  slotTranscript: readonly Pick<AcpTranscriptItem, "id">[],
): Record<string, string> {
  if (slotTranscript.length === 0) return prev
  const ids = new Set(slotTranscript.map((m) => m.id))
  let changed = false
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(prev)) {
    if (ids.has(k)) changed = true
    else next[k] = v
  }
  return changed ? next : prev
}

/** Pick the latest pending (non-saved, non-failed) draft for Reviewer handoff. */
export function buildReviewerHandoffContextFromDrafts(
  drafts: readonly ChapterDraft[],
  writerTranscript: readonly AcpTranscriptItem[],
  attachedLocalMcp: boolean,
  lang: string,
): ReviewerHandoffContext {
  const latestPending = drafts
    .filter((d) => d.status !== "saved" && d.status !== "failed")
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
  return {
    draftId: latestPending?.id ?? null,
    chapterName: latestPending?.chapterName ?? null,
    prepareId: extractLatestPrepareId(writerTranscript),
    mechanicalGateSummary: summarizeDraftGateStatus(latestPending, lang),
    attachedLocalMcp,
  }
}

const MAX_ITEMS_TO_SCAN = 50
const MAX_TEXT_SCAN_CHARS = 20_000
const PREPARE_ID_RE =
  /\bprepare[_-]?id\b\s*(?:[:=]|is)\s*["'`]?([A-Za-z0-9][A-Za-z0-9._:-]{1,95})["'`]?/gi
const INVALID_PREPARE_IDS = new Set([
  "null",
  "undefined",
  "none",
  "nil",
  "na",
  "n/a",
  "true",
  "false",
])

function findLastPrepareIdInText(text: string): string | null {
  if (!text) return null
  const slice = text.length > MAX_TEXT_SCAN_CHARS ? text.slice(-MAX_TEXT_SCAN_CHARS) : text
  PREPARE_ID_RE.lastIndex = 0
  let latest: string | null = null
  let match: RegExpExecArray | null
  while ((match = PREPARE_ID_RE.exec(slice)) !== null) {
    const candidate = match[1]?.trim() ?? ""
    if (!candidate) continue
    if (INVALID_PREPARE_IDS.has(candidate.toLowerCase())) continue
    latest = candidate
  }
  return latest
}

/**
 * Scan the latest writer transcript items (assistant text & tool call titles)
 * for the most recently reported `prepareId` returned by `context.prepare_write`.
 */
export function extractLatestPrepareId(transcript: readonly AcpTranscriptItem[]): string | null {
  if (!transcript || transcript.length === 0) return null
  const start = Math.max(0, transcript.length - MAX_ITEMS_TO_SCAN)
  for (let i = transcript.length - 1; i >= start; i -= 1) {
    const item = transcript[i]
    if (!item || item.role === "user") continue
    const fromText = findLastPrepareIdInText(item.text)
    if (fromText) return fromText
    if (item.tools && item.tools.length > 0) {
      for (let j = item.tools.length - 1; j >= 0; j -= 1) {
        const fromTool = findLastPrepareIdInText(item.tools[j]?.title ?? "")
        if (fromTool) return fromTool
      }
    }
  }
  return null
}

/**
 * Summarize a pending draft's mechanical adoption gate status, truncation flag,
 * and revision round in bilingual zh/en form.
 */
export function summarizeDraftGateStatus(
  draft: Pick<ChapterDraft, "adoptionGate" | "partial" | "revisionRound"> | null | undefined,
  lang: string,
): string | null {
  if (!draft) return null
  const isZh = lang.toLowerCase().startsWith("zh")
  const status = draft.adoptionGate?.status ?? "unassessed"

  const statusMapZh: Record<string, string> = {
    passed: "机械门控已通过 (passed)",
    blocked: "机械门控阻断 (blocked)",
    manual_review: "需人工复核 (manual_review)",
    partial: "部分通过/截断稿 (partial)",
    unassessed: "尚未完成机械门控评估 (unassessed)",
  }
  const statusMapEn: Record<string, string> = {
    passed: "Mechanical gate passed (passed)",
    blocked: "Mechanical gate blocked (blocked)",
    manual_review: "Manual review required (manual_review)",
    partial: "Partial / truncated draft (partial)",
    unassessed: "Mechanical gate unassessed (unassessed)",
  }

  const parts: string[] = [
    (isZh ? statusMapZh[status] : statusMapEn[status]) ??
      (isZh ? statusMapZh.unassessed : statusMapEn.unassessed),
  ]

  if (draft.partial === true && status !== "partial") {
    parts.push(isZh ? "截断稿标记 (partial)" : "truncated draft (partial)")
  }
  if (typeof draft.revisionRound === "number" && draft.revisionRound > 0) {
    parts.push(
      isZh ? `第 ${draft.revisionRound} 轮修订` : `revision round ${draft.revisionRound}`,
    )
  }

  return parts.join(isZh ? "；" : "; ")
}

/**
 * Build a deterministic, strictly read-only Reviewer [RO] handoff prompt for
 * composer pre-fill only (never auto-sent).
 */
export function buildReviewerHandoffPrompt(ctx: ReviewerHandoffContext, lang: string): string {
  const isZh = lang.toLowerCase().startsWith("zh")
  const draftId = ctx.draftId?.trim() || null
  const chapterName = ctx.chapterName?.trim() || null
  const prepareId = ctx.prepareId?.trim() || null
  const gateSummary = ctx.mechanicalGateSummary?.trim() || null

  if (isZh) {
    const contextLines: string[] = []
    if (chapterName) contextLines.push(`- 目标章节：${chapterName}`)
    if (draftId) contextLines.push(`- 待审草稿 draftId：${draftId}`)
    if (prepareId) contextLines.push(`- 主笔上下文包 prepareId：${prepareId}`)
    if (gateSummary) contextLines.push(`- 当前机械门控摘要：${gateSummary}`)
    if (ctx.attachedLocalMcp === false) {
      contextLines.push(
        "- 提示：当前审校槽未挂载本地 MCP，请基于后续附带正文执行纯只读审稿。",
      )
    }

    const readStep = draftId
      ? `1. 仅调用只读工具：先用 draft.read({ draftId: "${draftId}" })（必要时辅以 draft.list）读取待审草稿，并用 rules.get({ sections: ["bookRules"], compact: true })、canon.query、foreshadowing.list、character.read、outline.read、style.exemplars、chapter.search 核对设定与文风（可按需调用 skills.list / skills.get 查阅审校细则）。`
      : `1. 仅调用只读工具：先用 draft.list 与 draft.read 定位并读取最新待审草稿，再用 rules.get({ sections: ["bookRules"], compact: true })、canon.query、foreshadowing.list、character.read、outline.read、style.exemplars、chapter.search 核对设定与文风（可按需调用 skills.list / skills.get 查阅审校细则）。`

    const gateArg = draftId
      ? `gate.check_mechanical({ draftId: "${draftId}", detailLevel: "compact" })`
      : `gate.check_mechanical({ draftId: "<draftId>", detailLevel: "compact" })`

    return [
      `请以独立只读审校角色 [RO] 接手本次草稿审校交接（严禁调用任何写入工具，绝不直接修改或采纳正式章节）：`,
      ...(contextLines.length > 0 ? contextLines : []),
      readStep,
      `2. 执行机械门控检查 ${gateArg}${prepareId ? `（可结合 prepareId "${prepareId}" 核对起草上下文）` : ""}，严格遵循门控优先级：Consistency(P0) > Anti-AI(P1) > Quality(P2)（文学分不得覆盖一致性失败）。`,
      `3. 输出分优先级的结构化审校结论（verdict）与逐段返修清单，交由主笔槽（Writer）处理修订；本次审校全程只读，不得执行任何写操作。`,
    ].join("\n")
  }

  const contextLines: string[] = []
  if (chapterName) contextLines.push(`- Target chapter: ${chapterName}`)
  if (draftId) contextLines.push(`- Pending draftId: ${draftId}`)
  if (prepareId) contextLines.push(`- Writer context pack prepareId: ${prepareId}`)
  if (gateSummary) contextLines.push(`- Mechanical gate summary: ${gateSummary}`)
  if (ctx.attachedLocalMcp === false) {
    contextLines.push(
      "- Note: Local MCP is not attached to this Reviewer slot; perform a strictly read-only review on the text provided.",
    )
  }

  const readStep = draftId
    ? `1. Call ONLY read-only tools: read the pending draft via draft.read({ draftId: "${draftId}" }) (and draft.list if needed), then verify canon and voice via rules.get({ sections: ["bookRules"], compact: true }), canon.query, foreshadowing.list, character.read, outline.read, style.exemplars, and chapter.search (optionally skills.list / skills.get for review rubrics).`
    : `1. Call ONLY read-only tools: locate and read the latest pending draft via draft.list and draft.read, then verify canon and voice via rules.get({ sections: ["bookRules"], compact: true }), canon.query, foreshadowing.list, character.read, outline.read, style.exemplars, and chapter.search (optionally skills.list / skills.get for review rubrics).`

  const gateArg = draftId
    ? `gate.check_mechanical({ draftId: "${draftId}", detailLevel: "compact" })`
    : `gate.check_mechanical({ draftId: "<draftId>", detailLevel: "compact" })`

  return [
    `Please perform an independent read-only Reviewer [RO] handoff review (zero write tools — never modify drafts or formal chapters directly):`,
    ...(contextLines.length > 0 ? contextLines : []),
    readStep,
    `2. Run ${gateArg}${prepareId ? ` (referencing prepareId "${prepareId}" for writing-context continuity)` : ""} and strictly enforce gate priority: Consistency(P0) > Anti-AI(P1) > Quality(P2) (Quality scores must never override Consistency failures).`,
    `3. Output a prioritized, structured review verdict and actionable revision checklist for the Writer slot to apply — strictly read-only with zero write actions.`,
  ].join("\n")
}
