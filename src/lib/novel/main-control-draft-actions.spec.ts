// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * main-control-draft-actions.spec — F3 ① ②：主控采纳路径的 accept seam 就是
 * `acceptChapterDraft`（与 ChapterDraftDock 同一实现），且未确认时不写正式正文。
 *
 * 断言策略：
 * - 生产默认（不注入 deps）必须命中 `draft-manager.acceptChapterDraft` 的 mock →
 *   证明 seam 不是「另一份采纳逻辑」，而是同一实现的适配器；
 * - `confirmed` 原样透传，不在 seam 里硬编码 true → 未确认时由 draft-manager 抛错，
 *   写盘 deps 一次都不被调用。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"

const acceptChapterDraft = vi.fn()

vi.mock("./draft-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./draft-manager")>()
  return { ...actual, acceptChapterDraft }
})

const actualDraftManager = await vi.importActual<typeof import("./draft-manager")>("./draft-manager")
const { adoptMainControlDraft, createMainControlAcceptSeam, resolveMainControlDraftTarget } = await import(
  "./main-control-draft-actions"
)

const llmConfig = { provider: "openai", apiKey: "k", model: "m", baseUrl: "" } as unknown as LlmConfig

function novelConfig(overrides: Partial<NovelConfig> = {}): NovelConfig {
  return { ...useWikiStore.getState().novelConfig, autoIngestOnSave: false, ...overrides }
}

beforeEach(() => {
  acceptChapterDraft.mockReset()
  acceptChapterDraft.mockResolvedValue({ formalChapterPath: "/proj/wiki/chapters/第3章.md" })
})

describe("createMainControlAcceptSeam", () => {
  it("生产默认转调 acceptChapterDraft（与 ChapterDraftDock 同一实现），并原样透传 confirmed", async () => {
    const seam = createMainControlAcceptSeam({
      projectPath: "/proj",
      draftId: "draft_1_abc",
      confirmed: true,
    })
    await seam("/proj/wiki/chapters/第3章.md")

    expect(acceptChapterDraft).toHaveBeenCalledTimes(1)
    expect(acceptChapterDraft).toHaveBeenCalledWith({
      projectPath: "/proj",
      draftId: "draft_1_abc",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      confirmed: true,
    })
  })

  it("confirmed=false 原样透传（seam 不得把确认压成自证）", async () => {
    const seam = createMainControlAcceptSeam({
      projectPath: "/proj",
      draftId: "draft_1_abc",
      confirmed: false,
    })
    await seam("/proj/wiki/chapters/第3章.md")

    expect(acceptChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: false, draftId: "draft_1_abc" }),
    )
  })
})

describe("resolveMainControlDraftTarget", () => {
  it("同名同书复用选中文件，否则落 wiki/chapters（与 ChapterDraftDock 同一解析）", () => {
    expect(resolveMainControlDraftTarget("/proj", "第3章")).toBe("/proj/wiki/chapters/第3章.md")
    expect(resolveMainControlDraftTarget("/proj", "第3章", "/proj/wiki/chapters/第3章.md")).toBe(
      "/proj/wiki/chapters/第3章.md",
    )
    expect(resolveMainControlDraftTarget("/proj", "第3章", "/proj/wiki/chapters/第9章.md")).toBe(
      "/proj/wiki/chapters/第3章.md",
    )
  })
})

describe("adoptMainControlDraft", () => {
  it("确认后走 accept → 记忆回填降级分类（autoIngestOnSave 关闭 ⇒ skipped-config）", async () => {
    const out = await adoptMainControlDraft({
      projectPath: "/proj",
      draftId: "draft_1_abc",
      chapterName: "第3章",
      confirmed: true,
      novelConfig: novelConfig(),
      llmConfig,
    })

    expect(acceptChapterDraft).toHaveBeenCalledTimes(1)
    expect(acceptChapterDraft).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: "draft_1_abc", formalChapterPath: "/proj/wiki/chapters/第3章.md", confirmed: true }),
    )
    expect(out).toEqual({ formalChapterPath: "/proj/wiki/chapters/第3章.md", ingest: "skipped-config" })
  })

  it("未确认时不写正式正文：真实 acceptChapterDraft 抛错，writeFileAtomic 零调用", async () => {
    const writeFileAtomic = vi.fn(async () => {})
    const writeFile = vi.fn(async () => {})
    const readFile = vi.fn(async () => "")
    const listDirectory = vi.fn(async () => [])
    const fileExists = vi.fn(async () => true)
    const createDirectory = vi.fn(async () => {})

    // 注入真实 draft-manager 实现（只换 IO deps）：确认判定仍在 draft-manager 内。
    const acceptDraftWithFakeFs: typeof actualDraftManager.acceptChapterDraft = (input) =>
      actualDraftManager.acceptChapterDraft(input, {
        fileExists,
        createDirectory,
        writeFile,
        writeFileAtomic,
        readFile,
        listDirectory,
      })

    await expect(
      adoptMainControlDraft(
        {
          projectPath: "/proj",
          draftId: "draft_1_abc",
          chapterName: "第3章",
          confirmed: false,
          novelConfig: novelConfig(),
          llmConfig,
        },
        { acceptDraft: acceptDraftWithFakeFs },
      ),
    ).rejects.toThrow("采纳草稿必须先确认")

    expect(writeFileAtomic).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })
})
