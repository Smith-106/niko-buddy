// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

/**
 * Writer-first quick action bar for the official Antigravity ACP panel.
 *
 * Google Antigravity ToS compliance boundary:
 * - Clicking a quick-action button ONLY pre-fills the composer textarea for
 *   explicit human review and manual submission.
 * - Never auto-sends prompts or triggers silent background execution loops.
 */

import { useTranslation } from "react-i18next"
import { BookCheck, BookOpen, Compass, FileEdit, SearchCheck, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { McpToolProfile } from "@/lib/antigravity-acp-client"
import type { FileNode } from "@/types/wiki"

export type WriterQuickActionId =
  | "draft_next"
  | "review_current"
  | "polish_draft"
  | "canon_audit"
  | "book_setup"
  | "workflow_next"

export type QuickActionRecommendationReason =
  | "reviewerProfile"
  | "architectProfile"
  | "pendingDrafts"
  | "noChapters"
  | "readyNext"

export interface QuickActionRecommendation {
  actionId: WriterQuickActionId
  reason: QuickActionRecommendationReason
}

export interface ResolveRecommendedQuickActionInput {
  chapterCount: number
  pendingDraftCount?: number | null
  activeProfile?: McpToolProfile | null
}

/**
 * Deterministically resolve the single recommended quick action based on active
 * MCP tool profile, pending draft count, and formal chapter count.
 */
export function resolveRecommendedQuickAction({
  chapterCount,
  pendingDraftCount,
  activeProfile,
}: ResolveRecommendedQuickActionInput): QuickActionRecommendation {
  if (activeProfile === "reviewer") {
    return { actionId: "review_current", reason: "reviewerProfile" }
  }
  if (activeProfile === "architect") {
    return { actionId: "book_setup", reason: "architectProfile" }
  }
  if ((pendingDraftCount ?? 0) > 0) {
    return { actionId: "review_current", reason: "pendingDrafts" }
  }
  if (chapterCount === 0) {
    return { actionId: "book_setup", reason: "noChapters" }
  }
  return { actionId: "draft_next", reason: "readyNext" }
}

export interface InferredChapterContext {
  currentChapter: number | null
  nextChapter: number
  currentChapterPath: string | null
  latestChapter: number | null
  chapterCount: number
}

const CHAPTER_DIR_RE = /(?:^|\/)(?:wiki\/)?chapters\/([^/]+)\.md$/i
const CHAPTER_NUM_PATTERNS: RegExp[] = [
  /^(?:chapter|ch|c)[_\-\s]*0*(\d+)(?:$|[_\-\s.])/i,
  /第\s*0*(\d+)\s*章/,
  /^0*(\d+)(?:$|[_\-\s.])/,
]

function normalizeSlashes(rawPath: string): string {
  return rawPath.replace(/\\/g, "/")
}

function extractChapterNumberFromPath(rawPath: string): number | null {
  const normalized = normalizeSlashes(rawPath)
  const match = normalized.match(CHAPTER_DIR_RE)
  if (!match) return null
  const stem = match[1]?.trim() ?? ""
  if (!stem) return null
  for (const re of CHAPTER_NUM_PATTERNS) {
    const m = stem.match(re)
    if (m?.[1]) {
      const parsed = Number.parseInt(m[1], 10)
      if (Number.isSafeInteger(parsed) && parsed >= 1) {
        return parsed
      }
    }
  }
  return null
}

/**
 * Deterministically infer the current chapter and next chapter number from the
 * project's file tree (`wiki/chapters` or `chapters`) and active selected file.
 */
export function inferChapterContext(
  fileTree: FileNode[],
  selectedFile: string | null,
): InferredChapterContext {
  const chapterEntries: Array<{ num: number; path: string; normalized: string }> = []

  const walk = (nodes: FileNode[]): void => {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children && node.children.length > 0) {
          walk(node.children)
        }
        continue
      }
      const num = extractChapterNumberFromPath(node.path)
      if (num !== null) {
        chapterEntries.push({
          num,
          path: node.path,
          normalized: normalizeSlashes(node.path),
        })
      }
    }
  }
  walk(fileTree)

  chapterEntries.sort((a, b) =>
    a.num !== b.num ? a.num - b.num : a.normalized.localeCompare(b.normalized),
  )

  const uniqueNums = new Set(chapterEntries.map((e) => e.num))
  const latestEntry =
    chapterEntries.length > 0 ? chapterEntries[chapterEntries.length - 1]! : null

  const selectedNum = selectedFile ? extractChapterNumberFromPath(selectedFile) : null
  if (selectedNum !== null) {
    uniqueNums.add(selectedNum)
  }

  let latestChapter = latestEntry?.num ?? null
  if (selectedNum !== null && (latestChapter === null || selectedNum > latestChapter)) {
    latestChapter = selectedNum
  }

  const currentChapter = selectedNum ?? latestEntry?.num ?? null
  const currentChapterPath =
    selectedNum !== null ? selectedFile : latestEntry?.path ?? null
  const nextChapter = latestChapter !== null ? latestChapter + 1 : 1

  return {
    currentChapter,
    nextChapter,
    currentChapterPath,
    latestChapter,
    chapterCount: uniqueNums.size,
  }
}

