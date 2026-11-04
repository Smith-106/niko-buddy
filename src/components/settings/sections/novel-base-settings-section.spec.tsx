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
    noteDiscardedWritingConfig(PROJECT_PATH, "deepseek/muse-spark-1.3-contributor-free")
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
    noteDiscardedWritingConfig(PROJECT_PATH, "")
    renderSection()
    expect(screen.queryByTestId(BANNER)).toBeNull()
  })

  it("留痕作用域与当前项目不匹配时不显示（不会串项目）", () => {
    setProject(PROJECT_PATH)
    noteDiscardedWritingConfig("/another-project", "some-model")
    renderSection()
    expect(screen.queryByTestId(BANNER)).toBeNull()
  })

  it("关闭后不再显示，并把关闭态落到 localStorage", () => {
    setProject(PROJECT_PATH)
    noteDiscardedWritingConfig(PROJECT_PATH, "some-model")
    renderSection()
    fireEvent.click(screen.getByTestId(DISMISS))
    expect(screen.queryByTestId(BANNER)).toBeNull()
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("1")
  })

  it("已关闭过的用户再进来不再看到横幅", () => {
    setProject(PROJECT_PATH)
    noteDiscardedWritingConfig(PROJECT_PATH, "some-model")
    localStorage.setItem(DISMISSED_KEY, "1")
    renderSection()
    expect(screen.queryByTestId(BANNER)).toBeNull()
  })

  it("RV-006：在 A 项目关掉不影响 B 项目的告知（关闭态按作用域隔离）", () => {
    setProject(PROJECT_PATH)
    noteDiscardedWritingConfig(PROJECT_PATH, "proj-a-model")
    noteDiscardedWritingConfig("/proj-b", "proj-b-model")
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
      noteDiscardedWritingConfig(PROJECT_PATH, "late-model")
    })
    expect(screen.queryByTestId(BANNER)).not.toBeNull()
  })
})
