/**
 * chapter-ingest 拆分 W5：LLM 抽取、JSON 解析与快照历史恢复/删除。
 *
 * 本模块承载两簇：
 *   1. 模型输出解析与抽取（`extractFirstBalancedJsonObject` /
 *      `extractJsonObjectFromModelText` / `normalizeOutlineIngestError` /
 *      `extractSnapshotWithLLM`）—— **只搬不改**：重试策略、prompt 文本、
 *      超时组合方式、解析语义一律未动；
 *   2. 快照历史恢复与删除（`restoreSnapshotHistory` / `deleteChapterSnapshots`）——
 *      它们依赖 rebuild(W3) 与 drift 自愈(W4)，必须等 W3/W4 落地后才能搬出，
 *      故收口于本波次。
 */
import { deleteFile, fileExists, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { logger, toErrorMessage } from "@/lib/utils"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { getOutputLanguage, buildLanguageReminder } from "@/lib/output-language"
import {
  combineAbortSignals,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  streamChat,
  type StreamCallbacks,
} from "@/lib/llm-client"
import { clearGraphCache } from "@/lib/graph-relevance"
import type { ChatMessage } from "@/lib/llm-providers"
import { writeSnapshotToWiki } from "./graph-adapter"
import { normalizeChapterSnapshot } from "./chapter-snapshot-normalize"
import { sliceChapterForReview } from "./chapter-window"
import { clearTemporalFactsCache } from "./context-engine"
import {
  snapshotHistoryDir,
  snapshotJsonPath,
  snapshotMarkdownPath,
} from "./snapshot-paths"
import {
  backupSnapshotBeforeOverwrite,
  cleanupDeletedChapterResidualEntities,
  saveSnapshot,
} from "./chapter-ingest-snapshot-io"
import {
  materializeRestoredCurrentSnapshot,
  readCurrentSnapshot,
} from "./chapter-ingest-history"
import {
  cleanupSupersededEntityFiles,
  rebuildDerivedMemoryFromSnapshots,
} from "./chapter-ingest-fold-registry"
import { autoRepairTruthFoldDrift } from "./chapter-ingest-drift"
import type { ChapterSnapshot } from "./chapter-ingest"

// ── extractFirstBalancedJsonObject ──
export function extractFirstBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{")
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\") {
      escape = true
      continue
    }
    if (ch === "\"") {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") {
      depth += 1
      continue
    }
    if (ch === "}") {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return null
}

// ── extractJsonObjectFromModelText ──
export function extractJsonObjectFromModelText(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  return extractFirstBalancedJsonObject(fenced ?? text)
}

// ── normalizeOutlineIngestError ──
export function normalizeOutlineIngestError(err: unknown): Error {
  const message = toErrorMessage(err)
  if (/request cancelled|aborted|cancelled/i.test(message)) {
    return new Error("大纲摄取已中断，请稍后重试")
  }
  // ISS-026 (PAT-IM3): a malformed/truncated model outline output throws a
  // bare SyntaxError from JSON.parse (@1975) that, after this normalizer only
  // regex-matches abort, passes through as a raw parser message to outline
  // consumers. Surface a friendly "invalid JSON" message so a model that
  // emitted code-fenced/leaking/truncated JSON is distinguishable from a
  // transport failure (which carries no "Unexpected token" signature).
  if (err instanceof SyntaxError) {
    return new Error("大纲摄取失败：模型返回了无法解析的 JSON，请重试或调整提示")
  }
  return new Error(message)
}

// ── extractSnapshotWithLLM ──
export async function extractSnapshotWithLLM(
  chapterNumber: number,
  chapterBody: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<ChapterSnapshot | null> {
  const outputLang = getOutputLanguage()
  const langReminder = buildLanguageReminder(outputLang)

  const systemPrompt = `你是一个专业的小说编辑助手。你的任务是从给定的章节正文中提取结构化信息。
请严格按照 JSON 格式输出，不要输出任何其他内容。
${langReminder}`

  const userPrompt = `请从以下章节中提取结构化信息，输出 JSON：

章节编号：第${chapterNumber}章

章节正文：
${sliceChapterForReview(chapterBody)}

请输出以下格式的 JSON：
{
  "chapterId": "chapter-${chapterNumber}",
  "chapterNumber": ${chapterNumber},
  "summary": "章节摘要（200字以内）",
  "characters": ["出场人物列表"],
  "characterAliases": { "人物正式名": ["昵称", "小名", "旧名"] },
  "locations": ["出场地点列表"],
  "organizations": ["出场组织列表"],
  "items": ["出场物品列表"],
  "events": ["关键事件列表"],
  "characterStateChanges": ["人物状态变化描述"],
  "relationshipChanges": ["人物关系变化描述"],
  "knowledgeChanges": ["角色认知变化描述"],
  "foreshadowingChanges": ["伏笔变化描述（新增/推进/回收）"],
  "newCanonFacts": ["新增正史设定"],
  "beliefFacts": [{"subject": "认知主体（角色名）", "predicate": "认知谓词（认为/怀疑/以为…）", "object": "角色所信的事实内容"}],
  "hypothesisFacts": [{"subject": "假设主体", "predicate": "假设谓词（假设/猜测/推测…）", "object": "假设内容"}],
  "timelineEvents": ["时间线事件"],
  "conflicts": ["冲突变化描述"],
  "endingHook": "章节结尾钩子描述",
  "graphNodes": ["图谱节点列表"],
  "graphEdges": ["图谱关系边列表，格式：A->关系->B。关系必须是以下之一：出场于|发生于|属于|持有|敌对|合作|怀疑|隐瞒|知道|不知道|推进伏笔|回收伏笔|新增伏笔|导致|揭示|影响|位于"],
  "characterDetails": {
    "人物名": {
      "identity": "身份（具体身份描述）",
      "faction": "阵营（所属势力或立场）",
      "goals": "目标（当前章节中的目标）",
      "arcChange": "弧光变化（本章中该人物的成长或变化）"
    }
  },
  "locationDetails": {
    "地点名": {
      "region": "区域（所属地理区域）",
      "type": "类型（场景类型，如宫殿、森林、密室等）",
      "controller": "控制者（当前控制该地点的势力或人物）",
      "hiddenInfo": "隐藏信息（地点中的秘密或未揭示的设定）"
    }
  },
  "organizationDetails": {
    "组织名": {
      "leader": "领导者",
      "members": "成员（本章出现或提及的成员）",
      "goals": "目标（组织当前的目标）",
      "resources": "资源（组织掌控的资源）"
    }
  },
  "itemDetails": {
    "物品名": {
      "holder": "当前持有者",
      "previousHolders": "前持有者",
      "abilities": "能力（物品的功能或能力）",
      "limitations": "限制（使用限制或副作用）",
      "origin": "来源（物品的来历）"
    }
  },
  "eventDetails": {
    "事件名": {
      "cause": "起因（事件的触发原因）",
      "process": "过程（事件的发展过程）",
      "relatedForeshadowing": "关联伏笔（与此事件相关的伏笔）",
      "relatedConflicts": "关联冲突（与此事件相关的冲突）",
      "followUpItems": "后续事项（事件引发的后续影响或待处理事项）"
    }
  }
}

模态判定规则（限句式触发，避免误标）：
- 仅当原文出现「X认为/怀疑/以为/相信/觉得」等认知动词时，才提取为 beliefFacts；
- 仅当原文出现「假设/猜测/推测/猜想」等假设动词时，才提取为 hypothesisFacts；
- 其余事实一律进 newCanonFacts（正史），绝不让角色认知污染正史事实。

注意：如果同一个人物在正文里有昵称、小名、旧名或全名，请把正式名放进 characters，把其他称呼放进 characterAliases，不要把同一人物拆成多个 characters。
注意：characterDetails、locationDetails、organizationDetails、itemDetails、eventDetails 仅在章节中确实有相关信息时才填写；如果某个字段没有相关信息，直接省略该字段即可。`

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]
    const snapshotSchema = {
      type: "object",
      properties: {
        chapterId: { type: "string" },
        chapterNumber: { type: "number" },
        summary: { type: "string" },
        characters: { type: "array", items: { type: "string" } },
        characterAliases: {
          type: "object",
          additionalProperties: {
            type: "array",
            items: { type: "string" },
          },
        },
        locations: { type: "array", items: { type: "string" } },
        organizations: { type: "array", items: { type: "string" } },
        items: { type: "array", items: { type: "string" } },
        events: { type: "array", items: { type: "string" } },
        characterStateChanges: { type: "array", items: { type: "string" } },
        relationshipChanges: { type: "array", items: { type: "string" } },
        knowledgeChanges: { type: "array", items: { type: "string" } },
        foreshadowingChanges: { type: "array", items: { type: "string" } },
        newCanonFacts: { type: "array", items: { type: "string" } },
        beliefFacts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              subject: { type: "string" },
              predicate: { type: "string" },
              object: { type: "string" },
            },
            required: ["subject", "predicate", "object"],
          },
        },
        hypothesisFacts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              subject: { type: "string" },
              predicate: { type: "string" },
              object: { type: "string" },
            },
            required: ["subject", "predicate", "object"],
          },
        },
        timelineEvents: { type: "array", items: { type: "string" } },
        conflicts: { type: "array", items: { type: "string" } },
        endingHook: { type: "string" },
        graphNodes: { type: "array", items: { type: "string" } },
        graphEdges: { type: "array", items: { type: "string" } },
      },
      required: [
        "chapterId",
        "chapterNumber",
        "summary",
        "characters",
        "characterAliases",
        "locations",
        "organizations",
        "items",
        "events",
        "characterStateChanges",
        "relationshipChanges",
        "knowledgeChanges",
        "foreshadowingChanges",
        "newCanonFacts",
        "timelineEvents",
        "conflicts",
        "endingHook",
        "graphNodes",
        "graphEdges",
      ],
    } satisfies Record<string, unknown>

    let result = ""
    let streamError: Error | null = null
    const callbacks: StreamCallbacks = {
      onToken: (token: string) => {
        result += token
      },
      onDone: () => {},
      onError: (error: Error) => {
        streamError = error
      },
    }

    await streamChat(llmConfig, messages, callbacks, combineAbortSignals(signal, AbortSignal.timeout(DEFAULT_LLM_REQUEST_TIMEOUT_MS)), {
      jsonSchema: snapshotSchema,
    })
    if (streamError) throw streamError

    const jsonText = extractJsonObjectFromModelText(result)
    if (!jsonText) {
      // ISS-20260712-001 (PAT-G2 twin recurrence #10, sibling of ISS-026 @841):
      // LLM returned no parseable JSON object at all (empty / prose-only /
      // truncated before any `{...}`). Previously threw, which violated the
      // Promise<ChapterSnapshot | null> contract and bypassed the caller's
      // (ingestChapter @400 → :403) friendly `failReason: "extract_failed"`
      // degrade — the user saw the raw technical error instead of the i18n
      // UX. Return null here honors the contract (same as the JSON.parse
      // SyntaxError path @845) and lets ingestChapter route to the friendly
      // UX. Spec S-20260711-6ed4.
      logger.error("Chapter Ingest", "extractSnapshotWithLLM: model returned no parseable JSON object")
      return null
    }

    // ISS-026 (PAT-IM3): a malformed/truncated/code-fence-leaking model output
    // throws a bare SyntaxError here that escapes ingestChapter (no try-catch
    // at the call site @400), bypassing the friendly failReason:"extract_failed"
    // branch (@403-404) — which only covers the narrow "valid but non-object
    // JSON" path via normalizeChapterSnapshot returning null. Wrap the parse so
    // a SyntaxError (the common case) returns null, honoring the
    // Promise<ChapterSnapshot | null> contract and letting ingestChapter route
    // to the friendly UX. A non-SyntaxError (transport/stream failure) is
    // re-thrown unchanged so abort/timeout paths stay distinct.
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch (error) {
      /* v8 ignore next */
      if (error instanceof SyntaxError) {
        logger.error("Chapter Ingest", "Malformed snapshot JSON", { error: error.message })
        return null
      }
      /* v8 ignore start */
      throw error
      /* v8 ignore stop */
    }
    const record = (parsed ?? {}) as Record<string, unknown>
    return normalizeChapterSnapshot({
      ...record,
      chapterId: `chapter-${chapterNumber}`,
      chapterNumber,
      entityIsNew: {},
      validationWarnings: [],
      characterDetails: record.characterDetails || undefined,
      locationDetails: record.locationDetails || undefined,
      organizationDetails: record.organizationDetails || undefined,
      itemDetails: record.itemDetails || undefined,
      eventDetails: record.eventDetails || undefined,
    }, { chapterId: `chapter-${chapterNumber}`, chapterNumber })
  } catch (err) {
    logger.error("Chapter Ingest", "Failed to extract snapshot", { error: toErrorMessage(err) })
    throw err
  }
}

