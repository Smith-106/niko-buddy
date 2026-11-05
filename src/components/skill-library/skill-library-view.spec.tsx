// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { SkillLibrarySidebarPanel, SkillLibraryView } from "./skill-library-view"

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const readFileMock = vi.hoisted(() => vi.fn())
const writeFileMock = vi.hoisted(() => vi.fn())
const writeFileAtomicMock = vi.hoisted(() => vi.fn())
const joinMock = vi.hoisted(() => vi.fn(async (...parts: string[]) => parts.join("/")))
let savedConfigContent = ""

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

async function renderView() {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<SkillLibraryView />)
  })
  await flushEffects()
  return { container, root }
}

async function renderLibrary() {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <>
        <SkillLibrarySidebarPanel />
        <SkillLibraryView />
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
  })
}

async function setInputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    valueSetter?.call(input, value)
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: value ? "insertText" : "deleteContentBackward",
      data: value,
    }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
    valueSetter?.call(textarea, value)
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
    textarea.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

describe("SkillLibraryView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    savedConfigContent = ""
    readFileMock.mockImplementation(async () => {
      if (savedConfigContent) return savedConfigContent
      throw new Error("missing")
    })
    writeFileMock.mockImplementation(async (_path: string, content: string) => {
      savedConfigContent = content
    })
    writeFileAtomicMock.mockImplementation(async (_path: string, content: string) => {
      savedConfigContent = content
    })
    useWikiStore.getState().setProject({
      id: "p1",
      name: "测试项目",
      path: "C:/project",
    })
    useWikiStore.getState().setSkillLibraryDraftDirty(false)
    useWikiStore.getState().setSelectedSkillLibrarySkillId(null)
  })

  it("renders built-in skills and selected detail editor", async () => {
    const { container, root } = await renderView()

    expect(container.querySelector('[data-testid="skill-library-view"]')).not.toBeNull()
    expect(container.textContent).toContain("综合去AI味")
    expect(container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')?.value).toBe("综合去AI味")
    expect(container.textContent).toContain("类型：")
    expect(container.textContent).toContain("风格")
    expect(container.textContent).toContain("阶段：")
    expect(container.textContent).toContain("改写")
    expect(container.textContent).toContain("输出")
    expect(container.textContent).toContain("模式：")
    expect(container.textContent).toContain("快速")
    expect(container.textContent).toContain("标准")
    expect(container.textContent).toContain("严格")

    cleanup(root, container)
  })

  it("creates a blank project skill from the sidebar and hides the copy action", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234)
    const { container, root } = await renderLibrary()

    expect(container.querySelector('[data-testid="skill-copy-button"]')).toBeNull()

    const createButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "新建技能")
    expect(createButton).not.toBeUndefined()

    await act(async () => {
      createButton?.click()
    })
    await flushEffects()

    const saved = JSON.parse(savedConfigContent)
    expect(saved.projectSkills[0]).toMatchObject({
      id: "project:1234",
      name: "新建去AI味技能",
      description: "",
      templateId: "custom",
      source: "project",
    })
    expect(saved.projectSkills[0].content).toContain("在这里填写这个技能")
    expect(saved.projectSkills[0].content).not.toContain("综合去AI味规则")
    expect(container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')?.value).toBe("新建去AI味技能")
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="skill-content-input"]')?.value).toContain(
      "在这里填写这个技能",
    )

    nowSpy.mockRestore()
    cleanup(root, container)
  })

  it("allows editing a built-in skill and restoring its default content", async () => {
    const { container, root } = await renderView()
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')
    const contentInput = container.querySelector<HTMLTextAreaElement>('[data-testid="skill-content-input"]')
    const saveButton = container.querySelector<HTMLButtonElement>('[data-testid="skill-save-button"]')
    const resetButton = container.querySelector<HTMLButtonElement>('[data-testid="skill-reset-default-button"]')

    expect(nameInput).not.toBeNull()
    expect(contentInput).not.toBeNull()
    expect(saveButton).not.toBeNull()
    expect(resetButton).not.toBeNull()
    expect(nameInput?.disabled).toBe(false)
    expect(contentInput?.disabled).toBe(false)
    expect(saveButton?.disabled).toBe(true)
    expect(resetButton?.disabled).toBe(true)

    await setInputValue(nameInput!, "综合去AI味-项目版")
    await setTextareaValue(contentInput!, "当前项目覆盖后的内置规则")
    expect(saveButton?.disabled).toBe(false)
    await act(async () => {
      saveButton?.click()
    })

    const saved = JSON.parse(savedConfigContent)
    expect(saved.builtInSkillOverrides[0]).toMatchObject({
      id: "built-in:comprehensive",
      name: "综合去AI味-项目版",
      content: "当前项目覆盖后的内置规则",
    })
    expect(container.querySelector<HTMLButtonElement>('[data-testid="skill-reset-default-button"]')?.disabled).toBe(
      false,
    )

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="skill-reset-default-button"]')?.click()
    })

    const restored = JSON.parse(savedConfigContent)
    expect(restored.builtInSkillOverrides).toEqual([])
    expect(container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')?.value).toBe("综合去AI味")
    expect(confirmSpy).toHaveBeenCalledWith(
      "确定将「综合去AI味-项目版」恢复为内置默认内容吗？当前项目对此技能的修改会被清除。",
    )
    confirmSpy.mockRestore()

    cleanup(root, container)
  })

  it("warns before switching skills when the current draft is unsaved", async () => {
    const { container, root } = await renderLibrary()
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')
    expect(nameInput).not.toBeNull()

    await setInputValue(nameInput!, "未保存的技能草稿")
    expect(useWikiStore.getState().skillLibraryDraftDirty).toBe(true)

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    const reduceExplanationCard = container.querySelector<HTMLElement>('[data-skill-id="built-in:reduce-explanation"]')
    expect(reduceExplanationCard).not.toBeUndefined()

    await act(async () => {
      reduceExplanationCard?.querySelector<HTMLButtonElement>('button')?.click()
    })
    await flushEffects()

    expect(confirmSpy).toHaveBeenCalledWith("当前技能还有未保存修改，确定放弃修改吗？")
    expect(container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')?.value).toBe("未保存的技能草稿")
    expect(useWikiStore.getState().selectedSkillLibrarySkillId).toBe("built-in:comprehensive")

    confirmSpy.mockRestore()
    cleanup(root, container)
  })

  it("keeps save disabled when the draft has no real saved change", async () => {
    const { container, root } = await renderView()
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')
    const saveButton = container.querySelector<HTMLButtonElement>('[data-testid="skill-save-button"]')
    expect(nameInput).not.toBeNull()
    expect(saveButton).not.toBeNull()

    expect(saveButton?.disabled).toBe(true)
    await setInputValue(nameInput!, "综合去AI味   ")

    expect(useWikiStore.getState().skillLibraryDraftDirty).toBe(false)
    expect(saveButton?.disabled).toBe(true)
    await act(async () => {
      saveButton?.click()
    })

    expect(writeFileMock).not.toHaveBeenCalled()
    cleanup(root, container)
  })

  it("discards unsaved draft changes and restores the selected skill content", async () => {
    const { container, root } = await renderView()
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')
    const contentInput = container.querySelector<HTMLTextAreaElement>('[data-testid="skill-content-input"]')
    const discardButton = container.querySelector<HTMLButtonElement>('[data-testid="skill-discard-button"]')
    expect(nameInput).not.toBeNull()
    expect(contentInput).not.toBeNull()
    expect(discardButton).not.toBeNull()
    expect(discardButton?.disabled).toBe(true)

    await setInputValue(nameInput!, "未保存的技能草稿")
    await setTextareaValue(contentInput!, "未保存的规则")
    expect(useWikiStore.getState().skillLibraryDraftDirty).toBe(true)
    expect(discardButton?.disabled).toBe(false)

    await act(async () => {
      discardButton?.click()
    })

    expect(container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')?.value).toBe("综合去AI味")
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="skill-content-input"]')?.value).toContain(
      "# de-AI-writing",
    )
    expect(useWikiStore.getState().skillLibraryDraftDirty).toBe(false)
    expect(writeFileMock).not.toHaveBeenCalled()

    cleanup(root, container)
  })

  it("saves the selected skill with Ctrl+S when the draft changed", async () => {
    const { container, root } = await renderView()
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')
    expect(nameInput).not.toBeNull()

    await setInputValue(nameInput!, "综合去AI味-快捷保存")
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "s",
      }))
    })
    await flushEffects()

    const saved = JSON.parse(savedConfigContent)
    expect(saved.builtInSkillOverrides[0]).toMatchObject({
      id: "built-in:comprehensive",
      name: "综合去AI味-快捷保存",
    })

    cleanup(root, container)
  })

  it("does not show modified badges after saving skill changes", async () => {
    const { container, root } = await renderLibrary()
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')
    const contentInput = container.querySelector<HTMLTextAreaElement>('[data-testid="skill-content-input"]')
    expect(nameInput).not.toBeNull()
    expect(contentInput).not.toBeNull()

    await setInputValue(nameInput!, "综合去AI味-项目版")
    await setTextareaValue(contentInput!, "当前项目覆盖后的内置规则")
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="skill-save-button"]')?.click()
    })

    expect(container.querySelectorAll('[data-testid="skill-modified-badge"]').length).toBe(0)
    expect(container.textContent).not.toContain("已修改")

    cleanup(root, container)
  })

  it("prevents saving an empty skill name", async () => {
    const { container, root } = await renderView()
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')
    expect(nameInput).not.toBeNull()

    await setInputValue(nameInput!, "")
    await flushEffects()
    expect(nameInput!.value).toBe("")
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="skill-save-button"]')?.click()
    })
    await flushEffects()

    expect(container.textContent).toContain("技能名称不能为空")
    expect(writeFileMock).not.toHaveBeenCalled()

    cleanup(root, container)
  })

  it("does not toggle a skill from the sidebar when the current draft is unsaved and discard is cancelled", async () => {
    const { container, root } = await renderLibrary()
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')
    expect(nameInput).not.toBeNull()

    await setInputValue(nameInput!, "未保存的技能草稿")
    expect(useWikiStore.getState().skillLibraryDraftDirty).toBe(true)

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    const checkbox = container.querySelector<HTMLInputElement>('[data-skill-id="built-in:reduce-explanation"] input')
    expect(checkbox).not.toBeNull()

    await act(async () => {
      checkbox?.click()
    })
    await flushEffects()

    expect(confirmSpy).toHaveBeenCalledWith("当前技能还有未保存修改，确定放弃修改吗？")
    expect(writeFileMock).not.toHaveBeenCalled()
    expect(checkbox?.checked).toBe(true)
    expect(container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')?.value).toBe("未保存的技能草稿")

    confirmSpy.mockRestore()
    cleanup(root, container)
  })

  it("does not pretend to save when no project is open", async () => {
    useWikiStore.getState().setProject(null)
    const { container, root } = await renderView()
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')
    const saveButton = container.querySelector<HTMLButtonElement>('[data-testid="skill-save-button"]')
    expect(nameInput).not.toBeNull()
    expect(saveButton).not.toBeNull()
    expect(nameInput?.disabled).toBe(true)

    await setInputValue(nameInput!, "综合去AI味-无项目")

    expect(saveButton?.disabled).toBe(true)
    expect(container.textContent).toContain("请先打开项目")
    expect(writeFileMock).not.toHaveBeenCalled()

    cleanup(root, container)
  })

  it("loads the skill config once when sidebar and detail render together", async () => {
    const { container, root } = await renderLibrary()

    expect(container.textContent).toContain("综合去AI味")
    expect(readFileMock).toHaveBeenCalledTimes(3)
    expect(readFileMock).toHaveBeenNthCalledWith(1, "C:/project/.niko-buddy/de-ai-skills.json")
    expect(readFileMock).toHaveBeenNthCalledWith(2, "C:/project/de-ai-skills.json")
    expect(readFileMock).toHaveBeenNthCalledWith(3, "C:/project/de-ai-skill.txt")

    cleanup(root, container)
  })

  it("offers recovery actions when the json skill config is corrupt and restores from backup", async () => {
    const backup = JSON.stringify({
      version: 1,
      defaultSkillId: "project:backup",
      disabledSkillIds: [],
      projectSkills: [{
        id: "project:backup",
        name: "备份 Skill",
        description: "从备份恢复",
        templateId: "backup",
        content: "备份规则",
        source: "project",
        createdAt: 1000,
        updatedAt: 1000,
      }],
      builtInSkillOverrides: [],
    })
    readFileMock
      .mockResolvedValueOnce("{bad json")
      .mockResolvedValueOnce(backup)

    const { container, root } = await renderView()

    expect(container.textContent).toContain("技能库配置文件损坏")
    const restoreButton = container.querySelector<HTMLButtonElement>('[data-testid="skill-restore-backup-button"]')
    expect(restoreButton).not.toBeNull()

    await act(async () => {
      restoreButton?.click()
    })
    await flushEffects()

    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/de-ai-skills.json",
      JSON.stringify({ ...JSON.parse(backup), lastChapterDeAiSkillId: null }, null, 2),
    )
    expect(container.textContent).toContain("备份 Skill")

    cleanup(root, container)
  })

  it("can recreate a default config after the json skill config is corrupt", async () => {
    readFileMock.mockResolvedValueOnce("{bad json")
    const { container, root } = await renderView()

    expect(container.textContent).toContain("技能库配置文件损坏")
    const recreateButton = container.querySelector<HTMLButtonElement>('[data-testid="skill-recreate-config-button"]')
    expect(recreateButton).not.toBeNull()
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)

    await act(async () => {
      recreateButton?.click()
    })
    await flushEffects()

    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/de-ai-skills.json",
      expect.stringContaining('"defaultSkillId": "built-in:comprehensive"'),
    )
    expect(container.textContent).toContain("综合去AI味")

    confirmSpy.mockRestore()
    cleanup(root, container)
  })
})

