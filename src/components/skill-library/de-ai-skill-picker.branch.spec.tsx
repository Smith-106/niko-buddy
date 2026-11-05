// @vitest-environment jsdom
/**
 * de-ai-skill-picker 分支覆盖补齐（Ralph 覆盖率战役）。
 * 只增补：覆盖既有 spec 未走到的条件分支另一侧，每例均断言可观察行为。
 */
import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import type { DeAiSkill } from "@/lib/novel"
import { DeAiSkillOptionsPanel, DeAiSkillPicker } from "./de-ai-skill-picker"

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const readFileMock = vi.hoisted(() => vi.fn())
const joinMock = vi.hoisted(() => vi.fn(async (...parts: string[]) => parts.join("/")))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: readFileMock,
    writeFile: vi.fn(),
  }
})

vi.mock("@tauri-apps/api/path", () => ({
  join: joinMock,
}))

async function renderPicker(onChange = vi.fn(), props: Partial<ComponentProps<typeof DeAiSkillPicker>> = {}) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<DeAiSkillPicker value="built-in:comprehensive" onChange={onChange} {...props} />)
  })
  return { container, root, onChange }
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function cleanup(root: Root, container: HTMLElement) {
  act(() => root.unmount())
  document.body.removeChild(container)
}

function skillOf(id: string, name: string, description = "描述"): DeAiSkill {
  return { id, name, description, templateId: "t", content: "c", source: "built-in" }
}

async function renderPanel(props: Partial<ComponentProps<typeof DeAiSkillOptionsPanel>>) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <DeAiSkillOptionsPanel
        loading={false}
        errorMessage=""
        emptyMessage="暂无可用去AI味技能"
        skills={[skillOf("s-1", "技能一"), skillOf("s-2", "技能二")]}
        currentSkillId="s-1"
        defaultSkillId="s-2"
        onPick={vi.fn()}
        {...props}
      />,
    )
  })
  return { container, root }
}

