// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// DEBT-20261104-residual-04「告知」回归：旧写作模型配置被丢弃时，设置页要显示**原值**。
//
// 背景：`writingModel` 已按 DEC-R2=A 真删除，旧配置里的非空值会被丢弃、写作改走 AI 会话
// 当前模型。这是对用户有意义的行为变化，不能只留在 console 里；用户已拍板「留痕 + 告知」，
// 故本 spec 钉住三件事：有非空丢弃值才显示、显示的是原值、关闭后不再显示。
//
// 刻意**不 mock** `@/lib/project-store` 与 `@/stores/wiki-store`：留痕登记表与项目路径都走
// 真实实现，这样测的是接线本身，而不是我自己的桩。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent } from "@testing-library/react"
import { render, screen } from "@/test-helpers/component-test-utils"
import {
  __resetDiscardedWritingConfigForTest,
  noteDiscardedWritingConfig,
} from "@/lib/discarded-writing-config-notice"
import { useWikiStore } from "@/stores/wiki-store"
import { NovelBaseSettingsSection } from "./novel-base-settings-section"

const t = vi.fn((key: string, options?: Record<string, unknown>) =>
  options && typeof options.value === "string" ? `${key}::${options.value}` : key,
)

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t }),
}))

const BANNER = "novel-writing-model-discarded-notice"
const DISMISS = "novel-writing-model-discarded-notice-dismiss"
const PROJECT_PATH = "/proj"
// 关闭态 key 带作用域后缀（RV-006）：关闭是「某个项目看过了」，不是「所有项目都别提示」。
const DISMISSED_KEY = `niko-buddy.discarded-writing-config-notice.dismissed.${PROJECT_PATH}`

function setProject(path: string | null) {
  useWikiStore.setState({ project: path === null ? null : ({ path } as never) })
}

function renderSection() {
  return render(
    <NovelBaseSettingsSection
      draft={{ novelConfig: {} } as never}
      setDraft={(() => undefined) as never}
      updateNovelConfig={async () => undefined}
    />,
  )
}

beforeEach(() => {
  t.mockClear()
  __resetDiscardedWritingConfigForTest()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  __resetDiscardedWritingConfigForTest()
  setProject(null)
  localStorage.clear()
})

describe("DiscardedWritingConfigNoticeBanner", () => {
  it("有非空丢弃值时显示横幅，且带上原值", () => {
    setProject(PROJECT_PATH)
    noteDiscardedWritingConfig({ projectPath: PROJECT_PATH, raw: "deepseek/muse-spark-1.3-contributor-free" })
    renderSection()
    const banner = screen.queryByTestId(BANNER)
    expect(banner).not.toBeNull()
    expect(banner!.textContent).toContain("deepseek/muse-spark-1.3-contributor-free")
  })

  it("没有留痕时不显示横幅", () => {
    setProject(PROJECT_PATH)
    renderSection()
    expect(screen.queryByTestId(BANNER)).toBeNull()
  })

  it("丢弃值为空串（旧版本主动落盘的空值）时不显示，避免无意义提示", () => {
    setProject(PROJECT_PATH)
    noteDiscardedWritingConfig({ projectPath: PROJECT_PATH, raw: "" })
    renderSection()
    expect(screen.queryByTestId(BANNER)).toBeNull()
  })

  it("留痕作用域与当前项目不匹配时不显示（不会串项目）", () => {
    setProject(PROJECT_PATH)
    noteDiscardedWritingConfig({ projectPath: "/another-project", raw: "some-model" })
    renderSection()
    expect(screen.queryByTestId(BANNER)).toBeNull()
  })

  it("关闭后不再显示，并把关闭态落到 localStorage", () => {
    setProject(PROJECT_PATH)
    noteDiscardedWritingConfig({ projectPath: PROJECT_PATH, raw: "some-model" })
    renderSection()
    fireEvent.click(screen.getByTestId(DISMISS))
    expect(screen.queryByTestId(BANNER)).toBeNull()
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("1")
  })

  it("已关闭过的用户再进来不再看到横幅", () => {
    setProject(PROJECT_PATH)
    noteDiscardedWritingConfig({ projectPath: PROJECT_PATH, raw: "some-model" })
    localStorage.setItem(DISMISSED_KEY, "1")
    renderSection()
    expect(screen.queryByTestId(BANNER)).toBeNull()
  })

  it("RV-006：在 A 项目关掉不影响 B 项目的告知（关闭态按作用域隔离）", () => {
    setProject(PROJECT_PATH)
    noteDiscardedWritingConfig({ projectPath: PROJECT_PATH, raw: "proj-a-model" })
    noteDiscardedWritingConfig({ projectPath: "/proj-b", raw: "proj-b-model" })
    localStorage.setItem(DISMISSED_KEY, "1")

    renderSection()
    expect(screen.queryByTestId(BANNER)).toBeNull() // A 已关，静默

    cleanup()
    setProject("/proj-b")
    renderSection()
    const banner = screen.queryByTestId(BANNER)
    expect(banner).not.toBeNull() // B 未关，仍告知
    expect(banner!.textContent).toContain("proj-b-model")
  })

  it("RV-002：留痕晚于首次渲染写入时，横幅仍会出现（响应式订阅）", () => {
    setProject(PROJECT_PATH)
    renderSection()
    expect(screen.queryByTestId(BANNER)).toBeNull()
    // 首次渲染之后才写留痕：上一版直接读 Map，不会重渲染，横幅永远不出现
    act(() => {
      noteDiscardedWritingConfig({ projectPath: PROJECT_PATH, raw: "late-model" })
    })
    expect(screen.queryByTestId(BANNER)).not.toBeNull()
  })
})

