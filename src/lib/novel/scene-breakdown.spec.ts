import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StreamCallbacks } from "@/lib/llm-client"
import type { ContextPack } from "./context-engine"

/**
 * EPIC-002 / ADR-30 / TASK-011: scene-breakdown spec.
 *
 * Covers:
 * - runSceneBreakdown AbortSignal cascade (PAT-DC3): pre-aborted signal throws
 *   before streamChat is called.
 * - runSceneBreakdown partial-preserve (spec S-444k): transport-inactivity error
 *   with partial streamed content returns { scenes, partial: true, partialReason }
 *   via typed signal (return field), NOT a display callback.
 * - runSceneBreakdown catch sanitization (PAT-DC1): thrown error is generic
 *   ("scene breakdown failed" / "用户已取消生成"), no raw provider detail.
 * - persistSceneBreakdownDraft: uses buildNextStatus + persistCheckpointBase
 *   (ADR-31 factory, NOT manual `const next: Status = {...}` block); writes
 *   .novel/chapters/{n}/scenes.pending.json (Draft-first pending, ADR-08).
 * - acceptSceneBreakdown: promotes pending → formal .novel/chapters/{n}/scenes.json
 *   (Draft-first pending→ready→accept, ADR-08).
 * - deleteChapterScenes: cascade-delete co-located chapters/{n}/ scene artifacts.
 */

const llmConfig = {
  provider: "custom" as const,
  apiKey: "test-key",
  model: "test-scene-model",
  ollamaUrl: "",
  customEndpoint: "https://example.test/v1",
  maxContextSize: 120000,
  reasoning: { mode: "high" as const },
}

const contextPack: ContextPack = {
  task: "生成第3章",
  chapterGoal: "第3章目标：主角进入雨夜旧屋，发现第一条线索。",
  outline: "第3章：雨夜旧屋，发现线索，结尾留下危险钩子。",
  recentSummaries: ["第1章：主角收到匿名信。", "第2章：主角抵达旧城区。"],
  previousChapterEnding: "门缝里传来金属拖拽声。",
  characterStates: "主角谨慎，但急于确认真相。",
  soulDoc: "项目灵魂：悬疑、克制、现实压力。",
  characterAuras: "主角表达克制，不会突然热血喊口号。",
  cognitionStates: "主角不知道旧屋里有什么。",
  foreshadowingStates: "匿名信、旧屋线索未回收。",
  timeline: "雨夜，进入旧屋前后不超过一小时。",
  relatedSettings: "旧屋位于城东老巷尽头。",
  canonRules: "不能提前揭露幕后真凶身份。",
  writingStyle: "短句、悬疑、画面感。",
  searchResults: "相关记忆：匿名信来自第1章。",
  graphSearchResults: "匿名信 -> 旧屋 -> 金属拖拽声。",
  mustDo: "必须承接门缝金属拖拽声并推进线索。",
  mustAvoid: "不能让主角凭空知道屋内情况。",
  nextChapterAdvice: "下一章继续追查旧屋线索。",
  revisionDirectives: "上一轮反馈：避免重复解释。",
} satisfies ContextPack

const mocks = vi.hoisted(() => ({
  streamChatMock: vi.fn(),
  readFile: vi.fn(async (_path: string): Promise<string> => ""),
  writeFileAtomic: vi.fn(async (_path: string, _contents: string): Promise<void> => {}),
  createDirectory: vi.fn(async (_path: string): Promise<void> => {}),
  deleteFile: vi.fn(async (_path: string): Promise<void> => {}),
  // loadNovelSessionStatus returns Promise<NovelSessionStatus | null> — typed
  // loosely (any) so mockResolvedValue({...}) accepts a full status object
  // without TS narrowing the return to `null`.
  loadStatus: vi.fn(async (_projectPath: string): Promise<unknown> => null),
  // persistCheckpointBase signature: (projectPath, sessionId, next, evidenceEntries?)
  persistCheckpoint: vi.fn(async (
    _projectPath: string,
    _sessionId: string,
    _next: unknown,
    _evidence?: string[],
  ): Promise<void> => {}),
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: mocks.streamChatMock,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => ({
      llmConfig,
      novelConfig: { reviewReasoningEffort: "high" },
    }),
  },
}))

vi.mock("@/lib/has-usable-llm", () => ({
  hasUsableLlm: () => true,
}))

vi.mock("./model-resolver", () => ({
  resolveNovelModel: (config: typeof llmConfig) => config,
}))

// fs mocks — scene-breakdown + novel-session-status import chain both reach
// writeFileAtomic/createDirectory/readFile/deleteFile (Tauri invoke).
vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFileAtomic: mocks.writeFileAtomic,
  createDirectory: mocks.createDirectory,
  deleteFile: mocks.deleteFile,
}))

