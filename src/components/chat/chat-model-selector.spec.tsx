// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/chat/chat-model-selector.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, waitFor } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { ChatModelSelector } from "./chat-model-selector"

// ── hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const state: {
    providerConfigs: Record<string, Record<string, unknown>>
  } = { providerConfigs: {} }
  return {
    state,
    t: vi.fn((key: string) => key),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}))

vi.mock("@/components/settings/llm-presets", () => ({
  LLM_PRESETS: [
    { id: "openai", label: "OpenAI Preset" },
    { id: "nolabel", label: "" },
  ],
}))

// forwardRef button so triggerRef works
vi.mock("@/components/ui/button", async () => {
  const React = await import("react")
  return {
    Button: React.forwardRef<HTMLButtonElement, {
      children?: React.ReactNode
      onClick?: () => void
      disabled?: boolean
      type?: "reset" | "submit" | "button"
    }>(({ children, onClick, disabled, type }, ref) => (
      <button ref={ref} type={type ?? "button"} onClick={onClick} disabled={disabled}>
        {children}
      </button>
    )),
  }
})

function model(id: string, name: string, modelId: string) {
  return { id, name, model: modelId, createdAt: 1 }
}

const GROUPS = {
  openai: { enabled: true, savedModels: [model("m1", "GPT-4o", "gpt-4o")] },
  nolabel: { enabled: true, label: "From Config", savedModels: [model("m2", "Claude", "claude-3")] },
  zzz: { enabled: true, savedModels: [model("m3", "Gemini", "gemini-1.5")] },
  offpreset: { enabled: false, savedModels: [model("m4", "Off", "off-1")] },
  emptypreset: { enabled: true, savedModels: [] },
  "custom-1": { enabled: true, label: "My Custom", savedModels: [model("m5", "DeepSeek", "deepseek-r1")] },
  "custom-2": { enabled: false, savedModels: [model("m6", "Hidden", "hidden-1")] },
  "custom-3": { enabled: true, savedModels: [model("m7", "NoLabel Custom", "nlc-1")] },
  "custom-4": { enabled: true, savedModels: [] },
}

function renderSelector(props: { value: string; onChange?: (m: string) => void; disabled?: boolean }) {
  return render(
    <ChatModelSelector
      value={props.value}
      onChange={props.onChange ?? vi.fn<(m: string) => void>()}
      disabled={props.disabled}
    />,
  )
}

function openDropdown() {
  const trigger = screen.getByRole("button")
  fireEvent.click(trigger)
}

function dropdown(): HTMLElement | null {
  return document.querySelector('[style*="max-height"]')
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  setupDomGlobals()
  mocks.state.providerConfigs = {}
  vi.restoreAllMocks()
})

