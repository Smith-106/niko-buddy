// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { WritingSkillLibrarySidebarPanel, WritingSkillLibraryView } from "./writing-skill-library-view"
import { buildPack, serializePack, type UserSkill } from "@/lib/novel"

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const dialogOpenMock = vi.hoisted(() => vi.fn())
const saveDialogMock = vi.hoisted(() => vi.fn())
const bundleDialogProps = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpenMock, save: saveDialogMock }))

vi.mock("@/components/skills/SkillBundleImportDialog", () => ({
  SkillBundleImportDialog: (props: Record<string, unknown>) => {
    bundleDialogProps.push(props)
    return props.open ? <div data-testid="bundle-dialog-open" /> : null
  },
}))

const readFileMock = vi.hoisted(() => vi.fn())
const writeFileAtomicMock = vi.hoisted(() => vi.fn())
const joinMock = vi.hoisted(() => vi.fn(async (...parts: string[]) => parts.join("/")))
const linkedContentControl = vi.hoisted(() => ({ failNext: false }))
vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    loadLinkedSkillContent: (...args: [Parameters<typeof actual.loadLinkedSkillContent>[0]]) => {
      if (linkedContentControl.failNext) {
        linkedContentControl.failNext = false
        return Promise.reject(new Error("linked boom"))
      }
      return actual.loadLinkedSkillContent(...args)
    },
  }
})
let savedConfigContent = ""

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: readFileMock,
      writeFileAtomic: writeFileAtomicMock,
    
  }
})

vi.mock("@tauri-apps/api/path", () => ({
  join: joinMock,
}))

async function renderLibrary() {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <>
        <WritingSkillLibrarySidebarPanel />
        <WritingSkillLibraryView />
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
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }))
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

async function click(button: HTMLElement | null) {
  if (!button) throw new Error("button not found")
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  await flushEffects()
}

describe("WritingSkillLibraryView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    savedConfigContent = ""
    readFileMock.mockImplementation(async () => {
      if (savedConfigContent) return savedConfigContent
      throw new Error("missing")
    })
    writeFileAtomicMock.mockImplementation(async (_path: string, content: string) => {
      savedConfigContent = content
    })
    useWikiStore.getState().setProject({
      id: "p1",
      name: "测试项目",
      path: "C:/project",
    })
    useWikiStore.getState().setWritingSkillLibraryDraftDirty(false)
    useWikiStore.getState().setSelectedWritingSkillLibrarySkillId(null)
  })

  it("shows one import action in the writing skill sidebar", async () => {
    const { container, root } = await renderLibrary()
    const sidebarButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .map((button) => button.textContent?.trim())

    expect(sidebarButtons).toContain("导入")
    expect(sidebarButtons).toContain("新建技能")
    expect(sidebarButtons).not.toContain("导入文件")
    expect(sidebarButtons).not.toContain("导入文件夹")
    expect(container.textContent).not.toContain("导出当前")

    cleanup(root, container)
  })

  it("creates and saves a classified writing skill", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234)
    const { container, root } = await renderLibrary()

    expect(container.querySelector('[data-testid="writing-skill-library-view"]')).not.toBeNull()
    expect(container.textContent).toContain("写作技能")

    const createButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("新建技能"))
    await click(createButton ?? null)

    await setInputValue(container.querySelector('[data-testid="writing-skill-name-input"]')!, "三翻四抖")
    await setInputValue(container.querySelector('[data-testid="writing-skill-description-input"]')!, "三次转折，四次震惊。")
    await setTextareaValue(
      container.querySelector('[data-testid="writing-skill-content-input"]')!,
      "每章设置三次局势变化和四次信息冲击。",
    )
    await click(container.querySelector('[data-testid="writing-skill-kind-review"]'))
    await click(container.querySelector('[data-testid="writing-skill-stage-review"]'))
    await click(container.querySelector('[data-testid="writing-skill-mode-fast"]'))

    await click(container.querySelector('[data-testid="writing-skill-save-button"]'))

    const saved = JSON.parse(savedConfigContent)
    expect(saved.skills[0]).toMatchObject({
      id: "skill:1234",
      name: "三翻四抖",
      description: "三次转折，四次震惊。",
      kind: ["structure", "planning", "review"],
      stages: ["planning", "drafting", "review"],
      modes: ["standard", "strict", "fast"],
      content: "每章设置三次局势变化和四次信息冲击。",
      source: "uploaded",
    })

    nowSpy.mockRestore()
    cleanup(root, container)
  })

  it("disables and deletes writing skills from the separate library", async () => {
    savedConfigContent = JSON.stringify({
      version: 1,
      selectedSkillId: "skill:three",
      disabledSkillIds: [],
      skills: [{
        id: "skill:three",
        name: "三翻四抖",
        description: "三次转折，四次震惊。",
        kind: ["structure", "planning"],
        stages: ["planning", "drafting"],
        modes: ["standard", "strict"],
        content: "每章设置三次局势变化和四次信息冲击。",
        source: "uploaded",
      }],
    })
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    const { container, root } = await renderLibrary()

    const enabled = container.querySelector<HTMLInputElement>('[data-testid="writing-skill-enabled-checkbox"]')
    expect(enabled?.checked).toBe(true)
    await click(enabled)
    expect(JSON.parse(savedConfigContent).disabledSkillIds).toEqual(["skill:three"])

    await click(container.querySelector('[data-testid="writing-skill-delete-button"]'))
    const saved = JSON.parse(savedConfigContent)
    expect(saved.skills.length).toBeGreaterThanOrEqual(10)
    expect(saved.skills.find((s: any) => s.id === "skill:three")).toBeUndefined()
    expect(saved.skills[0].source).toBe("built-in")
    expect(saved.selectedSkillId).toBe(saved.skills[0].id)

    confirmSpy.mockRestore()
    cleanup(root, container)
  })
})

