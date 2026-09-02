// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { UnifiedSkillLibrarySidebarPanel, UnifiedSkillLibraryView } from "./unified-skill-library-view"

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const readFileMock = vi.hoisted(() => vi.fn())
const writeFileMock = vi.hoisted(() => vi.fn())
const writeFileAtomicMock = vi.hoisted(() => vi.fn())
const joinMock = vi.hoisted(() => vi.fn(async (...parts: string[]) => parts.join("/")))
const openDialogMock = vi.hoisted(() => vi.fn())
const saveDialogMock = vi.hoisted(() => vi.fn())

vi.mock("@/commands/fs", () => ({
  readFile: readFileMock,
  writeFile: writeFileMock,
  writeFileAtomic: writeFileAtomicMock,
}))

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
    for (const label of ["全部", "写作", "去AI味", "审稿", "输出", "知识"]) {
      expect(getButton(container, label)).not.toBeUndefined()
    }

    cleanup(root, container)
  })

  it("keeps creation, import, and export actions out of the unified sidebar", async () => {
    const { container, root } = await renderLibrary()
    const sidebar = container.querySelector<HTMLElement>('[data-testid="unified-skill-library-sidebar"]')

    for (const label of ["新建去AI技能", "新建 Skill", "导入文件", "导入文件夹", "导出当前"]) {
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
    expect(actions?.textContent).not.toContain("新建 Skill")
    expect(actions?.textContent).not.toContain("导出当前")

    cleanup(root, container)
  })

  it("shows writing Skill actions in the right header when writing tab is active", async () => {
    const { container, root } = await renderLibrary()

    await act(async () => {
      getButton(container, "写作 Skill")?.click()
    })
    await flushEffects()

    const actions = container.querySelector<HTMLElement>('[data-testid="skill-library-header-actions"]')
    const actionLabels = Array.from(actions?.querySelectorAll("button") ?? [])
      .map((button) => button.textContent?.trim())

    expect(actionLabels).toEqual(["新建 Skill", "导入"])
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
      getButton(container, "写作 Skill")?.click()
    })
    await flushEffects()

    await act(async () => {
      getButton(container, "新建 Skill")?.click()
    })
    await flushEffects()

    expect(useWikiStore.getState().activeView).toBe("writingSkillLibrary")
    expect(useWikiStore.getState().selectedWritingSkillLibrarySkillId).toMatch(/^skill:/)
    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.qmai/writing-skills.json",
      expect.stringContaining("新建写作 Skill"),
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
      "C:/project/.qmai/de-ai-skills.json",
      expect.stringContaining("冷硬叙事"),
    )
    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.qmai/de-ai-skills.json",
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
      container.querySelector<HTMLElement>('[data-testid="unified-skill-entry-writing:skill:three"]')?.click()
    })
    await flushEffects()

    expect(useWikiStore.getState().activeView).toBe("writingSkillLibrary")
    expect(useWikiStore.getState().selectedWritingSkillLibrarySkillId).toBe("skill:three")
    expect(container.querySelector('[data-testid="writing-skill-library-view"]')).not.toBeNull()

    await setInputValue(searchInput, "沉浸式")

    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="unified-skill-entry-de-ai:project:quiet"]')?.click()
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
      writingEntry?.click()
    })
    await flushEffects()

    expect(writingEntry?.getAttribute("aria-current")).toBe("true")

    await setInputValue(searchInput, "沉浸式")
    const deAiEntry = container.querySelector<HTMLElement>('[data-testid="unified-skill-entry-de-ai:project:quiet"]')

    await act(async () => {
      deAiEntry?.click()
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
