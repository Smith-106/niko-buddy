// @vitest-environment jsdom

import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { DeAiSkillOptionsPanel, DeAiSkillPicker } from "./de-ai-skill-picker"
import { useDeAiSkillOptions } from "./use-de-ai-skill-options"

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

function SkillOptionsProbe() {
  const options = useDeAiSkillOptions({
    projectPath: "C:/project",
    selectedSkillId: undefined,
    useLastChapterSkill: true,
  })
  return (
    <div>
      <span data-testid="effective-name">{options.effectiveName}</span>
      <span data-testid="current-id">{options.currentSkillId}</span>
      <span data-testid="default-id">{options.defaultSkillId}</span>
    </div>
  )
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

describe("DeAiSkillPicker", () => {
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
    useWikiStore.getState().setProject({
      id: "p1",
      name: "测试项目",
      path: "C:/project",
    })
  })

  it("shows the effective de-AI skill", async () => {
    const { container, root } = await renderPicker()

    const button = container.querySelector<HTMLButtonElement>("button")
    expect(button?.textContent).toContain("去AI味：综合去AI味-项目版")
    expect(button?.title).toBe("当前去AI味技能：综合去AI味-项目版")

    await act(async () => {
      button?.click()
    })

    expect(container.textContent).not.toContain("已修改")

    cleanup(root, container)
  })

  it("reloads skills after the skill library data version changes", async () => {
    const { container, root } = await renderPicker()
    await flushEffects()
    expect(container.querySelector<HTMLButtonElement>("button")?.textContent).toContain("综合去AI味-项目版")

    readFileMock.mockResolvedValue(JSON.stringify({
      version: 1,
      defaultSkillId: "built-in:comprehensive",
      disabledSkillIds: [],
      projectSkills: [],
      builtInSkillOverrides: [{
        id: "built-in:comprehensive",
        name: "综合去AI味-新版",
        description: "当前项目新规则",
        templateId: "comprehensive",
        content: "新的项目覆盖规则",
        source: "built-in",
        createdAt: 1000,
        updatedAt: 3000,
      }],
    }))

    await act(async () => {
      useWikiStore.getState().bumpDataVersion()
    })
    await flushEffects()

    expect(container.querySelector<HTMLButtonElement>("button")?.textContent).toContain("综合去AI味-新版")

    cleanup(root, container)
  })

  it("shows a recovery hint when the skill config is corrupt", async () => {
    readFileMock.mockResolvedValue("{bad json")
    const { container, root } = await renderPicker()
    await flushEffects()

    const button = container.querySelector<HTMLButtonElement>("button")
    expect(button?.textContent).toContain("去AI味：配置损坏")
    expect(button?.title).toBe("当前去AI味技能：配置损坏")

    await act(async () => {
      button?.click()
    })

    expect(container.textContent).toContain("技能库配置文件损坏，请到技能库恢复配置")

    cleanup(root, container)
  })

  it("renders shared option list states for chapter and chat entries", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <DeAiSkillOptionsPanel
          loading={false}
          errorMessage=""
          emptyMessage="暂无可用去AI味技能"
          skills={[{
            id: "built-in:comprehensive",
            name: "综合去AI味-项目版",
            description: "当前项目规则",
            templateId: "comprehensive",
            content: "当前项目覆盖后的内置规则",
            source: "built-in",
          }]}
          currentSkillId="built-in:comprehensive"
          defaultSkillId="built-in:comprehensive"
          onPick={vi.fn()}
        />,
      )
    })

    expect(container.textContent).toContain("综合去AI味-项目版")
    expect(container.textContent).toContain("当前")
    expect(container.textContent).toContain("默认")
    expect(container.textContent).not.toContain("已修改")

    await act(async () => {
      root.render(
        <DeAiSkillOptionsPanel
          loading={false}
          errorMessage="技能库配置文件损坏，请到技能库恢复配置"
          emptyMessage="暂无可用去AI味技能"
          skills={[]}
          currentSkillId={null}
          defaultSkillId={null}
          onPick={vi.fn()}
        />,
      )
    })

    expect(container.textContent).toContain("技能库配置文件损坏，请到技能库恢复配置")

    cleanup(root, container)
  })

  it("loads shared de-AI skill option state with last chapter skill fallback", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({
      version: 1,
      defaultSkillId: "built-in:comprehensive",
      disabledSkillIds: [],
      projectSkills: [],
      builtInSkillOverrides: [],
      lastChapterDeAiSkillId: "built-in:dialogue-natural",
    }))
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<SkillOptionsProbe />)
    })
    await flushEffects()

    expect(container.querySelector('[data-testid="effective-name"]')?.textContent).toContain("对话口语化")
    expect(container.querySelector('[data-testid="current-id"]')?.textContent).toBe("built-in:dialogue-natural")
    expect(container.querySelector('[data-testid="default-id"]')?.textContent).toBe("built-in:comprehensive")

    cleanup(root, container)
  })

  it("closes the picker with Escape and outside click", async () => {
    const { container, root } = await renderPicker()
    await flushEffects()
    const button = container.querySelector<HTMLButtonElement>("button")

    await act(async () => {
      button?.click()
    })
    expect(container.textContent).toContain("当前项目规则")

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(container.textContent).not.toContain("当前项目规则")

    await act(async () => {
      button?.click()
    })
    expect(container.textContent).toContain("当前项目规则")

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    })
    expect(container.textContent).not.toContain("当前项目规则")

    cleanup(root, container)
  })

  it("highlights the current option and supports keyboard pick", async () => {
    const onChange = vi.fn()
    const { container, root } = await renderPicker(onChange)
    await flushEffects()
    const button = container.querySelector<HTMLButtonElement>("button")

    await act(async () => {
      button?.click()
    })

    expect(container.querySelector('[aria-current="true"]')?.textContent).toContain("综合去AI味-项目版")

    await act(async () => {
      container
        .querySelector('[role="listbox"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    })
    await act(async () => {
      container
        .querySelector('[role="listbox"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    })

    expect(onChange).toHaveBeenCalledWith("built-in:reduce-explanation")

    cleanup(root, container)
  })

  it("focuses the option list after opening the picker", async () => {
    const { container, root } = await renderPicker()
    await flushEffects()
    const button = container.querySelector<HTMLButtonElement>("button")

    await act(async () => {
      button?.click()
    })
    await flushEffects()

    expect(document.activeElement).toBe(container.querySelector('[role="listbox"]'))

    cleanup(root, container)
  })

  it("anchors the option panel with fixed positioning so overflow toolbars do not clip it", async () => {
    const { container, root } = await renderPicker()
    await flushEffects()
    const button = container.querySelector<HTMLButtonElement>("button")

    await act(async () => {
      button?.click()
    })

    const popover = container.querySelector<HTMLElement>('[data-testid="de-ai-skill-picker-popover"]')
    expect(popover?.className).toContain("fixed")
    expect(popover?.style.left).not.toBe("")

    cleanup(root, container)
  })

  it("can render as an icon-only trigger while keeping hover and accessible descriptions", async () => {
    const { container, root } = await renderPicker(vi.fn(), { iconOnly: true })
    await flushEffects()
    const button = container.querySelector<HTMLButtonElement>("button")

    expect(button?.textContent).not.toContain("去AI味")
    expect(button?.textContent).not.toContain("综合去AI味")
    expect(button?.title).toBe("当前去AI味技能：综合去AI味-项目版。点击选择去AI味技能")
    expect(button?.getAttribute("aria-label")).toBe("当前去AI味技能：综合去AI味-项目版。点击选择去AI味技能")

    cleanup(root, container)
  })
})

describe("DeAiSkillPicker / 覆盖补齐", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readFileMock.mockResolvedValue(JSON.stringify({
      version: 1,
      defaultSkillId: "built-in:comprehensive",
      disabledSkillIds: [],
      projectSkills: [],
      builtInSkillOverrides: [],
    }))
    useWikiStore.getState().setProject({
      id: "p1",
      name: "测试项目",
      path: "C:/project",
    })
  })

  const panelSkills = [
    {
      id: "built-in:comprehensive",
      name: "综合去AI味",
      description: "综合规则",
      templateId: "comprehensive",
      content: "规则正文",
      source: "built-in" as const,
    },
    {
      id: "built-in:dialogue-natural",
      name: "对话口语化",
      description: "对白规则",
      templateId: "dialogue-natural",
      content: "对白正文",
      source: "built-in" as const,
    },
  ]

  async function renderPanel(props: Partial<ComponentProps<typeof DeAiSkillOptionsPanel>> = {}) {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    const onPick = vi.fn()
    const onClose = vi.fn()
    await act(async () => {
      root.render(
        <DeAiSkillOptionsPanel
          loading={false}
          errorMessage=""
          emptyMessage="暂无可用去AI味技能"
          skills={panelSkills}
          currentSkillId="built-in:comprehensive"
          defaultSkillId="built-in:comprehensive"
          onPick={onPick}
          onClose={onClose}
          {...props}
        />,
      )
    })
    return { container, root, onPick, onClose }
  }

  it("renders the loading state while skills are being read", async () => {
    const { container, root } = await renderPanel({ loading: true, skills: [] })
    expect(container.textContent).toContain("正在读取技能...")
    expect(container.querySelector('[role="listbox"]')).toBeNull()
    cleanup(root, container)
  })

  it("renders the empty message when no skills are available", async () => {
    const { container, root } = await renderPanel({ skills: [] })
    expect(container.textContent).toContain("暂无可用去AI味技能")
    expect(container.querySelector('[role="listbox"]')).toBeNull()
    cleanup(root, container)
  })

  it("closes the option list on Escape", async () => {
    const { container, root, onClose, onPick } = await renderPanel()
    await act(async () => {
      container
        .querySelector('[role="listbox"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()
    cleanup(root, container)
  })

  it("supports mouse hover focus and click pick", async () => {
    const { container, root, onPick } = await renderPanel()
    const options = Array.from(container.querySelectorAll('[role="option"]'))
    expect(options).toHaveLength(2)

    const { fireEvent } = await import("@testing-library/react")
    await act(async () => {
      fireEvent.mouseEnter(options[1])
    })
    expect(options[1].getAttribute("aria-selected")).toBe("true")

    await act(async () => {
      fireEvent.click(options[1])
    })
    expect(onPick).toHaveBeenCalledWith("built-in:dialogue-natural")
    cleanup(root, container)
  })

  it("anchors below the trigger when the trigger sits above the fold midpoint", async () => {
    const { container, root } = await renderPicker()
    await flushEffects()
    const button = container.querySelector<HTMLButtonElement>("button")
    expect(button).not.toBeNull()

    await act(async () => {
      button?.click()
    })
    const popover = container.querySelector<HTMLElement>('[data-testid="de-ai-skill-picker-popover"]')
    // jsdom rect.top is 0 (<= 320) so the panel opens below the anchor
    expect(popover?.style.top).not.toBe("")
    expect(popover?.style.bottom).toBe("")
    cleanup(root, container)
  })

  it("anchors above the trigger when the trigger sits low on screen", async () => {
    const { container, root } = await renderPicker()
    await flushEffects()
    const button = container.querySelector<HTMLButtonElement>("button")
    expect(button).not.toBeNull()
    const rect = {
      x: 10, y: 500, width: 32, height: 32,
      top: 500, right: 42, bottom: 532, left: 10,
      toJSON: () => ({}),
    } as DOMRect
    vi.spyOn(button!, "getBoundingClientRect").mockReturnValue(rect)

    await act(async () => {
      button?.click()
    })
    const popover = container.querySelector<HTMLElement>('[data-testid="de-ai-skill-picker-popover"]')
    // rect.top (500) > 320 so the panel opens above the anchor via bottom offset
    expect(popover?.style.bottom).not.toBe("")
    expect(popover?.style.top).toBe("")
    cleanup(root, container)
  })

  it("closes the popover and notifies when the disable option is clicked", async () => {
    const onChange = vi.fn()
    const { container, root } = await renderPicker(onChange)
    await flushEffects()
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click()
    })
    expect(container.querySelector('[data-testid="de-ai-skill-picker-popover"]')).not.toBeNull()

    await act(async () => {
      const { fireEvent } = await import("@testing-library/react")
      const disableButton = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("关闭去AI味技能"),
      )
      expect(disableButton).toBeTruthy()
      fireEvent.click(disableButton!)
    })
    expect(onChange).toHaveBeenCalledWith(null)
    expect(container.querySelector('[data-testid="de-ai-skill-picker-popover"]')).toBeNull()
    cleanup(root, container)
  })

  it("opens the full skill library from the shortcut entry", async () => {
    const { container, root } = await renderPicker(vi.fn(), { showLibraryShortcut: true })
    await flushEffects()
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click()
    })

    await act(async () => {
      const { fireEvent } = await import("@testing-library/react")
      const shortcut = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("打开完整技能库"),
      )
      expect(shortcut).toBeTruthy()
      fireEvent.click(shortcut!)
    })
    expect(useWikiStore.getState().activeView).toBe("writingSkillLibrary")
    expect(container.querySelector('[data-testid="de-ai-skill-picker-popover"]')).toBeNull()
    cleanup(root, container)
  })

  it("closes the popover on panel Escape via the wired onClose", async () => {
    const { container, root } = await renderPicker()
    await flushEffects()
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click()
    })
    expect(container.querySelector('[data-testid="de-ai-skill-picker-popover"]')).not.toBeNull()

    await act(async () => {
      container
        .querySelector('[role="listbox"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(container.querySelector('[data-testid="de-ai-skill-picker-popover"]')).toBeNull()
    cleanup(root, container)
  })
})
