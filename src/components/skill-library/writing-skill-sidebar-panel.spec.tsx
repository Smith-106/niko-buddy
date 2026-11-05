// @vitest-environment jsdom

import { act } from "react"
import { createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { WritingSkillLibrarySidebarPanel } from "./writing-skill-sidebar-panel"

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const dialogOpenMock = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpenMock }))

const readFileMock = vi.hoisted(() => vi.fn())
const writeFileAtomicMock = vi.hoisted(() => vi.fn())
vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: readFileMock, writeFileAtomic: writeFileAtomicMock }
})

const joinMock = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/api/path", () => ({ join: joinMock }))

const linkedControl = vi.hoisted(() => ({ failNext: false }))
vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    loadAllLinkedSkillsContent: (...args: [Parameters<typeof actual.loadAllLinkedSkillsContent>[0]]) => {
      if (linkedControl.failNext) {
        linkedControl.failNext = false
        return Promise.reject(new Error("linked boom"))
      }
      return actual.loadAllLinkedSkillsContent(...args)
    },
  }
})

const dndCapture = vi.hoisted(() => ({ onDragEnd: null as null | ((event: unknown) => unknown) }))
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>()
  const { createElement: h } = await import("react")
  return {
    ...actual,
    DndContext: (props: Record<string, unknown>) => {
      dndCapture.onDragEnd = props.onDragEnd as (event: unknown) => unknown
      return h(actual.DndContext as never, props as never)
    },
  }
})

let savedConfigContent = ""
let importFileContent: string | null = null
let importFileShouldThrow = false
let writeShouldFailNext = false

function defaultFixture(): string {
  return JSON.stringify({
    version: 1,
    selectedSkillId: "skill:b",
    disabledSkillIds: [],
    skills: [
      {
        id: "skill:a",
        name: "三翻四抖",
        description: "三次转折，四次震惊。",
        kind: ["structure"],
        stages: ["planning"],
        modes: ["standard"],
        content: "每章设置三次局势变化和四次信息冲击。",
        source: "uploaded",
        priority: 50,
        tags: [],
        categoryId: "cat:plot",
        createdAt: 50,
        updatedAt: 200,
      },
      {
        id: "skill:b",
        name: "伏笔检查",
        description: "",
        kind: ["style"],
        stages: ["drafting"],
        modes: ["fast"],
        content: "检查本章埋下的伏笔是否回收。",
        source: "uploaded",
        priority: 50,
        tags: [],
        categoryId: "",
        createdAt: 40,
        updatedAt: 100,
      },
      {
        id: "skill:c",
        name: "外链技能",
        description: "",
        kind: ["style"],
        stages: ["drafting"],
        modes: ["standard"],
        content: "外链占位正文",
        source: "linked",
        linkedPath: "D:/ext/skill.md",
        priority: 50,
        tags: [],
        categoryId: "cat:plot",
        createdAt: 30,
        updatedAt: 150,
      },
    ],
    categories: [
      { id: "cat:plot", name: "情节" },
      { id: "cat:style", name: "风格" },
    ],
  })
}

async function flushEffects(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function renderPanel() {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(WritingSkillLibrarySidebarPanel))
  })
  await flushEffects()
  return { container, root }
}

function unmountPanel(root: Root, container: HTMLElement) {
  act(() => {
    root.unmount()
  })
  container.remove()
}

async function click(el: HTMLElement | null) {
  if (!el) throw new Error("element not found")
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  await flushEffects()
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes(text),
    ) ?? null
  )
}

async function typeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    setter?.call(input, value)
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await flushEffects()
}

async function pressKey(el: HTMLElement, key: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  })
  await flushEffects()
}

function checkboxForSkill(container: HTMLElement, skillName: string): HTMLInputElement {
  const btn = findButton(container, skillName)
  if (!btn) throw new Error(`skill button not found: ${skillName}`)
  const card = btn.closest("div.mb-2") ?? btn.parentElement
  const checkbox = card?.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!checkbox) throw new Error(`checkbox not found for: ${skillName}`)
  return checkbox
}

function categoryRow(container: HTMLElement, name: string): HTMLElement | null {
  const btn = findButton(container, name)
  return (btn?.closest("div.group") as HTMLElement | null) ?? null
}

async function toggleCheckbox(checkbox: HTMLInputElement) {
  await act(async () => {
    checkbox.click()
  })
  await flushEffects()
}