describe("NovelBaseSettingsSection 基础控件（覆盖战役补齐）", () => {
  const updateNovelConfig = vi.fn(async (_patch: unknown) => undefined)
  const setDraft = vi.fn((_key: unknown, _value: unknown) => undefined)

  function buildDraft(): Record<string, unknown> {
    return {
      maxHistoryMessages: 4,
      aiWorkflowMode: "standard",
      novelConfig: {
        recentSummaryWindow: 8,
        searchTopK: 5,
        contextTokenBudget: 4000,
        genre: undefined,
        chapterTargetChars: 3000,
        autoIngestOnSave: true,
        reviewBeforeSave: false,
        deepPreviousChaptersAnalysis: false,
        deepChapterReview: false,
        literaryPolishAfterGate: false,
        autoGenerateChapterTitle: true,
        autoPlanningEnabled: true,
        stageJournalEnabled: true,
        journalTtlMs: undefined,
        reviewReasoningEffort: "high",
        communitySummaryEnabled: false,
        communitySummaryInterval: 7,
        communitySummaryAsync: false,
        temporalFactsEnabled: true,
        entityBoostEnabled: true,
        entityBoostWeight: 0.4,
        stateDeltaLightCheckEnabled: true,
        outlineThrillSoftGateEnabled: true,
        dualKbRoutingEnabled: false,
        usefulnessRerankEnabled: false,
        hardInjectEnabled: true,
        exemplarEnabled: true,
        relatedChaptersEnabled: true,
        referenceEnabled: true,
        sceneBreakdownEnabled: false,
        conditionalRoutingEnabled: true,
        inspectorEnabled: true,
        stateDeltaBlocksTrackA: false,
        trustFilterEnabled: false,
        residualCampaignEnabled: false,
        residualCampaignIncludeFreezeChapters: false,
      },
    }
  }

  function renderFull(draft?: Record<string, unknown>) {
    return render(
      <NovelBaseSettingsSection
        draft={(draft ?? buildDraft()) as never}
        setDraft={setDraft as never}
        updateNovelConfig={updateNovelConfig as never}
      />,
    )
  }

  beforeEach(() => {
    updateNovelConfig.mockClear()
    setDraft.mockClear()
    setProject(null)
  })

  it("体裁选择：选具体体裁写入 code；选空/通用回退 undefined", () => {
    renderFull()
    const select = screen.getByTestId("novel-genre-select") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "xianxia" } })
    expect(updateNovelConfig).toHaveBeenLastCalledWith({ genre: "xianxia" })
    fireEvent.change(select, { target: { value: "" } })
    expect(updateNovelConfig).toHaveBeenLastCalledWith({ genre: undefined })
    fireEvent.change(select, { target: { value: "general" } })
    expect(updateNovelConfig).toHaveBeenLastCalledWith({ genre: undefined })
  })

  it("工作流强度按钮：点击 fast 只改 draft（D1=A，不直接落盘）", () => {
    renderFull()
    fireEvent.click(screen.getByTestId("novel-ai-workflow-mode-fast"))
    expect(setDraft).toHaveBeenCalledWith("aiWorkflowMode", "fast")
    expect(updateNovelConfig).not.toHaveBeenCalled()
  })

  it("实验性检索开关三连：dualKb/usefulness/hardInject 取反写入", () => {
    renderFull()
    fireEvent.click(screen.getByRole("switch", { name: "novel.settings.dualKbRoutingEnabled" }))
    expect(updateNovelConfig).toHaveBeenLastCalledWith({ dualKbRoutingEnabled: true })
    fireEvent.click(screen.getByRole("switch", { name: "novel.settings.usefulnessRerankEnabled" }))
    expect(updateNovelConfig).toHaveBeenLastCalledWith({ usefulnessRerankEnabled: true })
    fireEvent.click(screen.getByRole("switch", { name: "novel.settings.hardInjectEnabled" }))
    expect(updateNovelConfig).toHaveBeenLastCalledWith({ hardInjectEnabled: false })
  })

  it("实体加权小数：改值失焦提交 onCommit", () => {
    renderFull()
    const input = screen.getByLabelText("novel.settings.entityBoostWeight") as HTMLInputElement
    fireEvent.change(input, { target: { value: "0.5" } })
    fireEvent.blur(input)
    expect(updateNovelConfig).toHaveBeenLastCalledWith({ entityBoostWeight: 0.5 })
  })

  it("内容组装开关（计算键）：exemplar 取反写入", () => {
    renderFull()
    fireEvent.click(screen.getByRole("switch", { name: "novel.settings.exemplarEnabled" }))
    expect(updateNovelConfig).toHaveBeenLastCalledWith({ exemplarEnabled: false })
  })

  it("无 localStorage 环境（SSR/隐私模式）：effect 提前返回，不崩", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    vi.stubGlobal("localStorage", undefined)
    try {
      renderFull()
      // 组件正常渲染：体裁选择器仍在，关闭态读不到存储即视为未关闭。
      expect(screen.getByTestId("novel-genre-select")).toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor)
    }
  })

  it("留痕值为 null（非字符串 raw）：横幅仍展示，body 走 ?? 空串分支", () => {
    setProject(PROJECT_PATH)
    noteDiscardedWritingConfig({ projectPath: PROJECT_PATH, raw: null })
    renderFull()
    // value 为 null：守卫 notice.value === "" 放行 null，展示时 ?? "" 兜底。
    expect(screen.getByTestId("novel-writing-model-discarded-notice")).toBeInTheDocument()
  })
})