describe("技能包接线（F-006）", () => {
  async function waitForPackSection(container: HTMLElement) {
    for (let i = 0; i < 20; i += 1) {
      if (container.querySelector('[data-testid="skill-pack-section"]')) return
      await flushEffects()
    }
  }

  it("技能包面板挂在写作 Skill 视图内（导入/导出入口可达）", async () => {
    const { container, root } = await renderLibrary()
    await waitForPackSection(container)

    expect(container.querySelector('[data-testid="skill-pack-section"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="skill-pack-panel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="skillpack-export"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="skillpack-import"]')).not.toBeNull()

    cleanup(root, container)
  })

  it("导入成功后由宿主经既有 store 落盘（面板自己不写盘）", async () => {
    // 用真实导出逻辑造一个合法技能包，再喂回导入入口（导出→导入往返）。
    const built = buildPack(
      [
        {
          id: "skill:pack-src",
          name: "包内技能",
          description: "",
          content: "保持三人称限知视角。",
          kind: [],
          stages: [],
          modes: [],
          priority: 50,
          tags: [],
          categoryId: "cat-a",
          source: "project",
          createdAt: 1,
          updatedAt: 1,
        } as UserSkill,
      ],
      { name: "niko-skills", version: "1.0.0" },
    )
    const packText = serializePack(built)

    // 先让视图加载一份带分类的既有配置（导入需要目标分类 id）。
    savedConfigContent = JSON.stringify({
      version: 1,
      selectedSkillId: null,
      disabledSkillIds: [],
      skills: [],
      categories: [{ id: "cat-a", name: "通用" }],
    })

    const { container, root } = await renderLibrary()
    await waitForPackSection(container)
    const fileInput = container.querySelector<HTMLInputElement>('[data-testid="skillpack-file"]')
    expect(fileInput).not.toBeNull()

    const file = new File([packText], "niko-skills.nbskill", { type: "application/json" })
    Object.defineProperty(fileInput!, "files", { value: [file], configurable: true })
    await act(async () => {
      fileInput!.dispatchEvent(new Event("change", { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    await flushEffects()

    // 落盘走的是既有 user-skill-store 真源文件，且导入的技能带 uploaded 来源标记
    expect(writeFileAtomicMock).toHaveBeenCalled()
    const saved = JSON.parse(savedConfigContent)
    const imported = saved.skills.find((s: { source: string }) => s.source === "uploaded")
    expect(imported).toBeTruthy()
    // 宿主把导入技能落进一个**已存在**的分类（不伪造分类 id，也不留空）：
    // 传入的是 `draftCategoryId || config.categories[0].id`，后者是加载后的真实分类。
    const knownCategoryIds = new Set(saved.categories.map((c: { id: string }) => c.id))
    expect(imported.categoryId).not.toBe("")
    expect(knownCategoryIds.has(imported.categoryId)).toBe(true)

    cleanup(root, container)
  })
})

describe("技能包（.zip）离线导入接线（A-F-002 / B-F-006）", () => {
  async function waitForBundleEntry(container: HTMLElement) {
    for (let i = 0; i < 20; i += 1) {
      if (container.querySelector('[data-testid="skill-bundle-import-open"]')) return
      await flushEffects()
    }
  }

  it("写作 Skill 视图内可点开技能包导入入口，并把选中路径交给弹窗", async () => {
    bundleDialogProps.length = 0
    dialogOpenMock.mockResolvedValue("D:/tmp/skillpack-a.zip")
    const { container, root } = await renderLibrary()
    await waitForBundleEntry(container)

    await click(container.querySelector('[data-testid="skill-bundle-import-open"]'))

    expect(dialogOpenMock).toHaveBeenCalled()
    const last = bundleDialogProps[bundleDialogProps.length - 1]
    expect(last?.open).toBe(true)
    expect(last?.bundlePath).toBe("D:/tmp/skillpack-a.zip")
    // 落点根由宿主给出（用户不可在弹窗内改写）
    expect(typeof last?.destRoot).toBe("string")
    expect((last?.destRoot as string).length).toBeGreaterThan(0)
    expect(container.querySelector('[data-testid="bundle-dialog-open"]')).not.toBeNull()

    dialogOpenMock.mockReset()
    cleanup(root, container)
  })

  it("用户在原生对话框取消时不打开弹窗（不伪造路径）", async () => {
    bundleDialogProps.length = 0
    dialogOpenMock.mockResolvedValue(null)
    const { container, root } = await renderLibrary()
    await waitForBundleEntry(container)

    await click(container.querySelector('[data-testid="skill-bundle-import-open"]'))

    expect(container.querySelector('[data-testid="bundle-dialog-open"]')).toBeNull()
    expect(bundleDialogProps.every((props) => props.open === false)).toBe(true)

    dialogOpenMock.mockReset()
    cleanup(root, container)
  })
})

describe("WritingSkillLibraryView 覆盖补齐（保存/导出/标签/分类未覆盖行）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    savedConfigContent = ""
    readFileMock.mockImplementation(async () => {
      if (savedConfigContent) return savedConfigContent
      throw new Error("missing")
    })
    writeFileAtomicMock.mockImplementation(async (_path: string, content: string) => {
      savedConfigContent = content
    })
    useWikiStore.getState().setProject({
      id: "p1",
      name: "测试项目",
      path: "C:/project",
    })
    useWikiStore.getState().setWritingSkillLibraryDraftDirty(false)
    useWikiStore.getState().setSelectedWritingSkillLibrarySkillId(null)
  })

  function seedSkill(overrides: Record<string, unknown> = {}, categories: Array<{ id: string; name: string }> = [{ id: "cat-a", name: "通用" }]) {
    savedConfigContent = JSON.stringify({
      version: 1,
      selectedSkillId: "skill:one",
      disabledSkillIds: [],
      skills: [{
        id: "skill:one",
        name: "三翻四抖",
        description: "三次转折",
        content: "每章设置三次局势变化。",
        kind: ["structure"],
        stages: ["planning"],
        modes: ["standard"],
        priority: 50,
        tags: [],
        categoryId: "",
        source: "uploaded",
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
      }],
      categories,
    })
  }

  async function setSelectValue(select: HTMLSelectElement, value: string) {
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
      valueSetter?.call(select, value)
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await flushEffects()
  }

  async function keyDown(element: Element, key: string) {
    await act(async () => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
    })
    await flushEffects()
  }

  it("rejects saving when the skill name is empty", async () => {
    seedSkill()
    const { container, root } = await renderLibrary()
    writeFileAtomicMock.mockClear()

    await setInputValue(container.querySelector('[data-testid="writing-skill-name-input"]')!, "")
    await click(container.querySelector('[data-testid="writing-skill-save-button"]'))

    expect(container.textContent).toContain("Skill 名称不能为空")
    expect(writeFileAtomicMock).not.toHaveBeenCalled()

    cleanup(root, container)
  })

  it("rejects saving when the rule body is empty", async () => {
    seedSkill()
    const { container, root } = await renderLibrary()
    writeFileAtomicMock.mockClear()

    await setTextareaValue(container.querySelector('[data-testid="writing-skill-content-input"]')!, "")
    await click(container.querySelector('[data-testid="writing-skill-save-button"]'))

    expect(container.textContent).toContain("规则正文不能为空")
    expect(writeFileAtomicMock).not.toHaveBeenCalled()

    cleanup(root, container)
  })

  it("surfaces save failure when disk write fails", async () => {
    seedSkill()
    const { container, root } = await renderLibrary()

    await setInputValue(container.querySelector('[data-testid="writing-skill-name-input"]')!, "三翻四抖-改")
    await setTextareaValue(container.querySelector('[data-testid="writing-skill-content-input"]')!, "新规则正文")
    writeFileAtomicMock.mockRejectedValueOnce(new Error("disk full"))
    await click(container.querySelector('[data-testid="writing-skill-save-button"]'))

    expect(container.textContent).toContain("写作技能保存失败")

    cleanup(root, container)
  })

  it("exports the selected skill to a chosen JSON file", async () => {
    seedSkill()
    saveDialogMock.mockResolvedValue("D:/out/skill.json")
    const { container, root } = await renderLibrary()
    writeFileAtomicMock.mockClear()

    await click(Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "导出") ?? null)

    expect(saveDialogMock).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "三翻四抖.json" }))
    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "D:/out/skill.json",
      expect.stringContaining("三翻四抖"),
    )
    expect(container.textContent).toContain("导出成功")

    cleanup(root, container)
  })

  it("does nothing when the export dialog is cancelled", async () => {
    seedSkill()
    saveDialogMock.mockResolvedValue(null)
    const { container, root } = await renderLibrary()
    writeFileAtomicMock.mockClear()

    await click(Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "导出") ?? null)

    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain("导出成功")

    cleanup(root, container)
  })

  it("shows 导出 Skill 失败 when export write fails", async () => {
    seedSkill()
    saveDialogMock.mockResolvedValue("D:/out/skill.json")
    writeFileAtomicMock.mockRejectedValueOnce(new Error("disk full"))
    const { container, root } = await renderLibrary()

    await click(Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "导出") ?? null)

    expect(container.textContent).toContain("导出 Skill 失败")

    cleanup(root, container)
  })

  it("reloads linked skill content on demand", async () => {
    seedSkill({ source: "linked", linkedPath: "C:/linked/skill.md", content: "旧内容" })
    let fileContent = "版本一"
    readFileMock.mockImplementation(async (path: string) => {
      if (path === "C:/linked/skill.md") return fileContent
      if (savedConfigContent) return savedConfigContent
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()

    expect(container.textContent).toContain("引用")
    const reloadButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "重新读取")
    expect(reloadButton).not.toBeUndefined()

    fileContent = "版本二"
    await click(reloadButton ?? null)

    // 注意：成功提示会被“草稿同步 effect”（content 变化 → setMessage("")）立即清空，
    // 此处以正文更新证明重载确实发生
    expect(container.querySelector("textarea")?.value).toBe("版本二")

    cleanup(root, container)
  })

  it("clears linked content when the linked file is unreadable (loader swallows the error)", async () => {
    seedSkill({ source: "linked", linkedPath: "C:/linked/skill.md", content: "旧内容" })
    readFileMock.mockImplementation(async (path: string) => {
      if (path === "C:/linked/skill.md") throw new Error("gone")
      if (savedConfigContent) return savedConfigContent
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()

    const reloadButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "重新读取")
    await click(reloadButton ?? null)

    // loadLinkedSkillContent 内部吞错返回 ""，外层 catch（252 行）实际不可达；
    // 此处锁定当前真实行为：正文被清空且不抛错
    expect(container.querySelector("textarea")?.value).toBe("")

    cleanup(root, container)
  })

  it("adds, dedupes, and removes tags", async () => {
    seedSkill()
    const { container, root } = await renderLibrary()
    const tagInput = container.querySelector<HTMLInputElement>('input[placeholder="输入标签后按回车添加"]')!
    expect(tagInput).not.toBeNull()

    await setInputValue(tagInput, "新标签")
    await keyDown(tagInput, "Enter")
    expect(container.textContent).toContain("新标签")

    // 重复标签不会重复添加：输入框被清空且只剩一个 chip
    await setInputValue(tagInput, "新标签")
    await keyDown(tagInput, "Enter")
    const chips = Array.from(container.querySelectorAll("span"))
      .filter((span) => span.textContent === "新标签×")
    expect(chips.length).toBe(1)

    // 非确认键不添加标签
    await setInputValue(tagInput, "不加")
    await keyDown(tagInput, "a")
    expect(container.textContent).not.toContain("不加×")

    // 删除标签
    const removeButton = container.querySelector<HTMLButtonElement>('button[aria-label="删除 新标签"]')
    expect(removeButton).not.toBeNull()
    await click(removeButton)
    expect(container.querySelectorAll("span"))
    expect(Array.from(container.querySelectorAll("span")).filter((span) => span.textContent === "新标签×").length).toBe(0)

    cleanup(root, container)
  })

  it("saves the selected category", async () => {
    seedSkill()
    const { container, root } = await renderLibrary()
    const select = container.querySelector<HTMLSelectElement>("select")!
    expect(select).not.toBeNull()

    await setSelectValue(select, "cat-a")
    await setInputValue(container.querySelector('[data-testid="writing-skill-name-input"]')!, "三翻四抖-改")
    await click(container.querySelector('[data-testid="writing-skill-save-button"]'))

    const saved = JSON.parse(savedConfigContent)
    expect(saved.skills.find((s: { id: string }) => s.id === "skill:one")).toMatchObject({ categoryId: "cat-a" })

    cleanup(root, container)
  })

  it("clamps the priority input to 1-100 and falls back to 50", async () => {
    seedSkill()
    const { container, root } = await renderLibrary()
    const priorityInput = container.querySelector<HTMLInputElement>('input[type="number"]')!
    expect(priorityInput).not.toBeNull()

    await setInputValue(priorityInput, "200")
    expect(priorityInput.value).toBe("100")
    await setInputValue(priorityInput, "0")
    expect(priorityInput.value).toBe("1")
    await setInputValue(priorityInput, "")
    expect(priorityInput.value).toBe("50")

    cleanup(root, container)
  })

  it("closes the bundle dialog via onClose", async () => {
    seedSkill()
    bundleDialogProps.length = 0
    dialogOpenMock.mockResolvedValue("D:/tmp/skillpack-a.zip")
    const { container, root } = await renderLibrary()

    await click(container.querySelector('[data-testid="skill-bundle-import-open"]'))
    expect(container.querySelector('[data-testid="bundle-dialog-open"]')).not.toBeNull()

    const last = bundleDialogProps[bundleDialogProps.length - 1]
    await act(async () => {
      ;(last?.onClose as (() => void) | undefined)?.()
    })
    await flushEffects()
    expect(container.querySelector('[data-testid="bundle-dialog-open"]')).toBeNull()

    dialogOpenMock.mockReset()
    cleanup(root, container)
  })
})