beforeEach(() => {
  vi.clearAllMocks()
  dndCapture.onDragEnd = null
  linkedControl.failNext = false
  savedConfigContent = defaultFixture()
  importFileContent = null
  importFileShouldThrow = false
  writeShouldFailNext = false
  dialogOpenMock.mockResolvedValue(null)
  joinMock.mockImplementation(async (...parts: string[]) => parts.join("/"))
  readFileMock.mockImplementation(async (path: string) => {
    const p = String(path)
    if (p.includes("writing-skills.json")) {
      if (savedConfigContent) return savedConfigContent
      throw new Error("missing config")
    }
    if (importFileShouldThrow) throw new Error("read boom")
    if (importFileContent !== null) return importFileContent
    throw new Error("missing import file")
  })
  writeFileAtomicMock.mockImplementation(async (path: string, content: string) => {
    if (writeShouldFailNext) {
      writeShouldFailNext = false
      throw new Error("write boom")
    }
    if (String(path).includes("writing-skills.json")) savedConfigContent = content
  })
  useWikiStore.getState().setProject({ id: "p1", name: "测试项目", path: "C:/project" })
  ;(useWikiStore.getState() as unknown as { setWritingSkillLibraryDraftDirty: (v: boolean) => void }).setWritingSkillLibraryDraftDirty(false)
  ;(useWikiStore.getState() as unknown as { setSelectedWritingSkillLibrarySkillId: (v: string | null) => void }).setSelectedWritingSkillLibrarySkillId(null)
  vi.spyOn(window, "confirm").mockReturnValue(true)
})

describe("WritingSkillLibrarySidebarPanel 渲染与加载", () => {
  it("加载后展示标题、分类、技能与引用标记", async () => {
    const { container, root } = await renderPanel()
    expect(container.querySelector('[data-testid="writing-skill-library-sidebar"]')).not.toBeNull()
    expect(container.textContent).toContain("写作技能")
    expect(container.textContent).toContain("全部")
    expect(container.textContent).toContain("未分类")
    expect(container.textContent).toContain("最近使用")
    expect(container.textContent).toContain("情节")
    expect(container.textContent).toContain("风格")
    expect(container.textContent).toContain("三翻四抖")
    expect(container.textContent).toContain("伏笔检查")
    expect(container.textContent).toContain("外链技能")
    // linked 来源展示“引用”徽标；无说明的技能展示占位文案
    expect(container.textContent).toContain("引用")
    expect(container.textContent).toContain("未填写说明")
    // 初始无消息条
    expect(container.textContent).not.toContain("已保存")
    unmountPanel(root, container)
  })

  it("最近使用只收录非内置技能（内置技能不出现在最近列表）", async () => {
    const { container, root } = await renderPanel()
    const skillNames = () =>
      Array.from(container.querySelectorAll("span.font-medium"))
        .map((s) => s.textContent?.trim() ?? "")
        .filter(Boolean)
    const fixtureNames = new Set(["三翻四抖", "伏笔检查", "外链技能"])
    const builtinNames = skillNames().filter((n) => !fixtureNames.has(n))
    expect(builtinNames.length).toBeGreaterThan(0)
    await click(findButton(container, "最近使用"))
    const recentNames = skillNames()
    expect(recentNames).toContain("三翻四抖")
    expect(recentNames).toContain("外链技能")
    for (const name of builtinNames) expect(recentNames).not.toContain(name)
    unmountPanel(root, container)
  })

  it("未分类过滤只展示无分类技能", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "未分类"))
    expect(container.textContent).toContain("伏笔检查")
    expect(container.textContent).not.toContain("三翻四抖")
    expect(container.textContent).not.toContain("外链技能")
    unmountPanel(root, container)
  })

  it("点全部回到全量列表", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "风格"))
    expect(container.textContent).toContain("还没有写作技能")
    await click(findButton(container, "全部"))
    expect(container.textContent).toContain("三翻四抖")
    expect(container.textContent).toContain("伏笔检查")
    unmountPanel(root, container)
  })

  it("点选空分类展示空态提示", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "风格"))
    expect(container.textContent).toContain("还没有写作技能")
    unmountPanel(root, container)
  })

  it("加载失败展示错误条", async () => {
    joinMock.mockRejectedValueOnce(new Error("join boom"))
    const { container, root } = await renderPanel()
    expect(container.textContent).toContain("写作技能加载失败")
    // config 为 null 时最近使用入口不渲染
    expect(findButton(container, "最近使用")).toBeNull()
    unmountPanel(root, container)
  })

  it("关联内容加载失败回退到原始配置（技能仍可展示）", async () => {
    linkedControl.failNext = true
    const { container, root } = await renderPanel()
    expect(container.textContent).toContain("三翻四抖")
    expect(container.textContent).toContain("伏笔检查")
    expect(container.textContent).toContain("外链技能")
    expect(container.textContent).not.toContain("写作技能加载失败")
    unmountPanel(root, container)
  })

  it("卸载会取消挂起的加载（then 路径不再落盘状态）", async () => {
    let resolveRead!: (v: string) => void
    readFileMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        }),
    )
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(WritingSkillLibrarySidebarPanel))
    })
    act(() => {
      root.unmount()
    })
    await act(async () => {
      resolveRead(defaultFixture())
    })
    await flushEffects()
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    container.remove()
  })

  it("卸载会取消挂起的加载（catch 路径不再置错误）", async () => {
    let rejectJoin!: (e: Error) => void
    joinMock.mockImplementationOnce(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectJoin = reject
        }),
    )
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(WritingSkillLibrarySidebarPanel))
    })
    act(() => {
      root.unmount()
    })
    await act(async () => {
      rejectJoin(new Error("join boom"))
    })
    await flushEffects()
    container.remove()
  })
})

