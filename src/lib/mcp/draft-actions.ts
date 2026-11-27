/**
 * MCP 写入动作：章节草稿（P2）+ 正式路径解析（P3）。
 *
 * ## 分工
 *
 * - **章节**：`chapter.write` 写草稿（复用既有 `writeDraft`，落 `.qm-drafts/`，
 *   由 `chapter-draft-dock` 呈现并可 accept）；`chapter.write_direct` 直写正式正文。
 * - **记忆**：`memory.write` 直写正式记忆。
 * - **本文件只负责"草稿怎么写"与"正式文件落在哪"**；直写本身由 Rust 侧统一执行
 *   （快照 → 写 → 审计 → 可回滚），因为只有那一层能保证三者成对出现。
 *
 * ## 为什么直写不违反 Draft-first
 *
 * 硬边界原文是「AI 输出先进草稿，accept 后才回填正式正文与正式记忆」。P3 按批准
 * 方案把它修订为「外部直写必须**留痕且可回滚**」：Draft-first 从强制拦截降级为
 * **默认模式**，直写需要用户逐会话授予 `full` 权限，代价是每次直写都留快照与审计。
 * 也就是说这里不再有"没有确认入口就无处安放"的问题——直写本身就是被批准的那条路。
 *
 * 参考：`src-tauri/src/canon/write_authority.rs` 的 C-002 修订与
 * `src-tauri/src/mcp_server/writes.rs` 的快照实现。
 */

import { normalizePath } from "@/lib/path-utils"
import { logger, toErrorMessage } from "@/lib/utils"
import {
  DRAFTS_DIR,
  HARD_FUSE_LIMIT,
  externalDraftTargetKey,
  formalChapterPathForDraft,
  getExternalDraftRevisionCount,
  loadNovelSessionStatus,
  readDraftChapterNumber,
  syncExternalDraftToSessionStatus,
  writeDraft,
} from "@/lib/novel"
import type { ChapterDraft, DraftGateStatus } from "@/lib/novel"

export interface ChapterDraftResult {
  draftId: string
  chapterName: string
  /** 草稿文件路径（相对项目根）。 */
  path: string
  chars: number
  /** 落盘位置说明，让调用方明白这不是正式章节。 */
  note: string
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} 需要非空字符串`)
  }
  return value
}

/** 章节名不得带路径分隔符——否则草稿文件会落到草稿目录之外。 */
function sanitizeName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]/g, "_")
  /* v8 ignore next -- 台账 mcp/draft-actions.ts L47：cleaned 为空当且仅当 trim 后为空，与 requireText 前置条件矛盾 */
  if (!cleaned) throw new Error("名称清洗后为空")
  return cleaned
}

/**
 * 写一章草稿。复用 `writeDraft`，不自己拼 frontmatter。
 */
export async function writeChapterDraft(
  projectPath: string,
  params: { chapterName?: unknown; content?: unknown; partial?: unknown },
  trustedAdoptionGate?: DraftGateStatus,
): Promise<ChapterDraftResult> {
  const chapterName = sanitizeName(requireText(params.chapterName, "chapterName"))
  const content = requireText(params.content, "content")

  // 章节级持久硬熔断检查（HARD_FUSE_LIMIT = 5）：阻止通过重调 chapter.write 重置修订计数绕过熔断。
  const targetKey = externalDraftTargetKey(projectPath, chapterName)
  const existingStatus = await loadNovelSessionStatus(projectPath).catch(() => null)
  const persistedCount = getExternalDraftRevisionCount(existingStatus, targetKey)
  const hasPriorRevisionRecord = Boolean(
    existingStatus?.external_draft_revisions
    && Object.prototype.hasOwnProperty.call(existingStatus.external_draft_revisions, targetKey),
  )
  if (persistedCount >= HARD_FUSE_LIMIT) {
    throw new Error(
      `HARD_FUSE_LIMIT_EXCEEDED: 章节「${chapterName}」（${targetKey}）已达最大修订轮次（${persistedCount}/${HARD_FUSE_LIMIT}），禁止通过 chapter.write 重置熔断，必须暂停自动修订并交由人工仲裁`,
    )
  }

  const nextRevisionRound = hasPriorRevisionRecord ? persistedCount + 1 : 0
  const sourceConversationId = trustedAdoptionGate ? "mcp:deep-chapter" : "mcp:chapter.write"

  const draft: ChapterDraft = await writeDraft(projectPath, chapterName, content, {
    sourceConversationId,
    ...(trustedAdoptionGate && { adoptionGate: trustedAdoptionGate }),
    ...(params.partial === true ? { partial: true } : {}),
    ...(nextRevisionRound >= 1 ? { revisionRound: nextRevisionRound } : {}),
  })

  // 路径必须与写入器同一个常量：手拼字符串会和真实落点漂移（`.qm-drafts` vs
  // `.novel/drafts`），调用方拿到一个不存在的路径却以为写成功了。
  const draftPath = `${normalizePath(projectPath)}/${DRAFTS_DIR}/${draft.id}.md`

  // 桥接至 `.novel/status.json` 唯一真源（绝不覆盖运行中 Chat `.novel/drafts/` 会话）。
  try {
    await syncExternalDraftToSessionStatus({
      projectPath,
      draftId: draft.id,
      draftPath,
      chapterName: draft.chapterName,
      chapterNumber: readDraftChapterNumber(draft.chapterName),
      targetKey,
      revisionRound: nextRevisionRound,
      sourceConversationId,
    })
  } catch (syncError) {
    logger.warn(
      "mcp:draft-actions",
      `chapter.write status.json sync failed (non-fatal, draft ${draft.id}): ${toErrorMessage(syncError)}`,
    )
  }

  return {
    draftId: draft.id,
    chapterName: draft.chapterName,
    path: draftPath,
    chars: content.length,
    note: "已写入草稿区，尚未进入正式章节。需在应用内确认后才会回填正式正文。",
  }
}

/**
 * 解析「章节名 / 记忆名」对应的正式文件虚拟路径。
 *
 * 只解析、不写入。两件事必须分开：路径知识只有一份（在前端），写入纪律只有一份
 * （在 Rust 的 `direct_write`）。把两者塞进一处，就会有一边悄悄漂移——P2 已经踩过
 * 一次（手拼 `.novel/drafts/` 而实际落 `.qm-drafts/`，调用方拿到不存在的路径）。
 *
 * 返回的是**虚拟路径**（`wiki/...`），由 Rust 的 `resolve_project_storage_path`
 * 映射成物理路径（`QM/...`）。前端不在这里做映射，Rust 不在这里做命名。
 */
export function resolveFormalPath(
  projectPath: string,
  params: { kind?: unknown; name?: unknown },
): { kind: string; path: string } {
  const kind = requireText(params.kind, "kind")
  const name = requireText(params.name, "name")

  if (kind === "chapter") {
    // 复用既有的正式章路径规则（与草稿 accept 同一条），不另写一份命名逻辑。
    return {
      kind,
      path: formalChapterPathForDraft(projectPath, sanitizeName(name), null),
    }
  }
  if (kind === "memory") {
    return {
      kind,
      path: `${normalizePath(projectPath)}/wiki/memory/${sanitizeName(name)}.md`,
    }
  }
  throw new Error(`formal-path: kind 只接受 chapter | memory，收到 ${kind}`)
}
