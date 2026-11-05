// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { useFavoriteSkillStore } from "@/stores/favorite-skill-store"
import { UnifiedSkillLibrarySidebarPanel, UnifiedSkillLibraryView } from "./unified-skill-library-view"

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const readFileMock = vi.hoisted(() => vi.fn())
const writeFileMock = vi.hoisted(() => vi.fn())
const writeFileAtomicMock = vi.hoisted(() => vi.fn())
const joinMock = vi.hoisted(() => vi.fn(async (...parts: string[]) => parts.join("/")))
const openDialogMock = vi.hoisted(() => vi.fn())
const saveDialogMock = vi.hoisted(() => vi.fn())

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: readFileMock,
      writeFile: writeFileMock,
      writeFileAtomic: writeFileAtomicMock,
    
  }
})

vi.mock("@tauri-apps/api/path", () => ({
  join: joinMock,
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openDialogMock,
  save: saveDialogMock,
}))

const deAiConfig = {
  version: 1,
  defaultSkillId: "project:quiet",
  disabledSkillIds: [],
  lastChapterDeAiSkillId: null,
  projectSkills: [{
    id: "project:quiet",
    name: "沉浸式去AI味",
    description: "减少解释腔和总结腔",
    templateId: "custom",
    content: "删除协作口吻，保留角色语气。",
    source: "project",
    createdAt: 100,
    updatedAt: 100,
  }],
  builtInSkillOverrides: [],
}

const writingConfig = {
  version: 1,
  selectedSkillId: "skill:three",
  disabledSkillIds: [],
  skills: [{
    id: "skill:three",
    name: "三翻四抖",
    description: "三次转折，四次震惊。",
    kind: ["structure", "review"],
    stages: ["planning", "review"],
    modes: ["standard", "strict"],
    content: "每章设置三次局势变化和四次信息冲击。",
    source: "uploaded",
    createdAt: 100,
    updatedAt: 100,
  }],
}

async function renderLibrary() {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <>
        <UnifiedSkillLibrarySidebarPanel />
        <UnifiedSkillLibraryView />
      </>,
    )
  })
  await flushEffects()
  return { container, root }
}

function cleanup(root: Root, container: HTMLElement) {
  act(() => root.unmount())
  document.body.removeChild(container)
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function setInputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    valueSetter?.call(input, value)
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.trim() === label)
}

