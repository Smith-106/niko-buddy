// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { WritingSkillLibrarySidebarPanel, WritingSkillLibraryView } from "./writing-skill-library-view"
import { buildPack, serializePack, type UserSkill } from "@/lib/novel"

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const dialogOpenMock = vi.hoisted(() => vi.fn())
const bundleDialogProps = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpenMock }))

vi.mock("@/components/skills/SkillBundleImportDialog", () => ({
  SkillBundleImportDialog: (props: Record<string, unknown>) => {
    bundleDialogProps.push(props)
    return props.open ? <div data-testid="bundle-dialog-open" /> : null
  },
}))

const readFileMock = vi.hoisted(() => vi.fn())
const writeFileAtomicMock = vi.hoisted(() => vi.fn())
const joinMock = vi.hoisted(() => vi.fn(async (...parts: string[]) => parts.join("/")))
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
    ;(useWikiStore.getState() as any).setWritingSkillLibraryDraftDirty?.(false)
    ;(useWikiStore.getState() as any).setSelectedWritingSkillLibrarySkillId?.(null)
  })

  it("shows one import action in the writing skill sidebar", async () => {
    const { container, root } = await renderLibrary()
    const sidebarButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .map((button) => button.textContent?.trim())

    expect(sidebarButtons).toContain("导入")
    expect(sidebarButtons).toContain("新建 Skill")
    expect(sidebarButtons).not.toContain("导入文件")
    expect(sidebarButtons).not.toContain("导入文件夹")
    expect(container.textContent).not.toContain("导出当前")

    cleanup(root, container)
  })

  it("creates and saves a classified writing skill", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234)
    const { container, root } = await renderLibrary()

    expect(container.querySelector('[data-testid="writing-skill-library-view"]')).not.toBeNull()
    expect(container.textContent).toContain("写作 Skill")

    const createButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("新建 Skill"))
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
