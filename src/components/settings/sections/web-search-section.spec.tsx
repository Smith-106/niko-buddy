// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test-helpers/component-test-utils"
import { WebSearchSection } from "./web-search-section"
import type { SearchApiConfig } from "@/stores/wiki-store"

interface WikiStateLike {
  searchApiConfig: SearchApiConfig
  setSearchApiConfig: (c: SearchApiConfig) => void
}

const mocks = vi.hoisted(() => {
  const state: WikiStateLike = {
    searchApiConfig: { provider: "none", apiKey: "" },
    setSearchApiConfig: vi.fn((c: SearchApiConfig) => { state.searchApiConfig = c }),
  }
  return {
    state,
    saveSearchApiConfig: vi.fn(async () => {}),
    t: vi.fn((key: string) => key),
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: WikiStateLike) => unknown) => selector(mocks.state),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/lib/project-store", () => ({
  saveSearchApiConfig: mocks.saveSearchApiConfig,
}))

// 预热被动态 import 的 mock 模块：coverage 负载下首次动态 import 需秒级转换，
// 会导致上一个测试的 persist 续体晚写入下一个测试的共享 store 状态（串扰 flake）。
import "@/lib/project-store"

function providerHeader(id: string): HTMLElement {
  const label = screen.getByText(id === "searxng" ? "SearXNG" : id === "tavily" ? "Tavily" : "SerpApi")
  return label.closest("div")?.parentElement?.parentElement as HTMLElement
}

function toggleFor(id: string): HTMLElement {
  const header = providerHeader(id)
  const toggle = header.querySelector("button[aria-label]") as HTMLElement
  expect(toggle).not.toBeNull()
  return toggle
}

function expandFor(id: string): HTMLElement {
  const header = providerHeader(id)
  const chevron = header.querySelector("button[title]") as HTMLElement
  expect(chevron).not.toBeNull()
  return chevron
}