// ── restoreSnapshotHistory ──
export async function restoreSnapshotHistory(
  projectPath: string,
  chapterNumber: number,
  historyFileName: string,
  onDataVersionBump?: () => void,
): Promise<ChapterSnapshot> {
  const pp = normalizePath(projectPath)
  const currentSnapshot = await readCurrentSnapshot(pp, chapterNumber)
  await backupSnapshotBeforeOverwrite(pp, chapterNumber)
  // SEC-003: historyFileName is user-supplied (e.g. from the UI snapshot-history
  // picker). Reject path traversal: no separators, no parent-dir, must be a
  // bare `*.snapshot.json` filename so `${dir}/${historyFileName}` cannot
  // escape the chapter's snapshot-history directory.
  const safeName = (historyFileName ?? "").trim()
  if (!safeName || /[\/\\]/.test(safeName) || safeName.includes("..") || !safeName.endsWith(".snapshot.json")) {
    throw new Error("Invalid snapshot history file name.")
  }
  const historyPath = `${snapshotHistoryDir(pp, chapterNumber)}/${safeName}`
  const snapshot = normalizeChapterSnapshot(
    JSON.parse(await readFile(historyPath)),
    { chapterId: `chapter-${chapterNumber}`, chapterNumber },
  )
  if (!snapshot) {
    throw new Error("Invalid snapshot history file.")
  }
  const restoredCurrent = materializeRestoredCurrentSnapshot(snapshot, currentSnapshot)
  await saveSnapshot(pp, restoredCurrent)
  const writtenEntityPaths = await writeSnapshotToWiki(pp, restoredCurrent)
  await cleanupSupersededEntityFiles(pp, restoredCurrent, writtenEntityPaths)
  await rebuildDerivedMemoryFromSnapshots(pp, restoredCurrent)
  // P2-IMP-15：restore 后 drift>0 → 自动经注册表 rebuild 漂移类 → 复测仍>0 才
  // 告警升级（IMP-06 通道）；drift=0 零动作（误报护栏）。
  await autoRepairTruthFoldDrift(pp, { trigger: "restore" })
  // ARCH-006 (REG-001 sibling): restoring a history snapshot replaces the
  // current snapshot content, so the mtime-keyed temporalFactsCache may hold
  // pre-restore facts — clear it for this project (same root cause as the
  // delete path fixed in REG-001; restore was missed).
  clearTemporalFactsCache(pp)
  clearGraphCache()
  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入 callback 优先, 缺省回退 store。
  const bump = onDataVersionBump ?? (() => useWikiStore.getState().bumpDataVersion())
  bump()
  return restoredCurrent
}

