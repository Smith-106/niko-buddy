import { useWikiStore } from "@/stores/wiki-store"
import { streamChat, combineAbortSignals, extractJsonArraySpan, isRequestCancelledError, isTransportInactivityError, type ChatMessage, type StreamCallbacks } from "@/lib/llm-client"
import { createDirectory, deleteFile, writeFileAtomic, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { resolveNovelModel } from "./model-resolver"
import type { ContextPack } from "./context-engine"
import {
  buildNextStatus,
  loadNovelSessionStatus,
  persistCheckpointBase,
} from "./novel-session-status"

/**
 * EPIC-002 / ADR-30 / TASK-011: Scene 数据模型 — 阶段 1.5 中间层产物。
 *
 * Scene 是 blueprint→scene list→task_brief 中间层的单场景结构（DA-02）。
 * 7 字段：sceneId 唯一标识、sceneTitle 场景标题、location 地点、
 * characters 出场角色、goal 场景目标、tension 冲突张力、beat 叙事节拍。
 *
 * scenes.json 是章节级中间态产物（类似 chapters/{n}/draft），pending→ready→accept
 * （ADR-08 Draft-first），accept 前不污染正式层。非会话状态真源（HARD-1 status.json
 * sole truth-source — 真源是 .novel/status.json，scenes.json 是章节级产物）。
 */
export interface Scene {
  sceneId: string
  sceneTitle: string
  location: string
  characters: string[]
  goal: string
  tension: string
  beat: string
}

/**
 * runSceneBreakdown 单次 LLM 调用结果。partial 通过 typed signal 传播（spec
 * S-444k — partial flag in return type, not display callback），经
 * collectModelText → runDeepChapter → chat-panel 路由到 pause / continue-unfinished
 * 路径而非 complete->ready->writeback（Draft-first 边界）。
 */
export interface SceneBreakdownResult {
  scenes: Scene[]
  partial?: boolean
  partialReason?: string
  tokenCost?: number
  latencyMs?: number
}

const SCENE_ID_PREFIX = "scene-"
const SCENE_BREAKDOWN_TIMEOUT_MS = 120000
const USER_ABORT_MESSAGE = "用户已取消生成"
const SCENES_DIR = "chapters"
const SCENES_PENDING_FILE = "scenes.pending.json"
const SCENES_FORMAL_FILE = "scenes.json"

/**
 * Transport inactivity errors are recoverable when partial scene content already
 * streamed: the transport simply lost patience before the next token arrived.
 * isTransportInactivityError / isRequestCancelledError now imported from
 * @/lib/llm-client (ISS-20260712-MAINT-3 consolidation) so the partial-preserve
 * path matches the main chapter pipeline's recoverability contract (spec S-444k).
 * Genuine hangs (no content) and deterministic errors (auth/config/cancellation)
 * still throw.
 */

/**
 * ADR-31 (EPIC-000, lifecycle-twin factory extraction): chapter-level scene
 * artifacts are co-located under `.novel/chapters/{n}/`. This is the
 * intermediate-product layer (like chapters/{n}/draft), NOT the session
 * truth-source (HARD-1: status.json remains the sole truth-source).
 *
 * `chapterId` is the chapter number; sanitized defensively against path
 * traversal (defense-in-depth, mirroring sanitizeDraftId in
 * novel-session-status.ts:189) even though chapter numbers are internal ints.
 */
function chaptersDirPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.novel/${SCENES_DIR}`
}

function chapterScenesDirPath(projectPath: string, chapterId: string | number): string {
  const safeChapterId = String(chapterId).replace(/[^a-zA-Z0-9_-]/g, "-")
  return `${chaptersDirPath(projectPath)}/${safeChapterId}`
}

function scenesPendingPath(projectPath: string, chapterId: string | number): string {
  return `${chapterScenesDirPath(projectPath, chapterId)}/${SCENES_PENDING_FILE}`
}

function scenesFormalPath(projectPath: string, chapterId: string | number): string {
  return `${chapterScenesDirPath(projectPath, chapterId)}/${SCENES_FORMAL_FILE}`
}

async function ensureChapterScenesDir(projectPath: string, chapterId: string | number): Promise<void> {
  await createDirectory(chapterScenesDirPath(projectPath, chapterId))
}

/**
 * Build the scene-breakdown prompt from a chapter blueprint + context pack.
 * Single LLM call: blueprint → scene list (JSON array of Scene objects).
 *
 * The prompt asks the model to emit ONLY a JSON array of Scene objects with
 * the 7 canonical fields, no prose preamble or markdown fence — so the raw
 * streamed text is directly parseable (mirrors dimension-review-adapter.ts
 * final JSON prompt pattern).
 */
function buildSceneBreakdownPrompt(blueprint: string, contextPack: ContextPack): string {
  return [
    "你是网文结构拆解编辑。根据给定的章节蓝图与上下文，把这一章拆成 3-8 个连续场景。",
    "只输出一个 JSON 数组，不要输出解释、标题或 markdown 代码块。",
    '数组元素结构（7 字段，键名固定）：',
    '{',
    '  "sceneId": "scene-1",',
    '  "sceneTitle": "场景标题",',
    '  "location": "场景地点",',
    '  "characters": ["出场角色名"],',
    '  "goal": "本场景目标",',
    '  "tension": "本场景冲突/张力",',
    '  "beat": "本场景叙事节拍"',
    '}',
    "sceneId 形如 scene-1、scene-2，按场景顺序递增。",
    "characters 是出场角色名数组，至少包含主角（除非该场景确无角色出场）。",
    "",
    "章节蓝图：",
    blueprint,
    "",
    "章节目标：",
    contextPack.chapterGoal,
    "",
    "章节大纲：",
    contextPack.outline,
    "",
    "必须做：",
    contextPack.mustDo,
    "",
    "必须避免：",
    contextPack.mustAvoid,
    "",
    "上一章结尾：",
    contextPack.previousChapterEnding,
    "",
    "角色状态：",
    contextPack.characterStates,
  ].join("\n")
}

/**
 * Parse the raw streamed LLM text into a Scene[] array. Tolerates a leading
 * markdown fence (```json … ```) and surrounding prose, then expects a JSON
 * array. Each element is validated + coerced to the 7-field shape; invalid
 * elements are dropped rather than throwing the whole list (graceful degradation
 * — a partial parse is still usable scene structure, consistent with the
 * partial-preserve contract).
 */
function parseScenes(raw: string): Scene[] {
  const text = raw.trim()
  if (!text) return []
  // 提取首个 JSON 数组 span（PAT-G2 dedup: 共享 @/lib/llm-client
  // extractJsonArraySpan，含 stripCodeFence + 配平提取）。
  const span = extractJsonArraySpan(text)
  if (!span) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(span)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const scenes: Scene[] = []
  for (let i = 0; i < parsed.length; i++) {
    const candidate = parsed[i] as Record<string, unknown> | null
    if (!candidate || typeof candidate !== "object") continue
    const characters = Array.isArray(candidate.characters)
      ? candidate.characters.filter((c): c is string => typeof c === "string")
      : []
    const sceneId = typeof candidate.sceneId === "string" && candidate.sceneId
      ? candidate.sceneId
      : `${SCENE_ID_PREFIX}${i + 1}`
    const sceneTitle = typeof candidate.sceneTitle === "string" ? candidate.sceneTitle : ""
    const location = typeof candidate.location === "string" ? candidate.location : ""
    const goal = typeof candidate.goal === "string" ? candidate.goal : ""
    const tension = typeof candidate.tension === "string" ? candidate.tension : ""
    const beat = typeof candidate.beat === "string" ? candidate.beat : ""
    // Skip totally-empty elements (no title and no goal) — not a real scene.
    if (!sceneTitle && !goal) continue
    scenes.push({ sceneId, sceneTitle, location, characters, goal, tension, beat })
  }
  return scenes
}

/**
 * EPIC-002 / ADR-30 / Story 2.1: 单次 LLM 调用 blueprint → 场景列表。
 *
 * @param blueprint 章节蓝图文本（阶段 1 contextPack 之后、阶段 2 task_brief 之前的产物）
 * @param contextPack 阶段 1 装配的上下文包
 * @param signal 可选 AbortSignal，PAT-DC3 级联到 streamChat（signal?.aborted 检查 + 传递）
 *
 * 复用现有 streamChat 调用模式（dimension-review-adapter.ts:414 runDimensionStage
 * 参考：直接 import streamChat，StreamCallbacks onToken/onDone/onError，AbortSignal
 * 传递）。不新建 LLM client。
 *
 * catch 块脱敏（PAT-DC1 / CWE-532）：console.error 只记 message，throw new Error
 * ('scene breakdown failed') 无 raw error / provider detail。
 *
 * partial-preserve 路径（spec S-444k typed signal）：transport-inactivity 错误且已
 * 流式部分场景时返回 { scenes, partial: true, partialReason }，非 display callback —
 * 调用方（collectModelText → runDeepChapter → chat-panel）据 partial flag 路由到
 * pause / continue-unfinished 而非 complete->ready->writeback。
 */
export async function runSceneBreakdown(
  blueprint: string,
  contextPack: ContextPack,
  signal?: AbortSignal,
): Promise<SceneBreakdownResult> {
  const startedAt = Date.now()
  if (signal?.aborted) throw new Error(USER_ABORT_MESSAGE)

  const storeState = useWikiStore.getState()
  const llmConfig = resolveNovelModel(
    storeState.llmConfig,
    storeState.novelConfig,
    "writing",
  )

  const prompt = buildSceneBreakdownPrompt(blueprint, contextPack)
  const messages: ChatMessage[] = [
    { role: "system", content: "你是网文结构拆解编辑，负责把章节蓝图拆成连续场景列表。输出必须使用中文，且只输出 JSON 数组。" },
    { role: "user", content: prompt },
  ]

  let rawContent = ""
  let streamError: Error | null = null

  const streamCallbacks: StreamCallbacks = {
    onToken: (token: string) => {
      if (signal?.aborted) return
      rawContent += token
    },
    onDone: () => {},
    onError: (error: Error) => {
      // F-16 / PAT-DC1 (CWE-532): message-only to avoid leaking provider request details.
      streamError = error
    },
  }

  // `streamError` is assigned inside the onError callback, so TS control-flow
  // treats it as `null` everywhere outside that callback. Read it through a
  // closure accessor so the real `Error | null` type survives for the
  // recoverability check below (mirrors collectModelText :1648 readStreamError).
  const readStreamError = (): Error | null => streamError

  // PAT-DC3: cascade AbortSignal to streamChat. combineAbortSignals not needed
  // here (no internal stop-controller like collectModelText's repeat-detection)
  // — we pass the caller's signal directly so an abort propagates to the
  // underlying fetch/subprocess transport.
  const timeoutSignal = AbortSignal.timeout(SCENE_BREAKDOWN_TIMEOUT_MS)
  const combinedSignal = combineAbortSignals(signal, timeoutSignal)

  try {
    await streamChat(llmConfig, messages, streamCallbacks, combinedSignal, {
      reasoning: { mode: storeState.novelConfig.reviewReasoningEffort ?? "high" },
    })
  } catch (error) {
    // PAT-DC1: sanitize. The thrown error from streamChat may carry provider
    // URL / auth detail; rethrow a generic message-only error so the chat-panel
    // pause path never logs raw provider internals. console.error logs only the
    // message string (CWE-532), matching runDimensionStage's pattern.
    const errMsg = error instanceof Error ? error.message : String(error)
    console.error("[Scene Breakdown] stream error:", errMsg)
    // If the user aborted, surface the abort (not a generic failure) so the
    // caller's pause path records a cancellation, not a crash.
    if (signal?.aborted || isRequestCancelledError(error instanceof Error ? error : new Error(errMsg))) {
      throw new Error(USER_ABORT_MESSAGE)
    }
    // Transport-inactivity with partial content → partial-preserve (S-444k).
    const cause = error instanceof Error ? error : new Error(errMsg)
    const scenesFromPartial = parseScenes(rawContent)
    if (scenesFromPartial.length > 0 && isTransportInactivityError(cause)) {
      return {
        scenes: scenesFromPartial,
        partial: true,
        partialReason: cause.message,
        latencyMs: Date.now() - startedAt,
      }
    }
    throw new Error("scene breakdown failed")
  }

  if (signal?.aborted) throw new Error(USER_ABORT_MESSAGE)

  // streamChat's onError callback assigns streamError but does not throw —
  // surface it here (mirrors collectModelText :1664-1683 recoverability check).
  const streamErrorNow = readStreamError()
  if (streamErrorNow && !signal?.aborted) {
    const cause = streamErrorNow
    const scenesFromPartial = parseScenes(rawContent)
    if (scenesFromPartial.length > 0 && isTransportInactivityError(cause)) {
      // S-444k typed signal: partial flag in the return type, not a display callback.
      return {
        scenes: scenesFromPartial,
        partial: true,
        partialReason: cause.message,
        latencyMs: Date.now() - startedAt,
      }
    }
    // PAT-DC1: message-only log, generic throw.
    console.error("[Scene Breakdown] stream error:", cause.message)
    if (isRequestCancelledError(cause)) {
      throw new Error(USER_ABORT_MESSAGE)
    }
    throw new Error("scene breakdown failed")
  }

  const scenes = parseScenes(rawContent)
  return {
    scenes,
    latencyMs: Date.now() - startedAt,
  }
}

/**
 * EPIC-002 / ADR-30 / Story 2.1 + ADR-31: persistSceneBreakdownDraft writes
 * the scene list to `.novel/chapters/{n}/scenes.pending.json` (Draft-first pending,
 * ADR-08) AND threads the lifecycle through the EPIC-000 factory.
 *
 * ADR-31 lifecycle-twin factory (硬先决, C-002): uses buildNextStatus(base, delta)
 * + persistCheckpointBase to write .novel/status.json (the sole session
 * truth-source, HARD-1) — NOT a manually-inlined next-status literal block. This
 * is the 8th persistence path ADR-31 warned about; the factory eliminates the
 * 5th lifecycle-twin recurrence risk by centralizing the 9 drifting fields.
 *
 * The scene artifacts themselves live at `.novel/chapters/{n}/scenes.pending.json`
 * (chapter-level intermediate product, like chapters/{n}/draft) — NOT a second
 * session-state file. status.json's evidence_refs is extended to reference the
 * pending scene path so the orchestrator can trace it.
 */
export async function persistSceneBreakdownDraft(
  projectPath: string,
  chapterId: string,
  result: SceneBreakdownResult,
): Promise<void> {
  const pendingPath = scenesPendingPath(projectPath, chapterId)
  await ensureChapterScenesDir(projectPath, chapterId)
  const payload = {
    chapter_id: chapterId,
    scenes: result.scenes,
    partial: result.partial ?? false,
    partial_reason: result.partialReason,
    token_cost: result.tokenCost,
    latency_ms: result.latencyMs,
    created_at: new Date().toISOString(),
  }
  await writeFileAtomic(pendingPath, JSON.stringify(payload, null, 2))

  // ADR-31: thread the session lifecycle through the factory. Load the current
  // status.json truth-source, build the next status via buildNextStatus (delta-
  // only — only what changed: updated_at + evidence_refs pointing at the new
  // pending scene artifact), then persistCheckpointBase writes status.json.
  // If no session exists yet (scene-breakdown run before any deep-chapter
  // session started), there is no truth-source to update — the pending artifact
  // is still on disk for a later accept; we do NOT create a stub status.json
  // (that would violate HARD-1 sole truth-source identity).
  const existing = await loadNovelSessionStatus(projectPath)
  if (!existing) return
  const now = new Date().toISOString()
  const next = buildNextStatus(existing, {
    updated_at: now,
    status: existing.status,
    evidence_refs: [...existing.evidence_refs, pendingPath],
  })
  await persistCheckpointBase(projectPath, existing.session_id, next, [pendingPath])
}

/**
 * EPIC-002 / ADR-30 / Story 2.1 + ADR-08 (Draft-first): acceptSceneBreakdown
 * promotes the pending scene list to the formal layer `.novel/chapters/{n}/
 * scenes.json` (pending → ready → accept). Before accept, scenes.json does not
 * exist in the formal layer — Draft-first boundary.
 *
 * The formal write is a chapter-level product artifact (not session truth-source,
 * HARD-1). The session truth-source (status.json) is updated via the ADR-31
 * factory to record evidence_refs pointing at the formal scene path.
 */
export async function acceptSceneBreakdown(
  projectPath: string,
  chapterId: string,
): Promise<void> {
  const pendingPath = scenesPendingPath(projectPath, chapterId)
  const formalPath = scenesFormalPath(projectPath, chapterId)
  await ensureChapterScenesDir(projectPath, chapterId)

  let raw: string
  try {
    raw = await readFile(pendingPath)
  } catch {
    throw new Error(`场景拆解草稿不存在，无法 accept：${pendingPath}`)
  }
  // Re-validate the pending payload structure before promoting to formal.
  let parsed: { scenes?: unknown; partial?: unknown; partial_reason?: unknown; token_cost?: unknown; latency_ms?: unknown; chapter_id?: unknown }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    throw new Error(`场景拆解草稿 JSON 解析失败，无法 accept：${pendingPath}`)
  }
  const acceptedAt = new Date().toISOString()
  const formalPayload = {
    chapter_id: chapterId,
    scenes: Array.isArray(parsed.scenes) ? parsed.scenes : [],
    token_cost: parsed.token_cost,
    latency_ms: parsed.latency_ms,
    accepted_at: acceptedAt,
  }
  await writeFileAtomic(formalPath, JSON.stringify(formalPayload, null, 2))

  // Draft-first: once promoted, the pending draft is superseded (kept on disk
  // for audit, mirroring writeDraftArtifact's superseded artifact pattern in
  // novel-session-status.ts:624). Do NOT delete pending — audit trail.

  // ADR-31: thread the session lifecycle through the factory to record the
  // formal scene path in evidence_refs (truth-source update). No-op if no
  // session exists yet.
  const existing = await loadNovelSessionStatus(projectPath)
  if (!existing) return
  const now = new Date().toISOString()
  const next = buildNextStatus(existing, {
    updated_at: now,
    status: existing.status,
    evidence_refs: [...existing.evidence_refs, formalPath],
  })
  await persistCheckpointBase(projectPath, existing.session_id, next, [formalPath])
}

/**
 * EPIC-002 / ADR-30 / Story 2.1: scene cascade-delete. Scenes are co-located
 * under chapters/{n}/, so when a chapter is deleted its scene artifacts
 * (pending + formal) are removed together. Callers that delete a chapter
 * directory invoke this to ensure no orphaned scene files remain.
 *
 * Idempotent: missing files are not an error (already-deleted chapter, or a
 * chapter where scene-breakdown never ran).
 */
export async function deleteChapterScenes(
  projectPath: string,
  chapterId: string,
): Promise<void> {
  const pendingPath = scenesPendingPath(projectPath, chapterId)
  const formalPath = scenesFormalPath(projectPath, chapterId)
  await Promise.allSettled([
    deleteFile(pendingPath),
    deleteFile(formalPath),
  ])
}

/**
 * Combine AbortSignals — re-exported from llm-client (consolidated to avoid
 * PAT-G2 same-name duplication across deep-chapter-generation / scene-breakdown).
 * PAT-DC3 cascade + timeout: when either signal aborts, the combined aborts.
 */
export { combineAbortSignals } from "@/lib/llm-client"