describe("DeAiSkillPicker 分支补齐", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readFileMock.mockResolvedValue(JSON.stringify({
      version: 1,
      defaultSkillId: "built-in:comprehensive",
      disabledSkillIds: [],
      projectSkills: [],
      builtInSkillOverrides: [{
        id: "built-in:comprehensive",
        name: "综合去AI味-项目版",
        description: "当前项目规则",
        templateId: "comprehensive",
        content: "当前项目覆盖后的内置规则",
        source: "built-in",
        createdAt: 1000,
        updatedAt: 2000,
      }],
    }))
    useWikiStore.getState().setProject({ id: "p1", name: "测试项目", path: "C:/project" })
  })

  it("无 currentSkillId 时首选项自动聚焦", async () => {
    const { container, root } = await renderPanel({ currentSkillId: null })
    const options = container.querySelectorAll('[role="option"]')
    expect(options).toHaveLength(2)
    expect(options[0]!.getAttribute("aria-selected")).toBe("true")
    expect(options[0]!.textContent).toContain("技能一")
    cleanup(root, container)
  })

  it("非导航键直接返回（不触发选择）", async () => {
    const onPick = vi.fn()
    const { container, root } = await renderPanel({ onPick })
    const before = container.querySelector('[aria-selected="true"]')?.textContent
    await act(async () => {
      container.querySelector('[role="listbox"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))
    })
    expect(onPick).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe(before ?? null)
    cleanup(root, container)
  })

  it("ArrowUp 向上移动聚焦（回绕到末项）", async () => {
    const { container, root } = await renderPanel({})
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain("技能一")
    await act(async () => {
      container.querySelector('[role="listbox"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))
    })
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain("技能二")
    cleanup(root, container)
  })

  it("空描述技能不渲染描述行", async () => {
    const { container, root } = await renderPanel({
      skills: [{ ...skillOf("s-1", "无描述技能"), description: "" }],
      currentSkillId: "s-1",
    })
    const option = container.querySelector('[role="option"]')!
    expect(option.textContent).toContain("无描述技能")
    expect(option.querySelector(".truncate.text-xs")).toBeNull()
    cleanup(root, container)
  })

  it("buttonLabel=技能库 + iconOnly 时用技能库选择描述", async () => {
    const { container, root } = await renderPicker(vi.fn(), { iconOnly: true, buttonLabel: "技能库" })
    await flushEffects()
    const button = container.querySelector<HTMLButtonElement>("button")!
    expect(button.title).toBe("技能库：选择去AI味技能。点击打开技能选择")
    expect(button.getAttribute("aria-label")).toBe("技能库：选择去AI味技能。点击打开技能选择")
    cleanup(root, container)
  })

  it("自定义 buttonLabel 显示在触发器上", async () => {
    const { container, root } = await renderPicker(vi.fn(), { buttonLabel: "自定义标签" })
    await flushEffects()
    expect(container.querySelector<HTMLButtonElement>("button")?.textContent).toContain("自定义标签")
    cleanup(root, container)
  })

  it("无 buttonLabel 且技能未启用时显示去AI味兜底", async () => {
    const { container, root } = await renderPicker(vi.fn(), { value: null })
    await flushEffects()
    const button = container.querySelector<HTMLButtonElement>("button")!
    expect(button.textContent).toBe("去AI味")
    expect(button.title).toBe("当前去AI味技能：未启用")
    cleanup(root, container)
  })

  it("弹出层内 mousedown 不关闭", async () => {
    const { container, root } = await renderPicker()
    await flushEffects()
    const button = container.querySelector<HTMLButtonElement>("button")!
    await act(async () => {
      button.click()
    })
    const popover = container.querySelector('[data-testid="de-ai-skill-picker-popover"]')!
    expect(popover.textContent).toContain("当前项目规则")
    await act(async () => {
      popover.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    })
    expect(container.querySelector('[data-testid="de-ai-skill-picker-popover"]')).not.toBeNull()
    cleanup(root, container)
  })

  it("已展开时再次点击触发器关闭", async () => {
    const { container, root } = await renderPicker()
    await flushEffects()
    const button = container.querySelector<HTMLButtonElement>("button")!
    await act(async () => {
      button.click()
    })
    expect(container.querySelector('[data-testid="de-ai-skill-picker-popover"]')).not.toBeNull()
    await act(async () => {
      button.click()
    })
    expect(container.querySelector('[data-testid="de-ai-skill-picker-popover"]')).toBeNull()
    cleanup(root, container)
  })

  it("includeDisableOption=false 时不渲染关闭项", async () => {
    const { container, root } = await renderPicker(vi.fn(), { includeDisableOption: false })
    await flushEffects()
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click()
    })
    expect(container.querySelector('[data-testid="de-ai-skill-picker-popover"]')).not.toBeNull()
    expect(container.textContent).not.toContain("关闭去AI味技能")
    cleanup(root, container)
  })

  it("零视口 + 低位锚点走 bottom 定位分支", async () => {
    const { container, root } = await renderPicker()
    await flushEffects()
    const button = container.querySelector<HTMLButtonElement>("button")!
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      left: 10, top: 400, bottom: 420, right: 110, x: 10, y: 400, width: 100, height: 20, toJSON: () => ({}),
    })
    const origWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")
    const origHeight = Object.getOwnPropertyDescriptor(window, "innerHeight")
    Object.defineProperty(window, "innerWidth", { value: 0, configurable: true })
    Object.defineProperty(window, "innerHeight", { value: 0, configurable: true })
    try {
      await act(async () => {
        button.click()
      })
      const popover = container.querySelector<HTMLElement>('[data-testid="de-ai-skill-picker-popover"]')!
      expect(popover.style.left).toBe("8px")
      expect(popover.style.bottom).toBe("8px")
    } finally {
      if (origWidth) Object.defineProperty(window, "innerWidth", origWidth)
      if (origHeight) Object.defineProperty(window, "innerHeight", origHeight)
      cleanup(root, container)
    }
  })
})