// ADR-31 factory persistence: mock loadNovelSessionStatus + persistCheckpointBase
// to assert factory invocation without hitting Tauri fs. buildNextStatus is a
// pure function — keep the real implementation so delta-only construction works.
vi.mock("./novel-session-status", async () => {
  const actual = await vi.importActual<typeof import("./novel-session-status")>("./novel-session-status")
  return {
    ...actual,
    loadNovelSessionStatus: mocks.loadStatus,
    persistCheckpointBase: mocks.persistCheckpoint,
  }
})

import {
  runSceneBreakdown,
  persistSceneBreakdownDraft,
  acceptSceneBreakdown,
  deleteChapterScenes,
  type Scene,
  type SceneBreakdownResult,
} from "./scene-breakdown"

const streamChatMock = mocks.streamChatMock

/** Construct a well-formed Scene[] JSON string the LLM would emit. */
function sceneArrayJson(scenes: Scene[]): string {
  return JSON.stringify(scenes)
}

function makeScene(id: string, title: string): Scene {
  return {
    sceneId: id,
    sceneTitle: title,
    location: "雨夜旧屋",
    characters: ["主角"],
    goal: "发现线索",
    tension: "门后未知威胁",
    beat: "推进-悬念",
  }
}

function streamTokens(stream: string, callbacks: StreamCallbacks): void {
  // Emit the whole content as one token (tests don't need chunked streaming).
  callbacks.onToken?.(stream)
  callbacks.onDone?.()
}

beforeEach(() => {
  streamChatMock.mockReset()
  mocks.readFile.mockReset()
  mocks.writeFileAtomic.mockReset()
  mocks.createDirectory.mockReset()
  mocks.deleteFile.mockReset()
  mocks.loadStatus.mockReset()
  mocks.persistCheckpoint.mockReset()
  mocks.readFile.mockResolvedValue("")
  mocks.loadStatus.mockResolvedValue(null)
  mocks.writeFileAtomic.mockResolvedValue(undefined)
  mocks.createDirectory.mockResolvedValue(undefined)
  mocks.deleteFile.mockResolvedValue(undefined)
  mocks.persistCheckpoint.mockResolvedValue(undefined)
})