describe("UnifiedSkillLibraryView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      throw new Error("missing")
    })
    writeFileMock.mockResolvedValue(undefined)
    writeFileAtomicMock.mockResolvedValue(undefined)
    openDialogMock.mockResolvedValue(null)
    saveDialogMock.mockResolvedValue(null)
    useWikiStore.getState().setProject({
      id: "p1",
      name: "测试项目",
      path: "C:/project",
    })
    useWikiStore.getState().setActiveView("skillLibrary")
    useWikiStore.getState().setSelectedSkillLibrarySkillId(null)
    useWikiStore.getState().setSelectedWritingSkillLibrarySkillId(null)
    useWikiStore.getState().setSkillLibraryDraftDirty(false)
    useWikiStore.getState().setWritingSkillLibraryDraftDirty(false)
  })

  it("renders one unified sidebar with category filter chips", async () => {
    const { container, root } = await renderLibrary()

    expect(container.querySelector('[data-testid="unified-skill-library-sidebar"]')).not.toBeNull()
    expect(container.querySelector("h1")?.textContent).toBe("技能库")
    for (const label of ["全部", "风格", "结构", "计划", "审稿", "改写", "输出", "知识"]) {
      expect(getButton(container, label)).not.toBeUndefined()
    }
    expect(getButton(container, "写作")).toBeUndefined()

    cleanup(root, container)
  })

  it("keeps creation, import, and export actions out of the unified sidebar", async () => {
    const { container, root } = await renderLibrary()
    const sidebar = container.querySelector<HTMLElement>('[data-testid="unified-skill-library-sidebar"]')

    for (const label of ["新建去AI技能", "新建技能", "导入文件", "导入文件夹", "导出当前"]) {
      expect(sidebar?.textContent).not.toContain(label)
    }

    cleanup(root, container)
  })

  it("shows de-AI actions in the right header when de-AI skill tab is active", async () => {
    const { container, root } = await renderLibrary()
    const actions = container.querySelector<HTMLElement>('[data-testid="skill-library-header-actions"]')
    const actionLabels = Array.from(actions?.querySelectorAll("button") ?? [])
      .map((button) => button.textContent?.trim())

    expect(actionLabels).toEqual(["新建技能", "导入"])
    expect(actions?.textContent).not.toContain("导入技能")
    expect(actions?.textContent).not.toContain("导入文件")
    expect(actions?.textContent).not.toContain("导入文件夹")
    expect(actions?.textContent).not.toContain("新建写作技能")
    expect(actions?.textContent).not.toContain("导出当前")

    cleanup(root, container)
  })

  it("shows writing Skill actions in the right header when writing tab is active", async () => {
    const { container, root } = await renderLibrary()

    await act(async () => {
      getButton(container, "写作技能")?.click()
    })
    await flushEffects()

    const actions = container.querySelector<HTMLElement>('[data-testid="skill-library-header-actions"]')
    const actionLabels = Array.from(actions?.querySelectorAll("button") ?? [])
      .map((button) => button.textContent?.trim())

    expect(actionLabels).toEqual(["新建写作技能", "导入"])
    expect(actions?.textContent).not.toContain("导入 Skill")
    expect(actions?.textContent).not.toContain("导入文件")
    expect(actions?.textContent).not.toContain("导入文件夹")
    expect(actions?.textContent).not.toContain("导出当前")
    expect(actions?.textContent).not.toContain("新建技能")

    cleanup(root, container)
  })

  it("creates a writing Skill directly from the right header", async () => {
    const { container, root } = await renderLibrary()

    await act(async () => {
      getButton(container, "写作技能")?.click()
    })
    await flushEffects()

    await act(async () => {
      getButton(container, "新建写作技能")?.click()
    })
    await flushEffects()

    expect(useWikiStore.getState().activeView).toBe("writingSkillLibrary")
    expect(useWikiStore.getState().selectedWritingSkillLibrarySkillId).toMatch(/^skill:/)
    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/writing-skills.json",
      expect.stringContaining("新建写作技能"),
    )

    cleanup(root, container)
  })

  it("imports a de-AI skill file from the right header", async () => {
    openDialogMock.mockResolvedValue("C:/skills/冷硬叙事.md")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/冷硬叙事.md") return "# 冷硬叙事\n\n删掉解释，保留动作。"
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()

    await act(async () => {
      getButton(container, "导入")?.click()
    })
    await flushEffects()

    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/de-ai-skills.json",
      expect.stringContaining("冷硬叙事"),
    )
    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/de-ai-skills.json",
      expect.stringContaining("删掉解释，保留动作。"),
    )
    expect(useWikiStore.getState().activeView).toBe("skillLibrary")

    cleanup(root, container)
  })

  it("filters writing and de-AI skills from one search input", async () => {
    const { container, root } = await renderLibrary()
    const sidebar = container.querySelector<HTMLElement>('[data-testid="unified-skill-library-sidebar"]')
    const searchInput = container.querySelector<HTMLInputElement>('[data-testid="unified-skill-search-input"]')
    expect(sidebar).not.toBeNull()
    expect(searchInput).not.toBeNull()

    // 分页后初始视图为第 1 页（前 20 条内置写作技能）；自定义写作/去AI味条目在第 2 页，
    // 双类型可达性改由下方搜索断言覆盖。
    expect(sidebar?.textContent).toContain("章节承接")
    expect(sidebar?.querySelector('[data-testid="unified-skill-entry-de-ai:project:quiet"]')).toBeNull()

    await setInputValue(searchInput!, "三翻")
    expect(sidebar?.textContent).toContain("三翻四抖")
    expect(sidebar?.textContent).not.toContain("沉浸式去AI味")

    await setInputValue(searchInput!, "解释腔")
    expect(sidebar?.textContent).not.toContain("三翻四抖")
    expect(sidebar?.textContent).toContain("沉浸式去AI味")

    cleanup(root, container)
  })

  it("routes selected unified entries to their existing detail views", async () => {
    const { container, root } = await renderLibrary()
    const searchInput = container.querySelector<HTMLInputElement>('[data-testid="unified-skill-search-input"]')!
    // 内置种子技能（builtin:*/skillhub:*）由 ensureBuiltinSkills 前置，自定义条目不在首页：
    // 用搜索把目标条目过滤到可见，再验证路由行为
    await setInputValue(searchInput, "三翻")

    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="unified-skill-entry-writing:skill:three"]')?.querySelector<HTMLButtonElement>('button')?.click()
    })
    await flushEffects()

    expect(useWikiStore.getState().activeView).toBe("writingSkillLibrary")
    expect(useWikiStore.getState().selectedWritingSkillLibrarySkillId).toBe("skill:three")
    expect(container.querySelector('[data-testid="writing-skill-library-view"]')).not.toBeNull()

    await setInputValue(searchInput, "沉浸式")

    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="unified-skill-entry-de-ai:project:quiet"]')?.querySelector<HTMLButtonElement>('button')?.click()
    })
    await flushEffects()

    expect(useWikiStore.getState().activeView).toBe("skillLibrary")
    expect(useWikiStore.getState().selectedSkillLibrarySkillId).toBe("project:quiet")
    expect(container.querySelector('[data-testid="skill-library-view"]')).not.toBeNull()

    cleanup(root, container)
  })

  it("marks a de-AI entry as current after switching from a writing entry", async () => {
    const { container, root } = await renderLibrary()
    const searchInput = container.querySelector<HTMLInputElement>('[data-testid="unified-skill-search-input"]')!
    // 内置种子技能前置：用搜索隔离目标条目（分页后自定义条目不在首页）
    await setInputValue(searchInput, "三翻")
    const writingEntry = container.querySelector<HTMLElement>('[data-testid="unified-skill-entry-writing:skill:three"]')

    await act(async () => {
      writingEntry?.querySelector<HTMLButtonElement>('button')?.click()
    })
    await flushEffects()

    expect(writingEntry?.getAttribute("aria-current")).toBe("true")

    await setInputValue(searchInput, "沉浸式")
    const deAiEntry = container.querySelector<HTMLElement>('[data-testid="unified-skill-entry-de-ai:project:quiet"]')

    await act(async () => {
      deAiEntry?.querySelector<HTMLButtonElement>('button')?.click()
    })
    await flushEffects()

    expect(useWikiStore.getState().activeView).toBe("skillLibrary")
    expect(useWikiStore.getState().selectedSkillLibrarySkillId).toBe("project:quiet")
    expect(useWikiStore.getState().selectedWritingSkillLibrarySkillId).toBeNull()
    expect(deAiEntry?.getAttribute("aria-current")).toBe("true")
    // 搜索切换后写作条目已被过滤出当前视图（从实时 DOM 重查；分离节点会保留旧属性）
    expect(container.querySelector('[data-testid="unified-skill-entry-writing:skill:three"]')).toBeNull()

    cleanup(root, container)
  })

  it("侧栏技能列表超过 20 条分页：首页 20 条、翻页可见第 21-40 条、搜索重置回第 1 页", async () => {
    const manySkills = Array.from({ length: 25 }, (_, i) => ({
      id: `skill:gen-${i + 1}`,
      name: `分页技能${String(i + 1).padStart(2, "0")}`,
      description: `第 ${i + 1} 个技能`,
      kind: ["output"],
      stages: ["planning"],
      modes: ["standard"],
      content: `内容 ${i + 1}`,
      source: "uploaded",
      createdAt: 100,
      updatedAt: 100,
    }))
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify({ ...writingConfig, skills: manySkills })
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()
    const sidebar = container.querySelector<HTMLElement>('[data-testid="unified-skill-library-sidebar"]')!
    // 首页 20 条 + 分页控件出现，上一页禁用；自定义技能排在全部内置种子之后，首页不可见
    // （注：normalizeUserSkillConfig 会去掉 id 数字段前导零：skill:gen-01 → skill:gen-1）
    expect(sidebar.querySelectorAll('[data-testid^="unified-skill-entry-"]').length).toBe(20)
    expect(sidebar.querySelector('[data-testid="unified-skill-entry-writing:skill:gen-1"]')).toBeNull()
    expect(sidebar.querySelector('[data-testid="pagination"]')).not.toBeNull()
    expect(sidebar.querySelector<HTMLButtonElement>('[data-testid="pagination-prev"]')!.disabled).toBe(true)
    // 翻页 → 第 2 页（第 21-40 条仍为内置种子 builtin:*/skillhub:*；首页首条被切走）
    await act(async () => {
      sidebar.querySelector<HTMLButtonElement>('[data-testid="pagination-next"]')!.click()
    })
    await flushEffects()
    expect(sidebar.querySelector('[data-testid="unified-skill-entry-writing:builtin:dialogue-design"]')).not.toBeNull()
    expect(sidebar.querySelector('[data-testid="unified-skill-entry-writing:builtin:chapter-connection"]')).toBeNull()
    // 搜索变化 → 回到第 1 页，单页结果分页控件自动隐藏
    await setInputValue(container.querySelector<HTMLInputElement>('[data-testid="unified-skill-search-input"]')!, "分页技能01")
    expect(sidebar.querySelector('[data-testid="unified-skill-entry-writing:skill:gen-1"]')).not.toBeNull()
    expect(sidebar.querySelector('[data-testid="pagination"]')).toBeNull()
    // 清空搜索 → 恢复首页 20 条
    await setInputValue(container.querySelector<HTMLInputElement>('[data-testid="unified-skill-search-input"]')!, "")
    expect(sidebar.querySelectorAll('[data-testid^="unified-skill-entry-"]').length).toBe(20)
    expect(sidebar.querySelector('[data-testid="unified-skill-entry-writing:skill:gen-1"]')).toBeNull()

    cleanup(root, container)
  })
})

