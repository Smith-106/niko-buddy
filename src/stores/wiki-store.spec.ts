import { beforeEach, describe, expect, it, vi } from "vitest"

const mem: Record<string, string> = {}
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => mem[key] ?? null,
    setItem: (key: string, val: string) => {
      mem[key] = String(val)
    },
    removeItem: (key: string) => {
      delete mem[key]
    },
    clear: () => {
      for (const k of Object.keys(mem)) delete mem[k]
    },
  },
  writable: true,
  configurable: true,
})

import { useWikiStore } from "./wiki-store"
import { DEFAULT_NOVEL_CONFIG, DEFAULT_RERANK_CONFIG, TASK_PROMPT_KEYS } from "./wiki-store"

function state() {
  return useWikiStore.getState()
}

function reset(keys: Record<string, unknown>) {
  useWikiStore.setState(keys)
}

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k]
  vi.unstubAllGlobals()
  reset({
    activeView: "wiki",
    skillLibraryDraftDirty: false,
    writingSkillLibraryDraftDirty: false,
    selectedSkillLibrarySkillId: null,
    selectedWritingSkillLibrarySkillId: null,
    focusMode: false,
    bindingVersion: 0,
    selectedReviewDimension: null,
    mcpConfig: null,
    selectedReviewFilePath: "",
    reviewRun: null,
    reviewRunAbortController: null,
    offlineMode: false,
    dataVersion: 0,
    chapterCreateNonce: 0,
  })
})

describe("模块导出（C4 原冒烟项收敛为真断言）", () => {
  it("默认配置与提示词键表结构完整", () => {
    expect(DEFAULT_RERANK_CONFIG.enabled).toBeDefined()
    expect(DEFAULT_NOVEL_CONFIG.chapterTargetChars).toBeGreaterThan(0)
    expect(TASK_PROMPT_KEYS.length).toBeGreaterThan(0)
  })
})

describe("setFocusMode", () => {
  it("开/关同步写 localStorage 并更新 state", () => {
    state().setFocusMode(true)
    expect(state().focusMode).toBe(true)
    expect(mem["niko-buddy-focus-mode"]).toBe("1")
    state().setFocusMode(false)
    expect(state().focusMode).toBe(false)
    expect(mem["niko-buddy-focus-mode"]).toBe("0")
  })
})

describe("setActiveView 草稿守卫", () => {
  function denyDiscard() {
    vi.stubGlobal("window", { confirm: () => false })
  }

  it("skillLibrary 有未存草稿且用户取消 → 停留原视图", () => {
    reset({ activeView: "skillLibrary", skillLibraryDraftDirty: true })
    denyDiscard()
    state().setActiveView("wiki")
    expect(state().activeView).toBe("skillLibrary")
    expect(state().skillLibraryDraftDirty).toBe(true)
  })

  it("skillLibrary 有未存草稿且用户确认 → 切换并清 dirty", () => {
    reset({ activeView: "skillLibrary", skillLibraryDraftDirty: true })
    vi.stubGlobal("window", { confirm: () => true })
    state().setActiveView("wiki")
    expect(state().activeView).toBe("wiki")
    expect(state().skillLibraryDraftDirty).toBe(false)
  })

  it("writingSkillLibrary 有未存草稿且用户取消 → 停留原视图", () => {
    reset({ activeView: "writingSkillLibrary", writingSkillLibraryDraftDirty: true })
    denyDiscard()
    state().setActiveView("wiki")
    expect(state().activeView).toBe("writingSkillLibrary")
  })

  it("writingSkillLibrary 确认后切换并清 dirty", () => {
    reset({ activeView: "writingSkillLibrary", writingSkillLibraryDraftDirty: true })
    vi.stubGlobal("window", { confirm: () => true })
    state().setActiveView("search")
    expect(state().activeView).toBe("search")
    expect(state().writingSkillLibraryDraftDirty).toBe(false)
  })

  it("无 dirty 时直接切换；切入 skillLibrary 保留其 dirty", () => {
    state().setActiveView("search")
    expect(state().activeView).toBe("search")
    reset({ skillLibraryDraftDirty: true })
    state().setActiveView("skillLibrary")
    expect(state().skillLibraryDraftDirty).toBe(true)
  })
})

