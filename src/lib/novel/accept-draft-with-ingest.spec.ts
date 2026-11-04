// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * accept-draft-with-ingest.spec — 采纳+记忆回填组合四分支 + accept 失败用例。
 *
 * 不触发真实 fs / LLM：ingestChapter 整体 mock。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"

const ingestChapter = vi.fn()

vi.mock("./chapter-ingest", () => ({
  ingestChapter: (...args: unknown[]) => ingestChapter(...args),
}))

const { acceptDraftAndIngest, buildIngestActivity } = await import("./accept-draft-with-ingest")

const llmConfig = { provider: "openai", apiKey: "k", model: "m", baseUrl: "" } as unknown as LlmConfig

function novelConfig(overrides: Partial<NovelConfig> = {}): NovelConfig {
  return { ...useWikiStore.getState().novelConfig, autoIngestOnSave: true, ...overrides }
}

beforeEach(() => {
  ingestChapter.mockReset()
  // resolveNovelModel 的 store 兜底置空 → 回落到传入 llmConfig
  useWikiStore.setState({ providerConfigs: {}, defaultLlmModel: "", aiChatModel: "" })
})

describe("acceptDraftAndIngest", () => {
  it("ok：先 accept（收到 formalChapterPath）再摄取，返回 ingest=ok", async () => {
    ingestChapter.mockResolvedValue({ snapshot: { id: "s1" }, selfHeal: { attempted: false, healed: [] } })
    const accept = vi.fn(async () => {})

    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      accept,
      novelConfig: novelConfig(),
      llmConfig,
    })

    expect(accept).toHaveBeenCalledTimes(1)
    expect(accept).toHaveBeenCalledWith("/proj/wiki/chapters/第3章.md")
    expect(ingestChapter).toHaveBeenCalledTimes(1)
    expect(out.ingest).toBe("ok")
    expect(out.selfHeal).toEqual({ attempted: false, healed: [] })
  })

  it("skipped-config：autoIngestOnSave 关闭时不摄取", async () => {
    const accept = vi.fn(async () => {})
    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      accept,
      novelConfig: novelConfig({ autoIngestOnSave: false }),
      llmConfig,
    })
    expect(out.ingest).toBe("skipped-config")
    expect(ingestChapter).not.toHaveBeenCalled()
  })

  it("skipped-no-model：提取模型不可用时不摄取", async () => {
    const accept = vi.fn(async () => {})
    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      accept,
      novelConfig: novelConfig(),
      llmConfig: { ...llmConfig, apiKey: "" } as LlmConfig,
    })
    expect(out.ingest).toBe("skipped-no-model")
    expect(ingestChapter).not.toHaveBeenCalled()
  })

  it("failed：摄取无 snapshot 时带 failReason", async () => {
    ingestChapter.mockResolvedValue({ snapshot: null, failReason: "not_final" })
    const accept = vi.fn(async () => {})
    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      accept,
      novelConfig: novelConfig(),
      llmConfig,
    })
    expect(out.ingest).toBe("failed")
    expect(out.failReason).toBe("not_final")
  })

  it("accept 抛错：错误上抛且绝不摄取（采纳失败不得降级成摄取失败）", async () => {
    const accept = vi.fn(async () => {
      throw new Error("写盘失败")
    })
    await expect(
      acceptDraftAndIngest({
        projectPath: "/proj",
        formalChapterPath: "/proj/wiki/chapters/第3章.md",
        accept,
        novelConfig: novelConfig(),
        llmConfig,
      }),
    ).rejects.toThrow("写盘失败")
    expect(ingestChapter).not.toHaveBeenCalled()
  })
})

describe("buildIngestActivity（RV-002 ② 记忆回填进 activities 通道）", () => {
  it("ok → extract_result，标题与状态文案走 i18n（不硬编码中文）", () => {
    const event = buildIngestActivity(
      { formalChapterPath: "/proj/wiki/chapters/第3章.md", ingest: "ok" },
      1000,
    )
    expect(event.id).toBe("memory_ingest:1000")
    expect(event.stageId).toBe("memory_ingest")
    expect(event.kind).toBe("extract_result")
    expect(event.timestamp).toBe(1000)
    expect(event.title.length).toBeGreaterThan(0)
    expect(event.content).toContain("/proj/wiki/chapters/第3章.md")
  })

  it("failed → error 类别，携带失败原因", () => {
    const event = buildIngestActivity(
      { formalChapterPath: "/p/ch.md", ingest: "failed", failReason: "not_final" },
      2000,
    )
    expect(event.kind).toBe("error")
    expect(event.content).toContain("not_final")
  })

  it("两种 skip 是说明而非错误", () => {
    expect(buildIngestActivity({ formalChapterPath: "/p/ch.md", ingest: "skipped-config" }).kind).toBe("analysis")
    expect(buildIngestActivity({ formalChapterPath: "/p/ch.md", ingest: "skipped-no-model" }).kind).toBe("analysis")
  })
})