describe("选择、新建与草稿门控", () => {
  it("未打开项目时操作按钮禁用且新建不落盘", async () => {
    useWikiStore.getState().setProject(null)
    const { container, root } = await renderPanel()
    // project 为 null 时加载的是内置配置，且操作按钮被禁用
    const createBtn = findButton(container, "新建技能")
    expect(createBtn?.disabled).toBe(true)
    expect(findButton(container, "导入")?.disabled).toBe(true)
    // 绕过 disabled 直接派发点击：handler 门控提前返回，不落盘也不报错
    await act(async () => {
      createBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await flushEffects()
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain("已保存")
    unmountPanel(root, container)
  })

  it("新建技能落盘并选中", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "新建技能"))
    expect(container.textContent).toContain("已保存")
    const saved = JSON.parse(savedConfigContent)
    const created = saved.skills.find((s: { name: string }) => s.name === "新建写作技能")
    expect(created).toBeTruthy()
    expect(saved.selectedSkillId).toBe(created.id)
    expect(container.textContent).toContain("新建写作技能")
    unmountPanel(root, container)
  })

  it("在选中分类下新建技能会归入该分类", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "风格"))
    await click(findButton(container, "新建技能"))
    const saved = JSON.parse(savedConfigContent)
    const created = saved.skills.find((s: { name: string }) => s.name === "新建写作技能")
    expect(created?.categoryId).toBe("cat:style")
    unmountPanel(root, container)
  })

  it("选择技能会更新选中并触碰使用时间", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "伏笔检查"))
    const saved = JSON.parse(savedConfigContent)
    expect(saved.selectedSkillId).toBe("skill:b")
    expect(container.textContent).toContain("已保存")
    unmountPanel(root, container)
  })

  it("草稿脏时拒绝确认则不切换技能", async () => {
    ;(useWikiStore.getState() as unknown as { setWritingSkillLibraryDraftDirty: (v: boolean) => void }).setWritingSkillLibraryDraftDirty(true)
    vi.spyOn(window, "confirm").mockReturnValue(false)
    const { container, root } = await renderPanel()
    await click(findButton(container, "伏笔检查"))
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    expect(useWikiStore.getState().writingSkillLibraryDraftDirty).toBe(true)
    unmountPanel(root, container)
  })

  it("草稿脏时确认后切换并清脏", async () => {
    ;(useWikiStore.getState() as unknown as { setWritingSkillLibraryDraftDirty: (v: boolean) => void }).setWritingSkillLibraryDraftDirty(true)
    vi.spyOn(window, "confirm").mockReturnValue(true)
    const { container, root } = await renderPanel()
    await click(findButton(container, "伏笔检查"))
    expect(writeFileAtomicMock).toHaveBeenCalled()
    expect(useWikiStore.getState().writingSkillLibraryDraftDirty).toBe(false)
    unmountPanel(root, container)
  })

  it("草稿脏时新建技能同样受确认门控", async () => {
    ;(useWikiStore.getState() as unknown as { setWritingSkillLibraryDraftDirty: (v: boolean) => void }).setWritingSkillLibraryDraftDirty(true)
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
    const { container, root } = await renderPanel()
    await click(findButton(container, "新建技能"))
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    await click(findButton(container, "新建技能"))
    expect(writeFileAtomicMock).toHaveBeenCalled()
    expect(useWikiStore.getState().writingSkillLibraryDraftDirty).toBe(false)
    unmountPanel(root, container)
  })

  it("草稿脏时开关技能同样受确认门控", async () => {
    ;(useWikiStore.getState() as unknown as { setWritingSkillLibraryDraftDirty: (v: boolean) => void }).setWritingSkillLibraryDraftDirty(true)
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
    const { container, root } = await renderPanel()
    await toggleCheckbox(checkboxForSkill(container, "伏笔检查"))
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    await toggleCheckbox(checkboxForSkill(container, "伏笔检查"))
    expect(writeFileAtomicMock).toHaveBeenCalled()
    unmountPanel(root, container)
  })

  it("草稿脏时导入同样受确认门控", async () => {
    ;(useWikiStore.getState() as unknown as { setWritingSkillLibraryDraftDirty: (v: boolean) => void }).setWritingSkillLibraryDraftDirty(true)
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
    dialogOpenMock.mockResolvedValue("D:/tmp/笔记.md")
    importFileContent = "外链规则正文"
    const { container, root } = await renderPanel()
    await click(findButton(container, "导入"))
    expect(dialogOpenMock).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    await click(findButton(container, "导入"))
    expect(dialogOpenMock).toHaveBeenCalled()
    unmountPanel(root, container)
  })

  it("保存失败提示保存失败", async () => {
    writeShouldFailNext = true
    const { container, root } = await renderPanel()
    await click(findButton(container, "新建技能"))
    expect(container.textContent).toContain("写作技能保存失败")
    unmountPanel(root, container)
  })
})