describe("技能库选中守卫", () => {
  it("setSelectedSkillLibrarySkillId 同值 → 空更新（引用不变）", () => {
    reset({ selectedSkillLibrarySkillId: "s1" })
    state().setSelectedSkillLibrarySkillId("s1")
    expect(state().selectedSkillLibrarySkillId).toBe("s1")
  })

  it("dirty 且用户取消 → 保留旧选中", () => {
    reset({ selectedSkillLibrarySkillId: "old", skillLibraryDraftDirty: true })
    vi.stubGlobal("window", { confirm: () => false })
    state().setSelectedSkillLibrarySkillId("new")
    expect(state().selectedSkillLibrarySkillId).toBe("old")
    expect(state().skillLibraryDraftDirty).toBe(true)
  })

  it("dirty 且用户确认 → 切换并清 dirty", () => {
    reset({ selectedSkillLibrarySkillId: "old", skillLibraryDraftDirty: true })
    vi.stubGlobal("window", { confirm: () => true })
    state().setSelectedSkillLibrarySkillId("new")
    expect(state().selectedSkillLibrarySkillId).toBe("new")
    expect(state().skillLibraryDraftDirty).toBe(false)
  })

  it("setSelectedWritingSkillLibrarySkillId 同值/取消/确认三态", () => {
    reset({ selectedWritingSkillLibrarySkillId: "w1" })
    state().setSelectedWritingSkillLibrarySkillId("w1")
    expect(state().selectedWritingSkillLibrarySkillId).toBe("w1")

    reset({ selectedWritingSkillLibrarySkillId: "w1", writingSkillLibraryDraftDirty: true })
    vi.stubGlobal("window", { confirm: () => false })
    state().setSelectedWritingSkillLibrarySkillId("w2")
    expect(state().selectedWritingSkillLibrarySkillId).toBe("w1")

    vi.stubGlobal("window", { confirm: () => true })
    state().setSelectedWritingSkillLibrarySkillId("w2")
    expect(state().selectedWritingSkillLibrarySkillId).toBe("w2")
    expect(state().writingSkillLibraryDraftDirty).toBe(false)
  })

  it("draft dirty 开关直接赋值", () => {
    state().setSkillLibraryDraftDirty(true)
    expect(state().skillLibraryDraftDirty).toBe(true)
    state().setWritingSkillLibraryDraftDirty(true)
    expect(state().writingSkillLibraryDraftDirty).toBe(true)
  })
})

describe("轻量计数器与直接赋值器", () => {
  it("bumpBindingVersion 递增", () => {
    state().bumpBindingVersion()
    state().bumpBindingVersion()
    expect(state().bindingVersion).toBe(2)
  })

  it("setSelectedReviewDimension / setMcpConfig / setSelectedReviewFilePath", () => {
    state().setSelectedReviewDimension("thrill")
    expect(state().selectedReviewDimension).toBe("thrill")
    const cfg = { servers: [] } as unknown as NonNullable<ReturnType<typeof state>["mcpConfig"]>
    state().setMcpConfig(cfg)
    expect(state().mcpConfig).toBe(cfg)
    state().setSelectedReviewFilePath("ch01.md")
    expect(state().selectedReviewFilePath).toBe("ch01.md")
  })

  it("setAiWorkflowMode 直接赋值", () => {
    state().setAiWorkflowMode("strict")
    expect(state().aiWorkflowMode).toBe("strict")
  })

  it("bumpDataVersion / requestChapterCreate 递增", () => {
    state().bumpDataVersion()
    expect(state().dataVersion).toBe(1)
    state().requestChapterCreate()
    state().requestChapterCreate()
    expect(state().chapterCreateNonce).toBe(2)
  })
})

describe("cancelReviewRun", () => {
  it("无 reviewRun → 状态保持 null", () => {
    state().cancelReviewRun()
    expect(state().reviewRun).toBeNull()
  })

  it("reviewRun 未 running → 原样返回（running 仍 falsy）", () => {
    reset({ reviewRun: { running: false } as never })
    state().cancelReviewRun()
    expect(state().reviewRun?.running).toBe(false)
  })

  it("running → abort 级联并收敛为非 running", () => {
    const abort = vi.fn()
    reset({
      reviewRun: { running: true, runId: "r1" } as never,
      reviewRunAbortController: { abort } as unknown as AbortController,
    })
    state().cancelReviewRun()
    expect(abort).toHaveBeenCalled()
    expect(state().reviewRun?.running).toBe(false)
    expect(state().reviewRun?.error).toBeUndefined()
  })

  it("running 但无 AbortController → 同样收敛且不抛错", () => {
    reset({ reviewRun: { running: true, runId: "r2" } as never, reviewRunAbortController: null })
    state().cancelReviewRun()
    expect(state().reviewRun?.running).toBe(false)
  })
})

describe("setOfflineMode", () => {
  it("开/关同步写 localStorage 并更新 state", () => {
    state().setOfflineMode(true)
    expect(state().offlineMode).toBe(true)
    expect(mem["niko-buddy-offline-mode"]).toBe("1")
    state().setOfflineMode(false)
    expect(state().offlineMode).toBe(false)
    expect(mem["niko-buddy-offline-mode"]).toBe("0")
  })
})
