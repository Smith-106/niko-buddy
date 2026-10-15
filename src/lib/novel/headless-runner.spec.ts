// @vitest-environment node
// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * G2 无头驱动器单测：覆盖参数归一纯函数与薄封装委托行为。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { runEndToEndAutonomousNovelProduction } from "./autonomous-incubator"
import {
  normalizeHeadlessOptions,
  runHeadlessNovelProduction,
} from "./headless-runner"

vi.mock("./autonomous-incubator", () => ({
  runEndToEndAutonomousNovelProduction: vi.fn(),
}))

const mockLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "key",
  model: "gpt-4o",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128000,
}

type EndToEndResult = Awaited<ReturnType<typeof runEndToEndAutonomousNovelProduction>>

function mockResolved(value: EndToEndResult): void {
  vi.mocked(runEndToEndAutonomousNovelProduction).mockResolvedValue(value)
}

function stubResult(): EndToEndResult {
  return undefined as unknown as EndToEndResult
}

describe("G2 无头驱动器参数归一", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("缺省目标章数取 10，缺省巡航取 3", () => {
    const normalized = normalizeHeadlessOptions({
      projectPath: "/test/project",
      idea: "一名记忆修复师唤醒了神明代码",
      llmConfig: mockLlmConfig,
    })
    expect(normalized.targetChapters).toBe(10)
    expect(normalized.autoStartCruise).toBe(false)
    expect(normalized.cruiseChapterCount).toBe(3)
  })

  it("目标章数不足 3 时缺省巡航截断至目标章数", () => {
    const two = normalizeHeadlessOptions({
      projectPath: "/test/project",
      idea: "灵感",
      targetChapters: 2,
      llmConfig: mockLlmConfig,
    })
    expect(two.cruiseChapterCount).toBe(2)

    const one = normalizeHeadlessOptions({
      projectPath: "/test/project",
      idea: "灵感",
      targetChapters: 1,
      llmConfig: mockLlmConfig,
    })
    expect(one.cruiseChapterCount).toBe(1)
  })

  it("显式巡航超限截断至目标章数，未超限保留原值", () => {
    const truncated = normalizeHeadlessOptions({
      projectPath: "/test/project",
      idea: "灵感",
      targetChapters: 5,
      cruiseChapterCount: 10,
      llmConfig: mockLlmConfig,
    })
    expect(truncated.cruiseChapterCount).toBe(5)

    const kept = normalizeHeadlessOptions({
      projectPath: "/test/project",
      idea: "灵感",
      targetChapters: 10,
      cruiseChapterCount: 2,
      llmConfig: mockLlmConfig,
    })
    expect(kept.cruiseChapterCount).toBe(2)
  })

  it("其余参数原样透传，不改写输入对象", () => {
    const buildChapterRequest = (chapterNumber: number): string => `第${chapterNumber}章指令`
    const input = {
      projectPath: "/test/project",
      idea: "灵感",
      title: "神明代码",
      genre: "科幻未来",
      targetChapters: 4,
      autoStartCruise: true,
      llmConfig: mockLlmConfig,
      buildChapterRequest,
    }
    const normalized = normalizeHeadlessOptions(input)
    expect(normalized.projectPath).toBe("/test/project")
    expect(normalized.title).toBe("神明代码")
    expect(normalized.genre).toBe("科幻未来")
    expect(normalized.autoStartCruise).toBe(true)
    expect(normalized.buildChapterRequest).toBe(buildChapterRequest)
    expect("cruiseChapterCount" in input).toBe(false)
  })

  it("薄封装委托上游时携带归一化巡航章数并剥离预留位", async () => {
    mockResolved(stubResult())
    await runHeadlessNovelProduction({
      projectPath: "/test/project",
      idea: "灵感",
      targetChapters: 2,
      autoStartCruise: true,
      llmConfig: mockLlmConfig,
      buildChapterRequest: (chapterNumber: number) => `第${chapterNumber}章指令`,
    })
    expect(runEndToEndAutonomousNovelProduction).toHaveBeenCalledTimes(1)
    const delegated = vi.mocked(runEndToEndAutonomousNovelProduction).mock.calls[0]?.[0]
    expect(delegated?.targetChapters).toBe(2)
    expect(delegated?.cruiseChapterCount).toBe(2)
    expect(delegated?.autoStartCruise).toBe(true)
    expect(delegated).not.toHaveProperty("buildChapterRequest")
  })
})