describe("导入技能", () => {
  it("取消文件对话框不做任何事", async () => {
    dialogOpenMock.mockResolvedValue(null)
    const { container, root } = await renderPanel()
    await click(findButton(container, "导入"))
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain("已保存")
    unmountPanel(root, container)
  })

  it("非字符串选择结果直接返回", async () => {
    dialogOpenMock.mockResolvedValue(["D:/tmp/a.json"])
    const { container, root } = await renderPanel()
    await click(findButton(container, "导入"))
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    unmountPanel(root, container)
  })

  it("导入 md 文件按文件名建技能", async () => {
    dialogOpenMock.mockResolvedValue("D:/tmp/笔记.md")
    importFileContent = "外链规则正文"
    const { container, root } = await renderPanel()
    await click(findButton(container, "导入"))
    const saved = JSON.parse(savedConfigContent)
    expect(saved.skills.some((s: { name: string }) => s.name === "笔记")).toBe(true)
    expect(container.textContent).toContain("已保存")
    unmountPanel(root, container)
  })

  it("在选中分类下导入会归入该分类", async () => {
    dialogOpenMock.mockResolvedValue("D:/tmp/笔记.txt")
    importFileContent = "外链规则正文"
    const { container, root } = await renderPanel()
    await click(findButton(container, "风格"))
    await click(findButton(container, "导入"))
    const saved = JSON.parse(savedConfigContent)
    const created = saved.skills.find((s: { name: string }) => s.name === "笔记")
    expect(created?.categoryId).toBe("cat:style")
    unmountPanel(root, container)
  })

  it("导入合法 json 文件", async () => {
    dialogOpenMock.mockResolvedValue("D:/tmp/skill.json")
    importFileContent = JSON.stringify({ name: "JSON技能", content: "正文内容", description: "d" })
    const { container, root } = await renderPanel()
    await click(findButton(container, "导入"))
    const saved = JSON.parse(savedConfigContent)
    expect(saved.skills.some((s: { name: string }) => s.name === "JSON技能")).toBe(true)
    unmountPanel(root, container)
  })

  it("导入非法 json 提示格式不正确", async () => {
    dialogOpenMock.mockResolvedValue("D:/tmp/bad.json")
    importFileContent = '{"foo": 1}'
    const { container, root } = await renderPanel()
    await click(findButton(container, "导入"))
    expect(container.textContent).toContain("JSON 文件格式不正确，导入失败")
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    unmountPanel(root, container)
  })

  it("导入读取失败提示导入失败", async () => {
    dialogOpenMock.mockResolvedValue("D:/tmp/笔记.md")
    importFileShouldThrow = true
    const { container, root } = await renderPanel()
    await click(findButton(container, "导入"))
    expect(container.textContent).toContain("导入失败")
    unmountPanel(root, container)
  })
})