describe("SkillLibraryView 覆盖补齐（去AI味详情/侧栏未覆盖行）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    savedConfigContent = ""
    readFileMock.mockImplementation(async () => {
      if (savedConfigContent) return savedConfigContent
      throw new Error("missing")
    })
    writeFileMock.mockImplementation(async (_path: string, content: string) => {
      savedConfigContent = content
    })
    writeFileAtomicMock.mockImplementation(async (_path: string, content: string) => {
      savedConfigContent = content
    })
    useWikiStore.getState().setProject({
      id: "p1",
      name: "测试项目",
      path: "C:/project",
    })
    useWikiStore.getState().setSkillLibraryDraftDirty(false)
    useWikiStore.getState().setSelectedSkillLibrarySkillId(null)
  })

  async function dispatchClick(element: Element | null) {
    if (!element) throw new Error("element not found")
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await flushEffects()
  }

  it("renders legacy skills with the 旧版 label", async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skill.txt")) return "旧版规则正文"
      throw new Error("missing")
    })
    const { container, root } = await renderView()

    expect(container.textContent).toContain("旧版技能")
    expect(container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')?.value).toBe(
      "旧版自定义去AI味 Skill",
    )

    cleanup(root, container)
  })

  it("toggles a sidebar skill off and persists the disabled id list", async () => {
    const { container, root } = await renderLibrary()
    const checkbox = container.querySelector<HTMLInputElement>(
      '[data-skill-id="built-in:comprehensive"] input[type="checkbox"]',
    )
    expect(checkbox).not.toBeNull()
    expect(checkbox?.checked).toBe(true)

    await act(async () => {
      checkbox?.click()
    })
    await flushEffects()

    const saved = JSON.parse(savedConfigContent)
    expect(saved.disabledSkillIds).toEqual(["built-in:comprehensive"])
    expect(container.textContent).toContain("已保存")

    cleanup(root, container)
  })

  it("does not toggle a sidebar skill when no project is open, but saves once a project is set", async () => {
    const { container, root } = await renderLibrary()
    useWikiStore.getState().setProject(null)
    await flushEffects()
    writeFileAtomicMock.mockClear()

    const checkbox = container.querySelector<HTMLInputElement>(
      '[data-skill-id="built-in:comprehensive"] input[type="checkbox"]',
    )
    await dispatchClick(checkbox)

    // 无项目时守卫直接返回：同一点击机制在有项目时可落盘（见下），故此处未写盘只能是守卫所致
    expect(writeFileAtomicMock).not.toHaveBeenCalled()

    useWikiStore.getState().setProject({ id: "p1", name: "测试项目", path: "C:/project" })
    await flushEffects()
    await dispatchClick(container.querySelector('[data-skill-id="built-in:comprehensive"] input[type="checkbox"]'))
    expect(writeFileAtomicMock).toHaveBeenCalled()

    cleanup(root, container)
  })

  it("surfaces sidebar save failure when disk write fails", async () => {
    writeFileAtomicMock.mockRejectedValueOnce(new Error("disk full"))
    const { container, root } = await renderLibrary()

    const createButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "新建技能",
    )
    await dispatchClick(createButton ?? null)

    expect(container.textContent).toContain("技能库保存失败")

    cleanup(root, container)
  })

  it("sets another skill as default from the detail view", async () => {
    const { container, root } = await renderLibrary()

    await act(async () => {
      container
        .querySelector<HTMLElement>('[data-skill-id="built-in:reduce-explanation"]')
        ?.querySelector<HTMLButtonElement>("button")
        ?.click()
    })
    await flushEffects()

    const defaultButton = container.querySelector<HTMLButtonElement>('[data-testid="skill-default-button"]')
    expect(defaultButton?.disabled).toBe(false)
    await act(async () => {
      defaultButton?.click()
    })
    await flushEffects()

    const saved = JSON.parse(savedConfigContent)
    expect(saved.defaultSkillId).toBe("built-in:reduce-explanation")
    expect(container.textContent).toContain("已保存")

    cleanup(root, container)
  })

  it("blocks default persistence without a project (disabled button cannot activate the handler)", async () => {
    const { container, root } = await renderLibrary()
    useWikiStore.getState().setProject(null)
    await flushEffects()
    writeFileAtomicMock.mockClear()

    // 设为默认按钮在无项目时被禁用：React 不会为禁用按钮触发 onClick，
    // 因此详情 persist 的 !project 守卫（268-269）在 UI 上不可达，此处只断言提示与未写盘
    const defaultButton = container.querySelector<HTMLButtonElement>('[data-testid="skill-default-button"]')
    expect(defaultButton?.disabled).toBe(true)
    await dispatchClick(defaultButton)

    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    expect(container.textContent).toContain("请先打开项目")

    cleanup(root, container)
  })

  it("rejects saving when the rule content is empty", async () => {
    const { container, root } = await renderView()
    const contentInput = container.querySelector<HTMLTextAreaElement>('[data-testid="skill-content-input"]')
    expect(contentInput).not.toBeNull()

    await setTextareaValue(contentInput!, "")
    const saveButton = container.querySelector<HTMLButtonElement>('[data-testid="skill-save-button"]')
    expect(saveButton?.disabled).toBe(false)
    await act(async () => {
      saveButton?.click()
    })
    await flushEffects()

    expect(container.textContent).toContain("技能规则不能为空")
    expect(writeFileMock).not.toHaveBeenCalled()
    expect(writeFileAtomicMock).not.toHaveBeenCalled()

    cleanup(root, container)
  })

  it("surfaces detail save failure when disk write fails", async () => {
    const { container, root } = await renderView()
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')
    const contentInput = container.querySelector<HTMLTextAreaElement>('[data-testid="skill-content-input"]')

    await setInputValue(nameInput!, "综合去AI味-写盘失败")
    await setTextareaValue(contentInput!, "写盘失败时的规则")
    writeFileAtomicMock.mockRejectedValueOnce(new Error("disk full"))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="skill-save-button"]')?.click()
    })
    await flushEffects()

    expect(container.textContent).toContain("技能库保存失败")

    cleanup(root, container)
  })

  it("saves an edited description", async () => {
    const { container, root } = await renderView()
    const descriptionInput = container.querySelector<HTMLInputElement>(
      '[data-testid="skill-description-input"]',
    )

    await setInputValue(descriptionInput!, "项目定制的新说明")
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="skill-save-button"]')?.click()
    })
    await flushEffects()

    const saved = JSON.parse(savedConfigContent)
    expect(saved.builtInSkillOverrides[0]).toMatchObject({
      id: "built-in:comprehensive",
      description: "项目定制的新说明",
    })

    cleanup(root, container)
  })

  it("deletes a project skill and falls back to a built-in default", async () => {
    savedConfigContent = JSON.stringify({
      version: 1,
      defaultSkillId: "project:custom",
      disabledSkillIds: [],
      projectSkills: [{
        id: "project:custom",
        name: "项目技能",
        description: "待删除",
        templateId: "custom",
        content: "项目规则",
        source: "project",
        createdAt: 100,
        updatedAt: 100,
      }],
      builtInSkillOverrides: [],
    })
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    const { container, root } = await renderLibrary()

    expect(container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')?.value).toBe("项目技能")
    const deleteButton = container.querySelector<HTMLButtonElement>('[data-testid="skill-delete-button"]')
    expect(deleteButton).not.toBeNull()
    await act(async () => {
      deleteButton?.click()
    })
    await flushEffects()

    const saved = JSON.parse(savedConfigContent)
    expect(saved.projectSkills).toEqual([])
    expect(saved.defaultSkillId).not.toBe("project:custom")
    // 删除后选中回退到内置默认（ selection 变化会清空“已保存”提示，以落盘内容为准）
    expect(container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')?.value).toBe(
      "综合去AI味",
    )

    confirmSpy.mockRestore()
    cleanup(root, container)
  })

  it("keeps a project skill when deletion is cancelled", async () => {
    savedConfigContent = JSON.stringify({
      version: 1,
      defaultSkillId: "project:custom",
      disabledSkillIds: [],
      projectSkills: [{
        id: "project:custom",
        name: "项目技能",
        description: "待删除",
        templateId: "custom",
        content: "项目规则",
        source: "project",
        createdAt: 100,
        updatedAt: 100,
      }],
      builtInSkillOverrides: [],
    })
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    const { container, root } = await renderLibrary()
    writeFileAtomicMock.mockClear()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="skill-delete-button"]')?.click()
    })
    await flushEffects()

    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')?.value).toBe("项目技能")

    confirmSpy.mockRestore()
    cleanup(root, container)
  })

  it("shows 备份恢复失败 when the backup read fails", async () => {
    let calls = 0
    readFileMock.mockImplementation(async () => {
      calls += 1
      if (calls === 1) return "{bad json"
      throw new Error("no backup")
    })
    const { container, root } = await renderView()

    expect(container.textContent).toContain("技能库配置文件损坏")
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="skill-restore-backup-button"]')?.click()
    })
    await flushEffects()

    expect(container.textContent).toContain("备份恢复失败")

    cleanup(root, container)
  })

  it("shows recreate failure when recreating the config fails", async () => {
    readFileMock.mockResolvedValueOnce("{bad json")
    writeFileAtomicMock.mockRejectedValueOnce(new Error("disk full"))
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    const { container, root } = await renderView()

    expect(container.textContent).toContain("技能库配置文件损坏")
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="skill-recreate-config-button"]')?.click()
    })
    await flushEffects()

    expect(container.textContent).toContain("重新创建技能库配置失败")

    confirmSpy.mockRestore()
    cleanup(root, container)
  })

  it("registers a beforeunload guard while the draft is dirty", async () => {
    const { container, root } = await renderView()
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="skill-name-input"]')

    await setInputValue(nameInput!, "未保存的技能草稿")
    expect(useWikiStore.getState().skillLibraryDraftDirty).toBe(true)

    const event = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)

    cleanup(root, container)
  })
})