// ── deleteChapterSnapshots ──
export async function deleteChapterSnapshots(projectPath: string, chapterNumber: number, onDataVersionBump?: () => void): Promise<void> {
  const pp = normalizePath(projectPath)
  const jsonPath = snapshotJsonPath(pp, chapterNumber)
  const mdPath = snapshotMarkdownPath(pp, chapterNumber)
  const historyDir = snapshotHistoryDir(pp, chapterNumber)
  // ISS-20260712-REL-1: 空 catch 收敛 — 记诊断（warn + 脱敏 message），控制流不变
  // （删除失败不阻断 rebuild；缺文件仍视为已删）。
  try { if (await fileExists(jsonPath)) await deleteFile(jsonPath) } catch (err) { logger.warn("Chapter Ingest", "delete snapshot json failed (non-fatal)", { path: jsonPath, error: toErrorMessage(err) }) }
  try { if (await fileExists(mdPath)) await deleteFile(mdPath) } catch (err) { logger.warn("Chapter Ingest", "delete snapshot md failed (non-fatal)", { path: mdPath, error: toErrorMessage(err) }) }
  try { if (await fileExists(historyDir)) await deleteFile(historyDir) } catch (err) { logger.warn("Chapter Ingest", "delete snapshot history failed (non-fatal)", { path: historyDir, error: toErrorMessage(err) }) }
  await rebuildDerivedMemoryFromSnapshots(pp)
  // ISS-20260712-MAINT-4: truth store 残留修 — rebuild 仅重放剩余快照，已删章节的
  // 孤儿实体（其 snapshot token 全属于被删章节候选）在此兜底清扫。exact 匹配
  // 口径（isOnlyCurrentChapterSource），混引永不删；失败记 warn 不阻断。
  await cleanupDeletedChapterResidualEntities(pp, chapterNumber)
  // P2-IMP-15：delete 后 drift>0 → 自动经注册表 rebuild 漂移类 → 复测仍>0 才告警升级。
  await autoRepairTruthFoldDrift(pp, { trigger: "delete" })
  clearGraphCache()
  clearTemporalFactsCache(pp)
  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入 callback 优先, 缺省回退 store。
  const bump = onDataVersionBump ?? (() => useWikiStore.getState().bumpDataVersion())
  bump()
}