describe("EPIC-002 / ADR-30 / TASK-011: runSceneBreakdown", () => {
  it("parses a well-formed scene array from the LLM stream", async () => {
    const scenes = [makeScene("scene-1", "旧屋门口"), makeScene("scene-2", "屋内搜索")]
    streamChatMock.mockImplementation(async (_c: unknown, _m: unknown, callbacks: StreamCallbacks) => {
      streamTokens(sceneArrayJson(scenes), callbacks)
    })

    const result = await runSceneBreakdown("章节蓝图：主角抵达旧屋。", contextPack)

    expect(result.scenes).toHaveLength(2)
    expect(result.scenes[0].sceneId).toBe("scene-1")
    expect(result.scenes[0].characters).toEqual(["主角"])
    expect(result.partial).toBeFalsy()
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("tolerates a ```json markdown fence wrapper", async () => {
    const scenes = [makeScene("scene-1", "旧屋门口")]
    const wrapped = "```json\n" + sceneArrayJson(scenes) + "\n```"
    streamChatMock.mockImplementation(async (_c: unknown, _m: unknown, callbacks: StreamCallbacks) => {
      streamTokens(wrapped, callbacks)
    })

    const result = await runSceneBreakdown("蓝图", contextPack)
    expect(result.scenes).toHaveLength(1)
    expect(result.scenes[0].sceneTitle).toBe("旧屋门口")
  })

  it("returns empty scenes for a non-JSON / empty LLM response (graceful degradation)", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, _m: unknown, callbacks: StreamCallbacks) => {
      streamTokens("抱歉，我无法拆解。", callbacks)
    })

    const result = await runSceneBreakdown("蓝图", contextPack)
    expect(result.scenes).toEqual([])
    expect(result.partial).toBeFalsy()
  })

  it("PAT-DC3: a pre-aborted signal throws before calling streamChat", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      runSceneBreakdown("蓝图", contextPack, controller.signal),
    ).rejects.toThrow(/用户已取消生成/)

    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("PAT-DC3: signal is cascaded to streamChat (4th positional arg)", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, _m: unknown, callbacks: StreamCallbacks) => {
      streamTokens(sceneArrayJson([makeScene("scene-1", "t")]), callbacks)
    })
    const controller = new AbortController()

    await runSceneBreakdown("蓝图", contextPack, controller.signal)

    const callArgs = streamChatMock.mock.calls[0]
    // [config, messages, callbacks, signal, requestOverrides]
    const passedSignal = callArgs?.[3]
    expect(passedSignal).toBeTruthy()
    expect(typeof (passedSignal as AbortSignal)?.addEventListener).toBe("function")
  })

  it("PAT-DC1: a streamChat rejection is rethrown as a generic 'scene breakdown failed' (no provider detail)", async () => {
    streamChatMock.mockRejectedValue(new Error("HTTP 401 at https://api.provider.com/v1: invalid key sk-leaked-xxxx"))

    await expect(runSceneBreakdown("蓝图", contextPack)).rejects.toThrow(/scene breakdown failed/)

    // Ensure the raw provider URL / key never leaks through the thrown message.
    await expect(runSceneBreakdown("蓝图", contextPack)).rejects.toThrow()
    try {
      await runSceneBreakdown("蓝图", contextPack)
      throw new Error("should have thrown")
    } catch (error) {
      const message = (error as Error).message
      expect(message).not.toMatch(/sk-leaked|api\.provider\.com/)
      expect(message).toMatch(/scene breakdown failed/)
    }
  })

  it("S-444k: transport-inactivity error with partial streamed content returns partial typed signal", async () => {
    // Stream partial valid JSON arrays (1 scene) then throw transport-inactivity.
    const partialScenes = [makeScene("scene-1", "旧屋门口")]
    const partialJson = sceneArrayJson(partialScenes)
    streamChatMock.mockImplementation(async (_c: unknown, _m: unknown, callbacks: StreamCallbacks) => {
      callbacks.onToken?.(partialJson)
      // onError captures the error (streamChat does not throw on onError path)
      callbacks.onError?.(new Error("produced no additional stream output within 60 seconds"))
      callbacks.onDone?.()
    })

    const result = await runSceneBreakdown("蓝图", contextPack)

    expect(result.scenes).toHaveLength(1)
    expect(result.partial).toBe(true)
    expect(result.partialReason).toMatch(/produced no additional stream output/)
  })

  it("S-444k: transport-inactivity with NO partial content throws (no false-partial)", async () => {
    // No tokens streamed; onError fires with transport-inactivity.
    streamChatMock.mockImplementation(async (_c: unknown, _m: unknown, callbacks: StreamCallbacks) => {
      callbacks.onError?.(new Error("produced no meaningful stream output within 60 seconds"))
      callbacks.onDone?.()
    })

    await expect(runSceneBreakdown("蓝图", contextPack)).rejects.toThrow(/scene breakdown failed/)
  })

  it("PAT-DC1: a non-transport-inactivity stream error (auth) throws generic, not partial", async () => {
    streamChatMock.mockImplementation(async (_c: unknown, _m: unknown, callbacks: StreamCallbacks) => {
      callbacks.onToken?.(sceneArrayJson([makeScene("scene-1", "t")]))
      callbacks.onError?.(new Error("HTTP 401 Unauthorized: invalid api key"))
      callbacks.onDone?.()
    })

    await expect(runSceneBreakdown("蓝图", contextPack)).rejects.toThrow(/scene breakdown failed/)
  })
})