describe("开关技能", () => {
  it("取消勾选停用、重新勾选恢复", async () => {
    const { container, root } = await renderPanel()
    const checkbox = checkboxForSkill(container, "伏笔检查")
    expect(checkbox.checked).toBe(true)
    await toggleCheckbox(checkbox)
    let saved = JSON.parse(savedConfigContent)
    expect(saved.disabledSkillIds).toContain("skill:b")
    expect(checkboxForSkill(container, "伏笔检查").checked).toBe(false)
    await toggleCheckbox(checkboxForSkill(container, "伏笔检查"))
    saved = JSON.parse(savedConfigContent)
    expect(saved.disabledSkillIds).not.toContain("skill:b")
    unmountPanel(root, container)
  })
})

describe("分类管理", () => {
  it("输入分类名回车创建", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "+ 新建分类"))
    const input = container.querySelector('input[placeholder="输入分类名称"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    await typeInput(input!, "新分类")
    await pressKey(input!, "Enter")
    expect(container.textContent).toContain("新分类")
    const saved = JSON.parse(savedConfigContent)
    expect(saved.categories.some((c: { name: string }) => c.name === "新分类")).toBe(true)
    unmountPanel(root, container)
  })

  it("空分类名回车直接收起且不落盘", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "+ 新建分类"))
    const input = container.querySelector('input[placeholder="输入分类名称"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    await pressKey(input!, "Enter")
    expect(container.querySelector('input[placeholder="输入分类名称"]')).toBeNull()
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    unmountPanel(root, container)
  })

  it("新建分类时 Escape 取消", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "+ 新建分类"))
    const input = container.querySelector('input[placeholder="输入分类名称"]') as HTMLInputElement | null
    await typeInput(input!, "不要这个")
    await pressKey(input!, "Escape")
    expect(container.querySelector('input[placeholder="输入分类名称"]')).toBeNull()
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    unmountPanel(root, container)
  })

  it("失焦自动创建分类", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "+ 新建分类"))
    const input = container.querySelector('input[placeholder="输入分类名称"]') as HTMLInputElement | null
    await typeInput(input!, "失焦分类")
    await act(async () => {
      input!.focus()
      input!.blur()
    })
    await flushEffects()
    expect(container.textContent).toContain("失焦分类")
    unmountPanel(root, container)
  })

  it("重命名分类", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "情节"))
    const renameBtn = container.querySelector('button[aria-label="重命名"]')
    expect(renameBtn).not.toBeNull()
    await click(renameBtn as HTMLElement)
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="text"]'))
    const editInput = inputs.find((i) => i.value === "情节")
    expect(editInput).toBeTruthy()
    await typeInput(editInput!, "情节线")
    await pressKey(editInput!, "Enter")
    expect(container.textContent).toContain("情节线")
    const saved = JSON.parse(savedConfigContent)
    expect(saved.categories.find((c: { id: string }) => c.id === "cat:plot")?.name).toBe("情节线")
    unmountPanel(root, container)
  })

  it("重命名为空则取消", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "情节"))
    await click(container.querySelector('button[aria-label="重命名"]') as HTMLElement)
    const editInput =
      Array.from(container.querySelectorAll<HTMLInputElement>('input[type="text"]')).find(
        (i) => i.value === "情节",
      )!
    await typeInput(editInput, "   ")
    await pressKey(editInput, "Enter")
    const saved = JSON.parse(savedConfigContent)
    expect(saved.categories.find((c: { id: string }) => c.id === "cat:plot")?.name).toBe("情节")
    unmountPanel(root, container)
  })

  it("重命名框 Escape 取消编辑", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "情节"))
    await click(container.querySelector('button[aria-label="重命名"]') as HTMLElement)
    const editInput =
      Array.from(container.querySelectorAll<HTMLInputElement>('input[type="text"]')).find(
        (i) => i.value === "情节",
      )!
    await typeInput(editInput, "改坏了")
    await pressKey(editInput, "Escape")
    expect(container.textContent).toContain("情节")
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    unmountPanel(root, container)
  })

  it("重命名框失焦触发改名", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "情节"))
    await click(container.querySelector('button[aria-label="重命名"]') as HTMLElement)
    const editInput =
      Array.from(container.querySelectorAll<HTMLInputElement>('input[type="text"]')).find(
        (i) => i.value === "情节",
      )!
    await typeInput(editInput, "失焦改名")
    await act(async () => {
      editInput.focus()
      editInput.blur()
    })
    await flushEffects()
    expect(container.textContent).toContain("失焦改名")
    unmountPanel(root, container)
  })

  it("悬停分类展示快捷操作", async () => {
    const { container, root } = await renderPanel()
    const row = categoryRow(container, "风格")
    expect(row).not.toBeNull()
    expect(row!.querySelector('button[aria-label="重命名"]')).toBeNull()
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    })
    await flushEffects()
    expect(row!.querySelector('button[aria-label="重命名"]')).not.toBeNull()
    await act(async () => {
      row!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }))
    })
    await flushEffects()
    expect(row!.querySelector('button[aria-label="重命名"]')).toBeNull()
    unmountPanel(root, container)
  })

  it("删除分类时取消则保留", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false)
    const { container, root } = await renderPanel()
    await click(findButton(container, "情节"))
    await click(container.querySelector('button[aria-label="删除"]') as HTMLElement)
    expect(container.textContent).toContain("情节")
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    unmountPanel(root, container)
  })

  it("删除选中的分类后回到全部", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    const { container, root } = await renderPanel()
    await click(findButton(container, "情节"))
    expect(container.textContent).not.toContain("伏笔检查")
    await click(container.querySelector('button[aria-label="删除"]') as HTMLElement)
    const saved = JSON.parse(savedConfigContent)
    expect(saved.categories.some((c: { id: string }) => c.id === "cat:plot")).toBe(false)
    // 分类下技能变为未分类
    expect(saved.skills.find((s: { id: string }) => s.id === "skill:a")?.categoryId).toBe("")
    // 回到全部后全部技能可见
    expect(container.textContent).toContain("三翻四抖")
    expect(container.textContent).toContain("伏笔检查")
    unmountPanel(root, container)
  })
})