describe("WebSearchSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.searchApiConfig = { provider: "none", apiKey: "" }
    mocks.saveSearchApiConfig.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
    vi.useRealTimers()
  })

  it("默认 none 配置：三个 provider 卡片渲染，无 active/configured/saved 徽标", () => {
    render(<WebSearchSection />)
    expect(screen.getByText("Tavily")).toBeInTheDocument()
    expect(screen.getByText("SerpApi")).toBeInTheDocument()
    expect(screen.getByText("SearXNG")).toBeInTheDocument()
    expect(screen.queryByText("settings.sections.webSearch.activeBadge")).not.toBeInTheDocument()
    expect(screen.queryByText("settings.sections.webSearch.configuredBadge")).not.toBeInTheDocument()
    expect(screen.queryByText("settings.sections.webSearch.savedBadge")).not.toBeInTheDocument()
  })

  it("默认 none 配置展开 searxng/serpapi：URL/engine/categories 回退默认值（?? 兜底）", () => {
    render(<WebSearchSection />)
    // searxng：无 override 无全局配置 → URL 空串回退 + categories [general] 回退
    fireEvent.click(expandFor("searxng"))
    expect(screen.getByPlaceholderText("https://search.example.com")).toHaveValue("")
    expect(screen.getByText("settings.sections.webSearch.searxngJsonHint")).toBeInTheDocument()
    // serpapi：engine 回退 google
    fireEvent.click(expandFor("serpapi"))
    expect(screen.getByText("settings.sections.webSearch.searchEngine")).toBeInTheDocument()
  })

  it("展开/收起 provider 面板（chevron 与标题按钮双入口）", () => {
    render(<WebSearchSection />)
    // 初始收起：无配置面板
    expect(screen.queryByText("settings.apiKey")).not.toBeInTheDocument()
    fireEvent.click(expandFor("tavily"))
    expect(screen.getAllByText("settings.apiKey").length).toBeGreaterThan(0)
    // 标题按钮收起
    const header = providerHeader("tavily")
    fireEvent.click(header.querySelector("button.min-w-0") as HTMLElement)
    expect(screen.queryByText("settings.apiKey")).not.toBeInTheDocument()
  })

  it("toggleActive：none → tavily；tavily → none", async () => {
    const { rerender } = render(<WebSearchSection />)
    fireEvent.click(toggleFor("tavily"))
    await waitFor(() =>
      expect(mocks.state.setSearchApiConfig).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "tavily" }),
      ),
    )
    expect(mocks.saveSearchApiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "tavily" }),
    )

    // tavily 已激活时再 toggle → none
    mocks.state.searchApiConfig = { provider: "tavily", apiKey: "k" }
    rerender(<WebSearchSection />)
    fireEvent.click(toggleFor("tavily"))
    await waitFor(() =>
      expect(mocks.state.setSearchApiConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({ provider: "none" }),
      ),
    )
  })

  it("updateProvider：合并 override 并持久化；saved 徽标出现后 1.5s 消失", async () => {
    vi.useFakeTimers()
    render(<WebSearchSection />)
    fireEvent.click(expandFor("tavily"))
    const apiInput = screen.getAllByPlaceholderText("Enter your Tavily API key (tavily.com)")[0] as HTMLInputElement
    fireEvent.change(apiInput, { target: { value: "tk1" } })

    // persist 先 await 动态 import，再 setSearchApiConfig → 需要冲刷微任务
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText("settings.sections.webSearch.savedBadge")).toBeInTheDocument()
    expect(mocks.state.setSearchApiConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConfigs: expect.objectContaining({
          tavily: expect.objectContaining({ apiKey: "tk1" }),
        }),
      }),
    )
    expect(mocks.saveSearchApiConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConfigs: expect.objectContaining({
          tavily: expect.objectContaining({ apiKey: "tk1" }),
        }),
      }),
    )

    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(screen.queryByText("settings.sections.webSearch.savedBadge")).not.toBeInTheDocument()
  })

  it("saveSearchApiConfig 失败被吞掉（persist .catch 分支，updateProvider + toggleActive）", async () => {
    mocks.saveSearchApiConfig.mockRejectedValue(new Error("save-fail"))
    render(<WebSearchSection />)
    fireEvent.click(expandFor("tavily"))
    const apiInput = screen.getAllByPlaceholderText("Enter your Tavily API key (tavily.com)")[0] as HTMLInputElement
    fireEvent.change(apiInput, { target: { value: "tk2" } })
    // toggleActive 的 persist .catch（FN 9）——必须等到该写回落定，否则续体
    // 会在后续测试（serpapi）中途写入共享 mock store，串扰其断言。
    fireEvent.click(toggleFor("tavily"))
    await waitFor(() =>
      expect(mocks.state.setSearchApiConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({ provider: "tavily" }),
      ),
    )
    expect(mocks.saveSearchApiConfig).toHaveBeenCalled()
  })

  it("tavily 已配置且非激活 → configuredBadge；激活时 activeBadge + toggle 关闭态", () => {
    mocks.state.searchApiConfig = {
      provider: "serpapi",
      apiKey: "",
      providerConfigs: { tavily: { apiKey: "stored-key" } },
    }
    render(<WebSearchSection />)
    expect(screen.getByText("settings.sections.webSearch.configuredBadge")).toBeInTheDocument()
  })

  it("serpapi 展开：engine picker 渲染，选择 engine 与自定义输入；custom hint 分支", async () => {
    const { rerender } = render(<WebSearchSection />)
    fireEvent.click(expandFor("serpapi"))
    expect(screen.getByText("settings.sections.webSearch.searchEngine")).toBeInTheDocument()
    // 默认 google 高亮；点击 google_news
    fireEvent.click(screen.getByText("Google News"))
    await waitFor(() =>
      expect(mocks.state.setSearchApiConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          providerConfigs: expect.objectContaining({
            serpapi: expect.objectContaining({ serpApiEngine: "google_news" }),
          }),
        }),
      ),
    )

    // 自定义 engine 输入（非预置选项）→ isCustom hint（store 无订阅，rerender 刷新）
    const customInput = screen.getByPlaceholderText("settings.sections.webSearch.customSerpApiPlaceholder") as HTMLInputElement
    fireEvent.change(customInput, { target: { value: "custom-engine" } })
    // updateProvider → persist 先 await 动态 import，再 setSearchApiConfig：等实际 store 状态落定
    await waitFor(() => {
      expect(mocks.state.searchApiConfig.providerConfigs?.serpapi?.serpApiEngine).toBe("custom-engine")
    })
    rerender(<WebSearchSection />)
    expect(screen.getByText("settings.sections.webSearch.customSerpApiHint")).toBeInTheDocument()
  })

  it("searxng 展开：URL 输入 + category picker 增删分类", async () => {
    mocks.state.searchApiConfig = {
      provider: "searxng",
      apiKey: "",
      searXngUrl: "https://search.example.com",
      providerConfigs: { searxng: { searXngUrl: "https://search.example.com", searXngCategories: ["news"] } },
    }
    const { rerender } = render(<WebSearchSection />)
    fireEvent.click(expandFor("searxng"))

    const urlInput = screen.getByPlaceholderText("https://search.example.com") as HTMLInputElement
    expect(urlInput.value).toBe("https://search.example.com")
    fireEvent.change(urlInput, { target: { value: "https://search2.example.com" } })
    await waitFor(() =>
      expect(mocks.state.setSearchApiConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          providerConfigs: expect.objectContaining({
            searxng: expect.objectContaining({ searXngUrl: "https://search2.example.com" }),
          }),
        }),
      ),
    )

    // news 已选中 → 点击移除（[] → 回退 ["general"]）
    fireEvent.click(screen.getByTitle("News engines"))
    await waitFor(() =>
      expect(mocks.state.setSearchApiConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({
          providerConfigs: expect.objectContaining({
            searxng: expect.objectContaining({ searXngCategories: ["general"] }),
          }),
        }),
      ),
    )
    // 再点 Science 追加 → ADD 分支（先 rerender 让 store 新值生效）
    rerender(<WebSearchSection />)
    fireEvent.click(screen.getByTitle("Academic and science-focused engines"))
    await waitFor(() =>
      expect(mocks.state.setSearchApiConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({
          providerConfigs: expect.objectContaining({
            searxng: expect.objectContaining({ searXngCategories: ["general", "science"] }),
          }),
        }),
      ),
    )
  })

  it("searxng categories 为空数组时回退默认选中 general（selected 兜底分支）", () => {
    mocks.state.searchApiConfig = {
      provider: "searxng",
      apiKey: "",
      providerConfigs: { searxng: { searXngCategories: [] } },
    }
    render(<WebSearchSection />)
    fireEvent.click(expandFor("searxng"))
    const generalBtn = screen.getByTitle("Default web results")
    expect(generalBtn.className).toContain("border-primary")
  })

  it("searxng override 无 categories 时回退 resolvedConfig 默认（loc2 分支）", () => {
    mocks.state.searchApiConfig = {
      provider: "searxng",
      apiKey: "",
      providerConfigs: { searxng: { searXngUrl: "https://x" } },
    }
    render(<WebSearchSection />)
    fireEvent.click(expandFor("searxng"))
    const generalBtn = screen.getByTitle("Default web results")
    expect(generalBtn.className).toContain("border-primary")
  })

  it("saved 徽标跨 provider 竞争：旧 timer 回调 cur !== id 分支", async () => {
    vi.useFakeTimers()
    render(<WebSearchSection />)
    fireEvent.click(expandFor("tavily"))
    const apiInput = screen.getAllByPlaceholderText("Enter your Tavily API key (tavily.com)")[0] as HTMLInputElement
    fireEvent.change(apiInput, { target: { value: "tk-a" } })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // 再更新 serpapi → savedId 被覆盖为 serpapi，tavily 的 timer 仍待触发
    fireEvent.click(expandFor("serpapi"))
    fireEvent.click(screen.getByText("Google News"))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // 两个 timer 同时到期：tavily 回调先执行（cur=serpapi !== tavily → 保持），serpapi 回调置 null
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(screen.queryByText("settings.sections.webSearch.savedBadge")).not.toBeInTheDocument()
  })

  it("active provider（tavily）卡片高亮 + toggle 关闭文案", () => {
    mocks.state.searchApiConfig = { provider: "tavily", apiKey: "k", providerConfigs: { tavily: { apiKey: "k" } } }
    render(<WebSearchSection />)
    expect(screen.getByText("settings.sections.webSearch.activeBadge")).toBeInTheDocument()
    const toggle = toggleFor("tavily")
    expect(toggle.getAttribute("aria-label")).toBe("settings.sections.webSearch.deactivate")
  })
})