describe("WritingSkillLibraryView 覆盖补齐（无项目持久化/外链重读）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    savedConfigContent = ""
    readFileMock.mockImplementation(async () => {
      if (savedConfigContent) return savedConfigContent
      throw new Error("missing")
    })
    writeFileAtomicMock.mockImplementation(async (_path: string, content: string) => {
      savedConfigContent = content
    })
    bundleDialogProps.length = 0
    useWikiStore.getState().setProject({
      id: "p1",
      name: "测试项目",
      path: "C:/project",
    })
    useWikiStore.getState().setWritingSkillLibraryDraftDirty(false)
    useWikiStore.getState().setSelectedWritingSkillLibrarySkillId(null)
  })

  function seedSkill(overrides: Record<string, unknown> = {}) {
    savedConfigContent = JSON.stringify({
      version: 1,
      selectedSkillId: "skill:one",
      disabledSkillIds: [],
      skills: [{
        id: "skill:one",
        name: "三翻四抖",
        description: "三次转折",
        content: "每章设置三次局势变化。",
        kind: ["structure"],
        stages: ["planning"],
        modes: ["standard"],
        priority: 50,
        tags: [],
        categoryId: "",
        source: "uploaded",
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
      }],
      categories: [{ id: "cat-a", name: "通用" }],
    })
  }

  it("surfaces a message when reloading linked skill content fails", async () => {
    seedSkill({
      id: "skill:linked",
      name: "外链技能",
      source: "linked",
      linkedPath: "D:/ext/skill.md",
    })
    savedConfigContent = JSON.stringify({
      ...JSON.parse(savedConfigContent),
      selectedSkillId: "skill:linked",
    })
    const { container, root } = await renderLibrary()

    const reloadButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "重新读取")
    expect(reloadButton).toBeTruthy()

    // loadLinkedSkillContent 内部吞错返回 ""，用 mock 使其 reject 以进 catch
    linkedContentControl.failNext = true
    await click(reloadButton ?? null)

    expect(container.textContent).toContain("读取内容失败")

    cleanup(root, container)
  })
})
