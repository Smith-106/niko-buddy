// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * main-control-settings.spec — 主控设置视图模型四用例（纯函数，无 DOM / 无 store）。
 */

import { describe, expect, it } from "vitest"
import { DEFAULT_NOVEL_CONFIG } from "@/stores/wiki-store"
import type { NovelConfig } from "@/stores/wiki-store"
import {
  MAIN_CONTROL_CHAPTER_TARGET_FALLBACK,
  MAIN_CONTROL_CHAPTER_TARGET_MAX,
  MAIN_CONTROL_CHAPTER_TARGET_MIN,
  clampChapterTargetChars,
  projectMainControlSettings,
} from "./main-control-settings"

function cfg(overrides: Partial<NovelConfig> = {}): NovelConfig {
  return { ...DEFAULT_NOVEL_CONFIG, ...overrides }
}

describe("projectMainControlSettings", () => {
  it("reviewModel 为空串时原样返回（空串=跟随会话模型）", () => {
    expect(projectMainControlSettings(cfg({ reviewModel: "" }), "standard").reviewModel).toBe("")
    expect(projectMainControlSettings(cfg({ reviewModel: "a/b" }), "standard").reviewModel).toBe("a/b")
  })

  it("chapterTargetChars 越界钳制：100→500 / 99999→20000 / NaN→3000", () => {
    expect(projectMainControlSettings(cfg({ chapterTargetChars: 100 }), "standard").chapterTargetChars).toBe(
      MAIN_CONTROL_CHAPTER_TARGET_MIN,
    )
    expect(projectMainControlSettings(cfg({ chapterTargetChars: 99999 }), "standard").chapterTargetChars).toBe(
      MAIN_CONTROL_CHAPTER_TARGET_MAX,
    )
    expect(projectMainControlSettings(cfg({ chapterTargetChars: Number.NaN }), "standard").chapterTargetChars).toBe(
      MAIN_CONTROL_CHAPTER_TARGET_FALLBACK,
    )
    // 合法值取整后原样保留
    expect(clampChapterTargetChars(3210.6)).toBe(3211)
  })

  it("preWriteGateMode 缺省得 warn，显式 block 生效", () => {
    expect(projectMainControlSettings(cfg({ preWriteGateMode: undefined }), "standard").preWriteGateMode).toBe("warn")
    expect(projectMainControlSettings(cfg({ preWriteGateMode: "block" }), "standard").preWriteGateMode).toBe("block")
    expect(projectMainControlSettings(cfg({ preWriteGateMode: "warn" }), "standard").preWriteGateMode).toBe("warn")
  })

  it("aiWorkflowMode 非法值回落 standard，且视图模型不含 writingModel（D2=C）", () => {
    const view = projectMainControlSettings(
      cfg(),
      // 故意传非法值：resolveAiWorkflowMode 兜底
      "bogus" as unknown as "standard",
    )
    expect(view.aiWorkflowMode).toBe("standard")
    expect("writingModel" in view).toBe(false)
    expect(projectMainControlSettings(cfg(), "strict").aiWorkflowMode).toBe("strict")
  })
})