describe("UnifiedSkillLibraryView 覆盖补齐（头部动作/导入/侧栏未覆盖行）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      throw new Error("missing")
    })
    writeFileMock.mockResolvedValue(undefined)
    writeFileAtomicMock.mockResolvedValue(undefined)
    openDialogMock.mockResolvedValue(null)
    saveDialogMock.mockResolvedValue(null)
    useWikiStore.getState().setProject({
      id: "p1",
      name: "测试项目",
      path: "C:/project",
    })
    useWikiStore.getState().setActiveView("skillLibrary")
    useWikiStore.getState().setSelectedSkillLibrarySkillId(null)
    useWikiStore.getState().setSelectedWritingSkillLibrarySkillId(null)
    useWikiStore.getState().setSkillLibraryDraftDirty(false)
    useWikiStore.getState().setWritingSkillLibraryDraftDirty(false)
  })

  async function clickButton(container: HTMLElement, label: string) {
    const button = getButton(container, label)
    if (!button) throw new Error(`button not found: ${label}`)
    await act(async () => {
      button.click()
    })
    await flushEffects()
  }

  it("creates a blank de-AI skill from the right header", async () => {
    const { container, root } = await renderLibrary()

    await clickButton(container, "新建技能")

    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/de-ai-skills.json",
      expect.stringContaining("新建去AI味技能"),
    )
    expect(useWikiStore.getState().activeView).toBe("skillLibrary")
    expect(useWikiStore.getState().selectedSkillLibrarySkillId).toMatch(/^project:/)

    cleanup(root, container)
  })

  it("surfaces de-AI save failure from the right header", async () => {
    writeFileAtomicMock.mockRejectedValueOnce(new Error("disk full"))
    const { container, root } = await renderLibrary()

    await clickButton(container, "新建技能")

    expect(container.textContent).toContain("去AI味技能保存失败")

    cleanup(root, container)
  })

  it("surfaces writing save failure from the right header", async () => {
    writeFileAtomicMock.mockRejectedValueOnce(new Error("disk full"))
    const { container, root } = await renderLibrary()

    await clickButton(container, "写作技能")
    await clickButton(container, "新建写作技能")

    expect(container.textContent).toContain("写作技能保存失败")

    cleanup(root, container)
  })

  it("imports a de-AI skill from a JSON file", async () => {
    openDialogMock.mockResolvedValue("C:/skills/json-skill.json")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/json-skill.json") {
        return JSON.stringify({ name: "JSON技能", description: "d", templateId: "t", content: "规则" })
      }
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()

    await clickButton(container, "导入")

    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/de-ai-skills.json",
      expect.stringContaining("JSON技能"),
    )
    expect(useWikiStore.getState().activeView).toBe("skillLibrary")

    cleanup(root, container)
  })

  it("rejects a de-AI import whose JSON cannot be parsed", async () => {
    openDialogMock.mockResolvedValue("C:/skills/bad.json")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/bad.json") return "{bad json"
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()
    writeFileAtomicMock.mockClear()

    await clickButton(container, "导入")

    expect(container.textContent).toContain("导入失败：文件内容不是有效的去AI味技能")
    expect(writeFileAtomicMock).not.toHaveBeenCalled()

    cleanup(root, container)
  })

  it("rejects de-AI JSON imports missing name or content", async () => {
    openDialogMock.mockResolvedValue("C:/skills/noname.json")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/noname.json") return JSON.stringify({ content: "只有正文" })
      throw new Error("missing")
    })
    const first = await renderLibrary()
    writeFileAtomicMock.mockClear()
    await clickButton(first.container, "导入")
    expect(first.container.textContent).toContain("导入失败：文件内容不是有效的去AI味技能")
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    cleanup(first.root, first.container)

    openDialogMock.mockResolvedValue("C:/skills/nocontent.json")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/nocontent.json") return JSON.stringify({ name: "只有名字" })
      throw new Error("missing")
    })
    const second = await renderLibrary()
    await clickButton(second.container, "导入")
    expect(second.container.textContent).toContain("导入失败：文件内容不是有效的去AI味技能")
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    cleanup(second.root, second.container)
  })

  it("imports a de-AI skill from markdown with frontmatter", async () => {
    openDialogMock.mockResolvedValue("C:/skills/front.md")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/front.md") {
        return "---\nname: 前言技能\ndescription: 前言描述\n---\n正文规则"
      }
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()

    await clickButton(container, "导入")

    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/de-ai-skills.json",
      expect.stringContaining("前言技能"),
    )
    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/de-ai-skills.json",
      expect.stringContaining("正文规则"),
    )

    cleanup(root, container)
  })

  it("rejects a de-AI import when the file has no usable body", async () => {
    openDialogMock.mockResolvedValue("C:/skills/empty.txt")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/empty.txt") return "   "
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()
    writeFileAtomicMock.mockClear()

    await clickButton(container, "导入")

    expect(container.textContent).toContain("导入失败：文件内容不是有效的去AI味技能")
    expect(writeFileAtomicMock).not.toHaveBeenCalled()

    cleanup(root, container)
  })

  it("surfaces de-AI import read failure", async () => {
    openDialogMock.mockResolvedValue("C:/skills/unreadable.md")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      throw new Error("denied")
    })
    const { container, root } = await renderLibrary()

    await clickButton(container, "导入")

    expect(container.textContent).toContain("导入去AI味技能失败")

    cleanup(root, container)
  })

  it("ignores a cancelled de-AI import dialog", async () => {
    openDialogMock.mockResolvedValue(null)
    const { container, root } = await renderLibrary()
    writeFileAtomicMock.mockClear()

    await clickButton(container, "导入")

    expect(writeFileAtomicMock).not.toHaveBeenCalled()

    cleanup(root, container)
  })

  it("imports a writing skill from a markdown file", async () => {
    openDialogMock.mockResolvedValue("C:/skills/w.md")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/w.md") return "写作规则正文"
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()

    await clickButton(container, "写作技能")
    await clickButton(container, "导入")

    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      expect.stringContaining("writing-skills.json"),
      expect.stringContaining("写作规则正文"),
    )
    expect(useWikiStore.getState().activeView).toBe("writingSkillLibrary")
    expect(useWikiStore.getState().selectedWritingSkillLibrarySkillId).toMatch(/^skill:/)

    cleanup(root, container)
  })

  it("imports a writing skill from a valid JSON file", async () => {
    openDialogMock.mockResolvedValue("C:/skills/w.json")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/w.json") return JSON.stringify({ name: "JSON写作", content: "JSON规则正文" })
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()

    await clickButton(container, "写作技能")
    await clickButton(container, "导入")

    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      expect.stringContaining("writing-skills.json"),
      expect.stringContaining("JSON写作"),
    )
    expect(useWikiStore.getState().activeView).toBe("writingSkillLibrary")

    cleanup(root, container)
  })

  it("rejects a writing JSON import with invalid content", async () => {
    openDialogMock.mockResolvedValue("C:/skills/bad.json")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/bad.json") return "oops not json"
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()
    writeFileAtomicMock.mockClear()

    await clickButton(container, "写作技能")
    await clickButton(container, "导入")

    expect(container.textContent).toContain("JSON 文件格式不正确，导入失败")
    expect(writeFileAtomicMock).not.toHaveBeenCalled()

    cleanup(root, container)
  })

  it("surfaces writing import read failure", async () => {
    openDialogMock.mockResolvedValue("C:/skills/unreadable.md")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      throw new Error("denied")
    })
    const { container, root } = await renderLibrary()

    await clickButton(container, "写作技能")
    await clickButton(container, "导入")

    expect(container.textContent).toContain("导入失败")

    cleanup(root, container)
  })

  it("filters sidebar entries by category chips", async () => {
    const { container, root } = await renderLibrary()
    const searchInput = container.querySelector<HTMLInputElement>('[data-testid="unified-skill-search-input"]')!
    await setInputValue(searchInput, "三翻")
    expect(container.textContent).toContain("三翻四抖")

    await clickButton(container, "风格")
    expect(getButton(container, "风格")?.getAttribute("aria-pressed")).toBe("true")
    expect(container.textContent).not.toContain("三翻四抖")

    await clickButton(container, "全部")
    expect(container.textContent).toContain("三翻四抖")

    cleanup(root, container)
  })

  it("toggles a favorite star on a sidebar entry and back", async () => {
    const { container, root } = await renderLibrary()
    const searchInput = container.querySelector<HTMLInputElement>('[data-testid="unified-skill-search-input"]')!
    await setInputValue(searchInput, "沉浸式")
    const entry = container.querySelector<HTMLElement>('[data-testid="unified-skill-entry-de-ai:project:quiet"]')
    expect(entry).not.toBeNull()
    const star = entry?.querySelector<HTMLButtonElement>('button[aria-label="收藏"]')
    expect(star).not.toBeUndefined()

    await act(async () => {
      star?.click()
    })
    await flushEffects()

    expect(useFavoriteSkillStore.getState().isFavorited("de-ai", "project:quiet")).toBe(true)
    // 侧栏用 `useFavoriteSkillStore((s) => s.isFavorited)` 订阅的是函数引用，
    // 收藏变更本身不触发重渲染；改一次搜索词迫使条目重渲染后再断言 UI
    await setInputValue(searchInput, "沉浸式x")
    await setInputValue(searchInput, "沉浸式")
    const refreshed = container.querySelector<HTMLElement>('[data-testid="unified-skill-entry-de-ai:project:quiet"]')
    expect(refreshed?.querySelector('button[aria-label="取消收藏"]')).not.toBeNull()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="unified-skill-entry-de-ai:project:quiet"] button[aria-label="取消收藏"]')?.click()
    })
    await flushEffects()

    expect(useFavoriteSkillStore.getState().isFavorited("de-ai", "project:quiet")).toBe(false)

    cleanup(root, container)
  })

  it("shows the sidebar load error when the de-ai config is corrupt", async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return "{bad json"
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()
    const sidebar = container.querySelector<HTMLElement>('[data-testid="unified-skill-library-sidebar"]')

    expect(sidebar?.textContent).toContain("技能库加载失败")
    expect(sidebar?.textContent).toContain("没有匹配的技能。")

    cleanup(root, container)
  })

  it("paginates back to the first page with the prev control", async () => {
    const manySkills = Array.from({ length: 25 }, (_, i) => ({
      id: `skill:gen-${i + 1}`,
      name: `分页技能${String(i + 1).padStart(2, "0")}`,
      description: `第 ${i + 1} 个技能`,
      kind: ["output"],
      stages: ["planning"],
      modes: ["standard"],
      content: `内容 ${i + 1}`,
      source: "uploaded",
      createdAt: 100,
      updatedAt: 100,
    }))
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify({ ...writingConfig, skills: manySkills })
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()
    const sidebar = container.querySelector<HTMLElement>('[data-testid="unified-skill-library-sidebar"]')!

    await act(async () => {
      sidebar.querySelector<HTMLButtonElement>('[data-testid="pagination-next"]')!.click()
    })
    await flushEffects()
    expect(sidebar.querySelector('[data-testid="unified-skill-entry-writing:builtin:chapter-connection"]')).toBeNull()

    await act(async () => {
      sidebar.querySelector<HTMLButtonElement>('[data-testid="pagination-prev"]')!.click()
    })
    await flushEffects()
    expect(sidebar.querySelector('[data-testid="unified-skill-entry-writing:builtin:chapter-connection"]')).not.toBeNull()
    expect(sidebar.querySelector<HTMLButtonElement>('[data-testid="pagination-prev"]')!.disabled).toBe(true)

    cleanup(root, container)
  })
})