describe("ChatModelSelector", () => {
  it("没有任何启用分组时返回 null", () => {
    mocks.state.providerConfigs = {
      openai: { enabled: false, savedModels: [model("x", "X", "x")] },
      "custom-1": { enabled: false },
    }
    const { container } = renderSelector({ value: "gpt-4o" })
    expect(container.querySelector("button")).toBeNull()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("分组构建：内置预设 label / config.label / key 回退，自定义卡片 label 回退，过滤停用与空列表", async () => {
    mocks.state.providerConfigs = GROUPS
    renderSelector({ value: "" })
    openDropdown()
    await waitFor(() => {
      expect(dropdown()).not.toBeNull()
    })
    // 组标题
    expect(screen.getByText("OpenAI Preset")).toBeInTheDocument()
    expect(screen.getByText("From Config")).toBeInTheDocument()
    expect(screen.getByText("zzz")).toBeInTheDocument()
    expect(screen.getByText("My Custom")).toBeInTheDocument()
    expect(screen.getByText("自定义模型")).toBeInTheDocument()
    // 被过滤的分组不渲染
    expect(screen.queryByText("Off")).not.toBeInTheDocument()
    expect(screen.queryByText("Hidden")).not.toBeInTheDocument()
    // 模型行
    expect(screen.getByText("GPT-4o")).toBeInTheDocument()
    expect(screen.getByText("deepseek-r1")).toBeInTheDocument()
    expect(screen.getByText("nlc-1")).toBeInTheDocument()
    // 分组间分隔线
    expect(document.querySelectorAll("div.h-px.bg-border").length).toBeGreaterThanOrEqual(4)
  })

  it("value 为 providerId/modelId 精确匹配 → 显示模型名，勾选图标区分选中/未选中", async () => {
    mocks.state.providerConfigs = GROUPS
    renderSelector({ value: "openai/gpt-4o" })
    expect(screen.getByRole("button").textContent).toContain("GPT-4o")
    openDropdown()
    await waitFor(() => {
      expect(dropdown()).not.toBeNull()
    })
    const selectedRow = screen.getByText("gpt-4o").closest("button") as HTMLElement
    expect(String(selectedRow.querySelector("svg")?.getAttribute("class"))).toContain("opacity-100")
    const unselectedRow = screen.getByText("claude-3").closest("button") as HTMLElement
    expect(String(unselectedRow.querySelector("svg")?.getAttribute("class"))).toContain("opacity-0")
  })

  it("value 为 providerId/modelId 但组内无该模型 → 回退纯模型名匹配失败 → 显示原始值", () => {
    mocks.state.providerConfigs = GROUPS
    renderSelector({ value: "openai/not-a-model" })
    expect(screen.getByRole("button").textContent).toContain("openai/not-a-model")
  })

  it("value 的 provider 不在分组中 → 跳过精确匹配直接回退 → 未找到则显示原始值", () => {
    mocks.state.providerConfigs = GROUPS
    renderSelector({ value: "unknown/gpt-4o" })
    expect(screen.getByRole("button").textContent).toContain("unknown/gpt-4o")
  })

  it("value 无斜杠 → 纯模型名回退匹配", () => {
    mocks.state.providerConfigs = GROUPS
    renderSelector({ value: "claude-3" })
    expect(screen.getByRole("button").textContent).toContain("Claude")
  })

  it("value 无法匹配任何分组 → 显示原始 value 文本", () => {
    mocks.state.providerConfigs = GROUPS
    renderSelector({ value: "totally-unknown-model" })
    expect(screen.getByRole("button").textContent).toContain("totally-unknown-model")
  })

  it("value 为空 → 显示 selectModel 提示", () => {
    mocks.state.providerConfigs = GROUPS
    renderSelector({ value: "" })
    expect(screen.getByRole("button").textContent).toContain("chat.selectModel")
  })

  it("选择模型 → onChange(providerId/modelId) 并关闭下拉", async () => {
    const onChange = vi.fn()
    mocks.state.providerConfigs = GROUPS
    renderSelector({ value: "", onChange })
    openDropdown()
    await waitFor(() => {
      expect(dropdown()).not.toBeNull()
    })
    fireEvent.click(screen.getByText("DeepSeek"))
    expect(onChange).toHaveBeenCalledWith("custom-1/deepseek-r1")
    await waitFor(() => {
      expect(dropdown()).toBeNull()
    })
  })

  it("点击遮罩关闭下拉", async () => {
    mocks.state.providerConfigs = GROUPS
    renderSelector({ value: "" })
    openDropdown()
    await waitFor(() => {
      expect(dropdown()).not.toBeNull()
    })
    fireEvent.click(document.querySelector(".fixed.inset-0.z-40") as HTMLElement)
    await waitFor(() => {
      expect(dropdown()).toBeNull()
    })
  })

  it("disabled 时不展开下拉", () => {
    mocks.state.providerConfigs = GROUPS
    renderSelector({ value: "", disabled: true })
    const trigger = screen.getByRole("button") as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)
    expect(dropdown()).toBeNull()
  })

  it("定位：下方空间不足且上方足够 → 显示在上方", async () => {
    mocks.state.providerConfigs = GROUPS
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue({
        top: 1000,
        bottom: 1032,
        left: 10,
        width: 200,
        height: 32,
        right: 210,
        x: 10,
        y: 1000,
        toJSON: () => ({}),
      } as DOMRect)
    renderSelector({ value: "" })
    openDropdown()
    await waitFor(() => {
      expect(dropdown()).not.toBeNull()
    })
    const panel = dropdown() as HTMLElement
    expect(panel.style.top).toBe("594px")
    expect(panel.style.left).toBe("10px")
    expect(panel.style.width).toBe("300px")
    spy.mockRestore()
  })

  it("定位：下方空间足够 → 显示在下方", async () => {
    mocks.state.providerConfigs = GROUPS
    renderSelector({ value: "" })
    openDropdown()
    await waitFor(() => {
      expect(dropdown()).not.toBeNull()
    })
    const panel = dropdown() as HTMLElement
    // jsdom 默认 rect 全 0：availableAbove=0 不足 → else 分支 top=rect.bottom+GAP=6
    expect(panel.style.top).toBe("6px")
  })

  it("resize 时重新定位（监听器生效）", async () => {
    mocks.state.providerConfigs = GROUPS
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue({
        top: 1000,
        bottom: 1032,
        left: 10,
        width: 200,
        height: 32,
        right: 210,
        x: 10,
        y: 1000,
        toJSON: () => ({}),
      } as DOMRect)
    renderSelector({ value: "" })
    openDropdown()
    await waitFor(() => {
      expect(dropdown()).not.toBeNull()
    })
    spy.mockReturnValue({
      top: 500,
      bottom: 532,
      left: 20,
      width: 200,
      height: 32,
      right: 220,
      x: 20,
      y: 500,
      toJSON: () => ({}),
    } as DOMRect)
    fireEvent(window, new Event("resize"))
    const panel = dropdown() as HTMLElement
    await waitFor(() => {
      expect(panel.style.top).toBe("94px")
      expect(panel.style.left).toBe("20px")
    })
    spy.mockRestore()
  })

  it("关闭下拉时移除 resize 监听并清空定位", async () => {
    mocks.state.providerConfigs = GROUPS
    renderSelector({ value: "" })
    openDropdown()
    await waitFor(() => {
      expect(dropdown()).not.toBeNull()
    })
    fireEvent.click(document.querySelector(".fixed.inset-0.z-40") as HTMLElement)
    await waitFor(() => {
      expect(dropdown()).toBeNull()
    })
    // 关闭后再触发 resize 不抛错（监听已移除）
    fireEvent(window, new Event("resize"))
  })

  it("打开时 getBoundingClientRect 返回空 → 不设置定位（rect 假分支）", async () => {
    mocks.state.providerConfigs = GROUPS
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(null as unknown as DOMRect)
    renderSelector({ value: "" })
    openDropdown()
    // updatePosition 提前返回 → dropdownStyle 保持 null → 面板不渲染
    expect(dropdown()).toBeNull()
    spy.mockRestore()
  })
})
