// @vitest-environment jsdom
/**
 * WritingPreferenceSection — Wave 1 收口 PR2 最小表单。
 * 人类可读标签 100%（零内部 key 前缀暴露）+ 列表/新增/删除闭环。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  waitFor,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { WritingPreferenceSection } from "./writing-preference-section"
import type { UserPreference } from "@/lib/user-memory/types"

const mocks = vi.hoisted(() => {
  const wikiState: {
    project: { id: string; path: string } | null
  } = {
    project: { id: "p1", path: "/p1" },
  }
  return {
    wikiState,
    t: vi.fn((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key),
    listPreferences: vi.fn(async (): Promise<UserPreference[]> => []),
    addPreferenceForProject: vi.fn(async () => ({}) as UserPreference),
    deletePreferenceForProject: vi.fn(async () => true),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.wikiState) => unknown) => selector(mocks.wikiState),
    { getState: () => mocks.wikiState },
  ),
}))

vi.mock("@/lib/user-memory/session", () => ({
  listPreferences: mocks.listPreferences,
  addPreferenceForProject: mocks.addPreferenceForProject,
  deletePreferenceForProject: mocks.deletePreferenceForProject,
}))

beforeEach(() => {
  setupDomGlobals()
  vi.clearAllMocks()
  mocks.wikiState.project = { id: "p1", path: "/p1" }
  mocks.listPreferences.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
})

describe("WritingPreferenceSection", () => {
  it("renders empty state with human-readable preset labels only", async () => {
    render(<WritingPreferenceSection />)
    expect(screen.getByText("写作偏好")).toBeInTheDocument()
    expect(screen.getByText("暂无写作偏好，添加一条开始个性化。")).toBeInTheDocument()
    // 零内部 key 前缀暴露：下拉选项全部是人类可读标签
    const options = screen.getAllByRole("option")
    const labels = options.map((o) => o.textContent)
    expect(labels).toContain("事实一致性权重")
    expect(labels).toContain("避用词")
    expect(labels.some((l) => l?.includes("dim:") || l?.includes("deai_boost:"))).toBe(false)
    expect(mocks.listPreferences).toHaveBeenCalledWith("/p1")
  })

  it("adds a preference via preset label mapping and refreshes the list", async () => {
    mocks.listPreferences
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "p1", key: "avoid_words", value: "仿佛、不禁", category: "vocabulary", label: "避用词", createdAt: "", updatedAt: "" },
      ])
    render(<WritingPreferenceSection />)
    await waitFor(() => expect(screen.getByText("暂无写作偏好，添加一条开始个性化。")).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText("偏好类型"), { target: { value: "avoid_words" } })
    fireEvent.change(screen.getByLabelText("取值"), { target: { value: "仿佛、不禁" } })
    fireEvent.click(screen.getByText("添加"))

    await waitFor(() => {
      expect(mocks.addPreferenceForProject).toHaveBeenCalledWith("/p1", {
        key: "avoid_words",
        value: "仿佛、不禁",
        category: "vocabulary",
        label: "避用词",
      })
    })
    await waitFor(() => expect(screen.getByText("仿佛、不禁")).toBeInTheDocument())
  })

  it("deletes a preference and refreshes the list", async () => {
    mocks.listPreferences
      .mockResolvedValueOnce([
        { id: "p1", key: "dim:facts", value: "0.3", category: "review", label: "事实一致性权重", createdAt: "", updatedAt: "" },
      ])
      .mockResolvedValueOnce([])
    render(<WritingPreferenceSection />)
    await waitFor(() => expect(screen.getByText("事实一致性权重")).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText("删除"))
    await waitFor(() => {
      expect(mocks.deletePreferenceForProject).toHaveBeenCalledWith("/p1", "p1")
    })
    await waitFor(() => expect(screen.getByText("暂无写作偏好，添加一条开始个性化。")).toBeInTheDocument())
  })

  it("renders existing preferences with label and value", async () => {
    mocks.listPreferences.mockResolvedValue([
      { id: "p1", key: "deai_boost:词汇", value: "2.0", category: "vocabulary", label: "词汇增强系数", createdAt: "", updatedAt: "" },
    ])
    render(<WritingPreferenceSection />)
    await waitFor(() => expect(screen.getByText("词汇增强系数")).toBeInTheDocument())
    expect(screen.getByText("2.0")).toBeInTheDocument()
  })

  it("does not add when value is empty", async () => {
    render(<WritingPreferenceSection />)
    await waitFor(() => expect(screen.getByText("添加")).toBeInTheDocument())
    fireEvent.click(screen.getByText("添加"))
    expect(mocks.addPreferenceForProject).not.toHaveBeenCalled()
  })

  it("无项目：添加直接返回（projectPath 守卫）", async () => {
    mocks.wikiState.project = null
    render(<WritingPreferenceSection />)
    await waitFor(() => expect(screen.getByText("添加")).toBeInTheDocument())
    // 按钮在 value 非空时才可点，先输入再点击
    fireEvent.change(screen.getByLabelText("取值"), { target: { value: "0.3" } })
    fireEvent.click(screen.getByText("添加"))
    expect(mocks.addPreferenceForProject).not.toHaveBeenCalled()
  })

  it("无项目：删除直接返回（projectPath 守卫）", async () => {
    mocks.listPreferences.mockResolvedValue([
      { id: "p1", key: "deai_boost:词汇", value: "2.0", category: "vocabulary", label: "词汇增强系数", createdAt: "", updatedAt: "" },
    ])
    const { rerender } = render(<WritingPreferenceSection />)
    await waitFor(() => expect(screen.getAllByText("词汇增强系数").length).toBeGreaterThan(0))
    mocks.wikiState.project = null
    rerender(<WritingPreferenceSection />)
    fireEvent.click(screen.getByRole("button", { name: "删除" }))
    expect(mocks.deletePreferenceForProject).not.toHaveBeenCalled()
  })

  it("pref 无 label → 显示内部 key（label ?? key 兜底）", async () => {
    mocks.listPreferences.mockResolvedValue([
      { id: "p2", key: "deai_boost:句式", value: "1.5", category: "vocabulary", createdAt: "", updatedAt: "" },
    ])
    render(<WritingPreferenceSection />)
    await waitFor(() => expect(screen.getByText("deai_boost:句式")).toBeInTheDocument())
  })
})