/**
 * Generate a grounded bilingual writing instruction referencing Niko Buddy's
 * local MCP tools and Draft-first / gate-priority safety contracts.
 */
export function buildWriterQuickActionPrompt(
  actionId: WriterQuickActionId,
  ctx: InferredChapterContext,
  lang: string,
): string {
  const isZh = lang.toLowerCase().startsWith("zh")

  if (actionId === "workflow_next") {
    if (isZh) {
      return [
        `请执行只读的「下一步写作指引」（严禁调用任何写入工具）：`,
        `1. 仅调用只读工具 workflow.next、project.state、draft.list 与 foreshadowing.list，核查当前写作阶段、待审草稿积压与临期伏笔债务。`,
        `2. 结合门控优先级（Consistency(P0) > Anti-AI(P1) > Quality(P2)）给出当下最优先的单一执行步骤与推荐 MCP 档位。`,
        `3. 仅输出建议与核查清单，不要写入任何草稿、大纲或正式章节。`,
      ].join("\n")
    }
    return [
      `Please run a read-only Next-Step Workflow Guide (zero write calls):`,
      `1. Call ONLY read-only tools: workflow.next, project.state, draft.list, and foreshadowing.list to inspect current stage, pending draft queue, and due foreshadowing debts.`,
      `2. Recommend the single highest-priority next action and matching MCP profile respecting Consistency(P0) > Anti-AI(P1) > Quality(P2).`,
      `3. Output guidance and checklist only — do NOT call any write tools.`,
    ].join("\n")
  }

  if (actionId === "draft_next") {
    if (isZh) {
      const prevHint =
        ctx.latestChapter !== null
          ? `并按需调用 chapter.read 读取第 ${ctx.latestChapter} 章衔接上下文`
          : "若已有前文请按需用 chapter.read 读取衔接"
      return [
        `请协助起草第 ${ctx.nextChapter} 章草稿：`,
        `1. 可先用 workflow.next 核对当前步骤，再调用 context.prepare_write({ targetChapter: ${ctx.nextChapter}, retrievalMode: "local_only" }) 与 rules.get({ sections: ["bookRules"], compact: true })（记录返回的 prepareId 供后续审校复用，并按需辅以 foreshadowing.list / character.read / outline.read / style.exemplars / project.state / canon.query）打包本章上下文、写作规则与正典设定，${prevHint}。`,
        `2. 严格遵守 Draft-first 安全边界：仅通过 chapter.write 将第 ${ctx.nextChapter} 章写入待审草稿区，切勿直接覆盖正式章节或正式记忆。`,
        `3. 写完草稿后立即调用 gate.check_mechanical({ draftId: "<chapter.write 返回的 draftId>", detailLevel: "compact" }) 对新草稿做机械门控自检，按 Consistency(P0) > Anti-AI(P1) > Quality(P2) 优先级汇报问题与改进建议。`,
      ].join("\n")
    }
    const prevHint =
      ctx.latestChapter !== null
        ? `and call chapter.read on Chapter ${ctx.latestChapter} for continuity if needed`
        : "and call chapter.read on any prior chapter for continuity if needed"
    return [
      `Please draft Chapter ${ctx.nextChapter} into the Draft area:`,
      `1. Optionally check workflow.next first, then call context.prepare_write({ targetChapter: ${ctx.nextChapter}, retrievalMode: "local_only" }) and rules.get({ sections: ["bookRules"], compact: true }) (keep the returned prepareId for downstream review reuse; optionally call foreshadowing.list / character.read / outline.read / style.exemplars / project.state / canon.query) to assemble the writing context, rules, and canon facts, ${prevHint}.`,
      `2. Strictly obey the Draft-first safety boundary: write Chapter ${ctx.nextChapter} ONLY via chapter.write to the pending draft area (never overwrite formal chapters or formal memory directly).`,
      `3. Immediately run gate.check_mechanical({ draftId: "<draftId returned by chapter.write>", detailLevel: "compact" }) on the new draft and summarize findings prioritized as Consistency(P0) > Anti-AI(P1) > Quality(P2).`,
    ].join("\n")
  }

  if (actionId === "book_setup") {
    if (isZh) {
      return [
        `请协助完成新书建档与卷章大纲起草：`,
        `1. 先调用 workflow.next、director.check、outline.read 与 rules.get({ sections: ["bookRules"], compact: true })（可辅以 project.state / character.read）核查当前项目建档进度、阶段门禁、既有大纲与书稿规则。`,
        `2. 基于当前已有设定与缺口，梳理核心卖点、主角弧光、世界观硬规则与开篇分章大纲。`,
        `3. 严格遵守 Draft-first 安全边界：仅通过 outline.write（及按需 character.upsert）将整理好的大纲写入规划区，并列出进入第 ${ctx.nextChapter} 章起草前需要作者确认的设定项。`,
      ].join("\n")
    }
    return [
      `Please help set up the book dossier and draft the outline:`,
      `1. First call workflow.next, director.check, outline.read, and rules.get({ sections: ["bookRules"], compact: true }) (optionally project.state / character.read) to inspect setup readiness, phase gates, existing outline, and writing rules.`,
      `2. Review existing canon notes and missing gaps to propose the core premise, protagonist arc, world rules, and opening chapter beats.`,
      `3. Strictly obey the Draft-first safety boundary: save the drafted outline via outline.write (and character.upsert if needed) and list canon decisions needing author confirmation before drafting Chapter ${ctx.nextChapter}.`,
    ].join("\n")
  }

  if (actionId === "review_current") {
    const targetLabelZh =
      ctx.currentChapter !== null ? `第 ${ctx.currentChapter} 章` : "当前最新章节/草稿"
    const targetLabelEn =
      ctx.currentChapter !== null ? `Chapter ${ctx.currentChapter}` : "the latest chapter or draft"
    const formalChapterArgZh =
      ctx.currentChapter !== null ? `"${ctx.currentChapter}"` : `"<章号>"`
    const formalChapterArgEn =
      ctx.currentChapter !== null ? `"${ctx.currentChapter}"` : `"<chapterNumber>"`
    if (isZh) {
      return [
        `请对${targetLabelZh}执行深度审稿：`,
        `1. 先调用 draft.list 检查待审草稿，复用此前 context.prepare_write 返回的 prepareId 或按需使用 draft.read / chapter.read 读取正文，再调用 rules.get({ sections: ["bookRules"], compact: true })、canon.query 及原子只读工具（foreshadowing.list、character.read、outline.read、style.exemplars、chapter.search）核对设定规则、伏笔与文风。`,
        `2. 机械门控检查请区分来源：待审草稿调用 gate.check_mechanical({ draftId: "<draft.list 返回的 draftId>", detailLevel: "compact" })；已入库正式章调用 gate.check_mechanical({ chapter: ${formalChapterArgZh}, detailLevel: "compact" })（chapter 须为带引号的字符串）。严格遵循门控优先级：Consistency(P0) > Anti-AI(P1) > Quality(P2)（文学分不得覆盖一致性失败）。`,
        `3. 输出分优先级的结构化审稿结论与段落返修清单：若当前处于只读 reviewer 档位，请输出结构化 verdict 交由 writer-sub 调用 draft.record_review 记录；本次审查绝不直接修改或采纳正式正文。`,
      ].join("\n")
    }
    return [
      `Please review ${targetLabelEn} thoroughly:`,
      `1. Call draft.list to locate pending drafts, reuse prepareId from context.prepare_write if available, read text via draft.read or chapter.read, and cross-check rules.get({ sections: ["bookRules"], compact: true }), canon.query, and atomic read tools (foreshadowing.list, character.read, outline.read, style.exemplars, chapter.search).`,
      `2. Run mechanical gates by target type: for a pending draft call gate.check_mechanical({ draftId: "<draftId from draft.list>", detailLevel: "compact" }); for a formal chapter call gate.check_mechanical({ chapter: ${formalChapterArgEn}, detailLevel: "compact" }) (chapter must be a quoted string). Strictly prioritize findings as Consistency(P0) > Anti-AI(P1) > Quality(P2) (Quality scores must never override Consistency failures).`,
      `3. Output a prioritized, structured review verdict and actionable revision checklist: in read-only reviewer profile, output the structured verdict for writer-sub to record via draft.record_review; never directly modify or adopt formal chapters.`,
    ].join("\n")
  }

  if (actionId === "polish_draft") {
    if (isZh) {
      return [
        `请精修当前待审草稿区中的最新草稿：`,
        `1. 调用 draft.list 与 draft.read 读取待审草稿，再调用 rules.get({ sections: ["bookRules"], compact: true })（可辅以 style.exemplars 参考文风范例）与 gate.check_mechanical({ draftId: "<待审草稿的 draftId>", detailLevel: "compact" }) 定位当前机械问题、AI 腔与节奏瑕疵。`,
        `2. 在严格保持正典事实一致性的前提下完成定向精修：局部修补优先使用 draft.patch（务必携带 expectedSha256 并遵守 HARD_FUSE_LIMIT = 5 熔断上限）；仅在整章大幅重写时回退调用 chapter.write。`,
        `3. 严禁直写正式章节；修改后再次调用 gate.check_mechanical({ draftId: "<更新后的 draftId>", detailLevel: "compact" }) 复检确认通过，并可按需调用 draft.record_review 记录复核结果。`,
      ].join("\n")
    }
    return [
      `Please polish the latest pending draft:`,
      `1. Call draft.list and draft.read to inspect the pending draft, then call rules.get({ sections: ["bookRules"], compact: true }) (optionally style.exemplars for voice anchors) and gate.check_mechanical({ draftId: "<pending draftId>", detailLevel: "compact" }) to identify mechanical, Anti-AI, and pacing issues.`,
      `2. Revise the draft while preserving all canon facts: prefer surgical edits via draft.patch (always pass expectedSha256 and respect HARD_FUSE_LIMIT = 5 per pass), falling back to chapter.write only for full chapter rewrites.`,
      `3. Never overwrite formal chapters directly; re-run gate.check_mechanical({ draftId: "<updated draftId>", detailLevel: "compact" }) to verify PASS, and record structured outcomes via draft.record_review if needed.`,
    ].join("\n")
  }

  // canon_audit — strictly read-only, works in `read` scope
  if (isZh) {
    return [
      `请执行只读的「设定与伏笔体检」（严禁调用任何写入工具，read 权限域即可运行）：`,
      `1. 仅使用只读工具 project.state、canon.query、rules.get({ sections: ["bookRules"], compact: true })、foreshadowing.list、character.read、outline.read、chapter.search 梳理当前作品的人物状态、世界观硬规则、大纲脉络与未回收伏笔。`,
      `2. 标注潜在的设定冲突、战力/时间线矛盾及临近回收节点的伏笔清单。`,
      `3. 仅输出体检报告与后续写作提醒，不要执行任何文件或草稿写入。`,
    ].join("\n")
  }
  return [
    `Please run a read-only Canon & Foreshadowing Audit (zero write calls — works in read scope):`,
    `1. Use only read-only tools: project.state, canon.query, rules.get({ sections: ["bookRules"], compact: true }), foreshadowing.list, character.read, outline.read, and chapter.search to inspect character states, world rules, outline continuity, and unresolved foreshadowing threads.`,
    `2. Flag any canon contradictions, timeline/power-scale mismatches, and foreshadowing threads due for payoff.`,
    `3. Output the audit report and recommendations only — do NOT call any write tools.`,
  ].join("\n")
}