describe("分类拖拽排序", () => {
  it("无 over / 同位 / 未知 id 直接返回", async () => {
    const { container, root } = await renderPanel()
    expect(dndCapture.onDragEnd).not.toBeNull()
    const before = savedConfigContent
    await act(async () => {
      await (dndCapture.onDragEnd as (e: unknown) => Promise<void>)({
        active: { id: "cat:plot" },
        over: null,
      })
    })
    await act(async () => {
      await (dndCapture.onDragEnd as (e: unknown) => Promise<void>)({
        active: { id: "cat:plot" },
        over: { id: "cat:plot" },
      })
    })
    await act(async () => {
      await (dndCapture.onDragEnd as (e: unknown) => Promise<void>)({
        active: { id: "cat:zzz" },
        over: { id: "cat:plot" },
      })
    })
    await act(async () => {
      await (dndCapture.onDragEnd as (e: unknown) => Promise<void>)({
        active: { id: { foo: 1 } },
        over: { id: "cat:style" },
      })
    })
    await flushEffects()
    expect(savedConfigContent).toBe(before)
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    unmountPanel(root, container)
  })

  it("有效拖拽交换分类顺序并落盘", async () => {
    const { container, root } = await renderPanel()
    await act(async () => {
      await (dndCapture.onDragEnd as (e: unknown) => Promise<void>)({
        active: { id: "cat:plot" },
        over: { id: "cat:style" },
      })
    })
    await flushEffects()
    const saved = JSON.parse(savedConfigContent)
    const ids = saved.categories.map((c: { id: string }) => c.id)
    // 内置路由分类会被合并进配置，只断言两者相对顺序发生交换
    expect(ids).toContain("cat:plot")
    expect(ids).toContain("cat:style")
    expect(ids.indexOf("cat:style")).toBeLessThan(ids.indexOf("cat:plot"))
    expect(container.textContent).toContain("已保存")
    unmountPanel(root, container)
  })
})