describe("EPIC-002 / ADR-31: persistSceneBreakdownDraft (Draft-first pending + factory)", () => {
  it("writes .novel/chapters/{n}/scenes.pending.json (Draft-first pending, ADR-08)", async () => {
    const result: SceneBreakdownResult = {
      scenes: [makeScene("scene-1", "旧屋门口")],
      partial: false,
      tokenCost: 1234,
      latencyMs: 5678,
    }

    await persistSceneBreakdownDraft("/P", "3", result)

    const writeCall = mocks.writeFileAtomic.mock.calls.find((c) =>
      String(c[0]).endsWith(".novel/chapters/3/scenes.pending.json"),
    )
    expect(writeCall).toBeTruthy()
    const payload = JSON.parse(writeCall![1] as string)
    expect(payload.scenes).toHaveLength(1)
    expect(payload.partial).toBe(false)
    expect(payload.token_cost).toBe(1234)
    expect(payload.latency_ms).toBe(5678)
  })

  it("ADR-31: no manual `const next: Status = {...}` block — uses buildNextStatus + persistCheckpointBase factory", async () => {
    // Existing session present → factory path activates.
    mocks.loadStatus.mockResolvedValue({
      session_id: "sess-1",
      schema_version: "1",
      source: "deep_chapter_generation",
      created_at: "2026-07-10T00:00:00.000Z",
      updated_at: "2026-07-10T00:00:00.000Z",
      status: "running",
      active_step_index: 0,
      current_task: { task_id: "t1", conversation_id: "conv-1", user_request: "r", checkpoint_stage: "started", status: "running" },
      draft: { draft_id: "conv-1", file_path: "/P/.novel/drafts/conv-1.json", draft_status: "pending", updated_at: "2026-07-10T00:00:00.000Z" },
      decision_gates: {},
      evidence_refs: [],
    })

    const result: SceneBreakdownResult = { scenes: [makeScene("scene-1", "t")] }
    await persistSceneBreakdownDraft("/P", "3", result)

    // persistCheckpointBase (mocked) must be called — proving the factory path
    // was taken, NOT a manual status.json write. Signature:
    //   persistCheckpointBase(projectPath, sessionId, next, evidenceEntries?)
    expect(mocks.persistCheckpoint).toHaveBeenCalledTimes(1)
    const [projectPath, sessionId, nextStatus, evidenceEntries] = mocks.persistCheckpoint.mock.calls[0] as [
      string,
      string,
      { session_id: string },
      string[] | undefined,
    ]
    expect(projectPath).toBe("/P")
    expect(sessionId).toBe("sess-1")
    expect(nextStatus.session_id).toBe("sess-1")
    // evidence_refs extended with the pending scene path (factory delta). The
    // 4th arg is an array of evidence entries; check membership via some().
    const evidence = (evidenceEntries as string[]) ?? []
    expect(
      evidence.some((p) => /\.novel\/chapters\/3\/scenes\.pending\.json$/.test(p)),
    ).toBe(true)
  })

  it("HARD-1: when no session exists, does NOT create a stub status.json (no-op on truth-source)", async () => {
    mocks.loadStatus.mockResolvedValue(null)
    const result: SceneBreakdownResult = { scenes: [makeScene("scene-1", "t")] }

    await persistSceneBreakdownDraft("/P", "3", result)

    // The pending artifact is still written (chapter-level product), but the
    // session truth-source is NOT fabricated.
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      expect.stringMatching(/scenes\.pending\.json$/),
      expect.any(String),
    )
    expect(mocks.persistCheckpoint).not.toHaveBeenCalled()
  })
})

describe("EPIC-002 / ADR-08: acceptSceneBreakdown (pending → ready → accept formal)", () => {
  it("promotes pending scenes to .novel/chapters/{n}/scenes.json (formal layer)", async () => {
    const pendingPayload = {
      chapter_id: "3",
      scenes: [makeScene("scene-1", "旧屋门口")],
      token_cost: 100,
      latency_ms: 200,
    }
    mocks.readFile.mockResolvedValue(JSON.stringify(pendingPayload))

    await acceptSceneBreakdown("/P", "3")

    const formalWrite = mocks.writeFileAtomic.mock.calls.find((c) =>
      String(c[0]).endsWith(".novel/chapters/3/scenes.json"),
    )
    expect(formalWrite).toBeTruthy()
    const formal = JSON.parse(formalWrite![1] as string)
    expect(formal.scenes).toHaveLength(1)
    expect(formal.accepted_at).toBeTruthy()
    expect(formal.token_cost).toBe(100)
  })

  it("Draft-first: throws when pending draft does not exist (cannot promote)", async () => {
    mocks.readFile.mockRejectedValue(new Error("ENOENT"))

    await expect(acceptSceneBreakdown("/P", "3")).rejects.toThrow(/场景拆解草稿不存在/)
  })

  it("Draft-first: throws on corrupt pending JSON (cannot promote)", async () => {
    mocks.readFile.mockResolvedValue("{not valid json")

    await expect(acceptSceneBreakdown("/P", "3")).rejects.toThrow(/JSON 解析失败/)
  })
})

describe("EPIC-002 / ADR-30: deleteChapterScenes (cascade-delete co-located)", () => {
  it("deletes both pending and formal scene artifacts under chapters/{n}/", async () => {
    await deleteChapterScenes("/P", "3")

    const deletedPaths = mocks.deleteFile.mock.calls.map((c) => String(c[0]))
    expect(deletedPaths.some((p) => /\.novel\/chapters\/3\/scenes\.pending\.json$/.test(p))).toBe(true)
    expect(deletedPaths.some((p) => /\.novel\/chapters\/3\/scenes\.json$/.test(p))).toBe(true)
  })

  it("is idempotent — missing files are swallowed (Promise.allSettled)", async () => {
    mocks.deleteFile.mockRejectedValue(new Error("ENOENT"))
    // Should not throw.
    await expect(deleteChapterScenes("/P", "3")).resolves.toBeUndefined()
  })
})