export interface AntigravityAcpQuickActionsProps {
  chapterContext: InferredChapterContext
  disabled: boolean
  onSelectPrompt: (prompt: string) => void
  pendingDraftCount?: number | null
  activeProfile?: McpToolProfile | null
}

export function AntigravityAcpQuickActions({
  chapterContext,
  disabled,
  onSelectPrompt,
  pendingDraftCount = null,
  activeProfile = null,
}: AntigravityAcpQuickActionsProps) {
  const { t, i18n } = useTranslation()

  const recommendation = resolveRecommendedQuickAction({
    chapterCount: chapterContext.chapterCount,
    pendingDraftCount,
    activeProfile,
  })

  const actions: Array<{
    id: WriterQuickActionId
    label: string
    roleBadge: string
    icon: typeof FileEdit
  }> = [
    {
      id: "draft_next",
      label: t("antigravityAcp.quickActions.draftNext", {
        chapter: chapterContext.nextChapter,
      }),
      roleBadge: t("antigravityAcp.quickActions.roles.writer"),
      icon: FileEdit,
    },
    {
      id: "review_current",
      label: t("antigravityAcp.quickActions.reviewCurrent"),
      roleBadge: t("antigravityAcp.quickActions.roles.editor"),
      icon: SearchCheck,
    },
    {
      id: "polish_draft",
      label: t("antigravityAcp.quickActions.polishDraft"),
      roleBadge: t("antigravityAcp.quickActions.roles.polish"),
      icon: Sparkles,
    },
    {
      id: "canon_audit",
      label: t("antigravityAcp.quickActions.canonAudit"),
      roleBadge: t("antigravityAcp.quickActions.roles.canon"),
      icon: BookCheck,
    },
    {
      id: "book_setup",
      label: t("antigravityAcp.quickActions.bookSetup"),
      roleBadge: t("antigravityAcp.quickActions.roles.architect"),
      icon: BookOpen,
    },
    {
      id: "workflow_next",
      label: t("antigravityAcp.quickActions.workflowNext"),
      roleBadge: t("antigravityAcp.quickActions.roles.guide"),
      icon: Compass,
    },
  ]

  const lang = i18n.language || "zh"

  return (
    <div className="space-y-1">
      <div
        role="toolbar"
        aria-label={t("antigravityAcp.quickActions.toolbarLabel")}
        data-testid="acp-quick-actions-toolbar"
        className="flex flex-wrap items-center gap-1.5"
      >
        {actions.map((action) => {
          const Icon = action.icon
          const isRecommended = recommendation.actionId === action.id
          return (
            <Button
              key={action.id}
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              title={t("antigravityAcp.quickActions.hint")}
              onClick={() =>
                onSelectPrompt(buildWriterQuickActionPrompt(action.id, chapterContext, lang))
              }
              data-testid={`acp-quick-action-${action.id}`}
              data-recommended={isRecommended ? "true" : undefined}
              className={`h-7 px-2.5 text-xs ${
                isRecommended ? "border-primary/70 bg-primary/10" : ""
              }`}
            >
              <Icon className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              <span>{action.label}</span>
              <span
                data-testid={`acp-quick-action-role-${action.id}`}
                className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] font-normal text-muted-foreground"
              >
                {action.roleBadge}
              </span>
              {isRecommended && (
                <span
                  data-testid="acp-quick-action-recommended"
                  className="ml-1 rounded bg-primary/15 px-1 py-0.5 text-[10px] font-medium text-primary"
                >
                  {t("antigravityAcp.quickActions.recommendedBadge")}
                </span>
              )}
            </Button>
          )
        })}
        <span className="text-[11px] text-muted-foreground">
          {t("antigravityAcp.quickActions.hint")}
        </span>
      </div>
      <p
        role="status"
        aria-live="polite"
        data-testid="acp-quick-actions-workflow-hint"
        className="text-[11px] text-muted-foreground"
      >
        {t(`antigravityAcp.quickActions.workflowHints.${recommendation.reason}`, {
          chapter: chapterContext.nextChapter,
          count: pendingDraftCount ?? 0,
        })}
      </p>
    </div>
  )
}