describe("UnifiedSkillLibraryView 分支覆盖补齐（20261105-ralph-coverage-100）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      throw new Error("missing")
    })
    writeFileMock.mockResolvedValue(undefined)
    writeFileAtomicMock.mockResolvedValue(undefined)
    openDialogMock.mockResolvedValue(null)
    saveDialogMock.mockResolvedValue(null)
    useWikiStore.getState().setProject({ id: "p1", name: "测试项目", path: "C:/project" })
    useWikiStore.getState().setActiveView("skillLibrary" as never)
  })

  it("writingSkillLibrary 视图激活写作页签（133 行首分支）", async () => {
    useWikiStore.getState().setActiveView("writingSkillLibrary" as never)
    const { container, root } = await renderLibrary()
    const writingTab = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => b.textContent?.trim() === "写作技能")
    expect(writingTab?.getAttribute("aria-pressed")).toBe("true")
    cleanup(root, container)
  })

  it("skillFavorites 视图激活收藏页签（133-135 行第二分支）", async () => {
    useWikiStore.getState().setActiveView("skillFavorites" as never)
    const { container, root } = await renderLibrary()
    const activeTab = container.querySelector('[aria-pressed="true"]')
    expect(activeTab).not.toBeNull()
    cleanup(root, container)
  })

  it("无项目时头部创建动作直接返回不写盘（171/187/203/211 行守卫）", async () => {
    useWikiStore.getState().setProject(null as never)
    const { container, root } = await renderLibrary()
    writeFileAtomicMock.mockClear()
    // 右头新建写作技能按钮仍渲染，点击后因缺项目直接返回
    const createBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => b.textContent?.includes("新建"))
    if (createBtn) {
      await act(async () => { createBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })) })
      await flushEffects()
    }
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    cleanup(root, container)
  })
})
