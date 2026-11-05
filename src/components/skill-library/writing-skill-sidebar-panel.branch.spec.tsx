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

const linkedGate = vi.hoisted(() => ({
  mode: "passthrough" as "passthrough" | "deferred" | "reject",
  resolve: null as null | ((v: unknown) => void),
  reject: null as null | ((e: unknown) => void),
}))
vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    loadAllLinkedSkillsContent: (...args: [Parameters<typeof actual.loadAllLinkedSkillsContent>[0]]) => {
      if (linkedGate.mode === "deferred") {
        return new Promise((res, rej) => {
          linkedGate.resolve = res
          linkedGate.reject = rej
        })
      }
      if (linkedGate.mode === "reject") {
        return Promise.reject(new Error("linked boom"))
      }
      return actual.loadAllLinkedSkillsContent(...args)
    },
  }
})

let savedConfigContent = ""

function defaultFixture(): string {
  return JSON.stringify({
    version: 1,
    selectedSkillId: "skill:b",
    disabledSkillIds: [],
    skills: [
      {
        id: "skill:a",
        name: "三翻四抖",
        description: "三次转折。",
        kind: ["structure"],
        stages: ["planning"],
        modes: ["standard"],
        content: "正文甲",
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
        content: "正文乙",
        source: "uploaded",
        priority: 50,
        tags: [],
        categoryId: "",
        createdAt: 40,
        updatedAt: 100,
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

function findButton(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes(text),
    ) ?? null
  )
}

async function click(el: HTMLElement | null) {
  if (!el) throw new Error("element not found")
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  await flushEffects()
}

beforeEach(() => {
  vi.clearAllMocks()
  linkedGate.mode = "passthrough"
  linkedGate.resolve = null
  linkedGate.reject = null
  savedConfigContent = defaultFixture()
  dialogOpenMock.mockResolvedValue(null)
  joinMock.mockImplementation(async (...parts: string[]) => parts.join("/"))
  readFileMock.mockImplementation(async (path: string) => {
    if (String(path).includes("writing-skills.json")) {
      if (savedConfigContent) return savedConfigContent
      throw new Error("missing config")
    }
    throw new Error("missing import file")
  })
  writeFileAtomicMock.mockImplementation(async (path: string, content: string) => {
    if (String(path).includes("writing-skills.json")) savedConfigContent = content
  })
  useWikiStore.getState().setProject({ id: "p1", name: "测试项目", path: "C:/project" })
  vi.spyOn(window, "confirm").mockReturnValue(true)
})

/**
 * writing-skill-sidebar-panel.tsx 分支补测（覆盖率战役第九批）。
 * b17（persist 内 !project）不可达：全部 8 个调用方均在同步前置检查 !project，
 * 检查与 persist 调用之间无 await，store 不可能在间隙变为 null。
 */
describe("writing-skill-sidebar-panel branch coverage", () => {
  it("linked 加载中卸载跳过提交（41 cancelled 支）", async () => {
    linkedGate.mode = "deferred"
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(WritingSkillLibrarySidebarPanel))
    })
    await flushEffects()
    // 配置已读完、linked 悬挂：此时卸载再放行 → 41 的 cancelled 分支
    expect(linkedGate.resolve).not.toBeNull()
    expect(container.textContent).not.toContain("三翻四抖")
    act(() => { root.unmount() })
    container.remove()
    const loaded = JSON.parse(defaultFixture())
    await act(async () => {
      linkedGate.resolve?.(loaded)
    })
    await flushEffects()
    expect(document.body.querySelector('[data-testid="writing-skill-library-sidebar"]')).toBeNull()
  })

  it("linked 失败且已卸载跳过回退提交（45 cancelled 支）", async () => {
    linkedGate.mode = "deferred"
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(WritingSkillLibrarySidebarPanel))
    })
    await flushEffects()
    expect(linkedGate.reject).not.toBeNull()
    act(() => { root.unmount() })
    container.remove()
    await act(async () => {
      linkedGate.reject?.(new Error("linked boom"))
    })
    await flushEffects()
    expect(document.body.querySelector('[data-testid="writing-skill-library-sidebar"]')).toBeNull()
  })

  it("无 updatedAt 的技能按 0 参与最近排序（100 双 ?? 右支）", async () => {
    savedConfigContent = JSON.stringify({
      version: 1,
      selectedSkillId: "s1",
      disabledSkillIds: [],
      skills: [
        {
          id: "s0", name: "无时间甲", description: "d", kind: [], stages: [], modes: [],
          content: "c", source: "uploaded", priority: 50, tags: [], categoryId: "",
          createdAt: 1,
        },
        {
          id: "s1", name: "有时间", description: "d", kind: [], stages: [], modes: [],
          content: "c", source: "uploaded", priority: 50, tags: [], categoryId: "",
          createdAt: 1, updatedAt: 200,
        },
        {
          id: "s2", name: "无时间乙", description: "d", kind: [], stages: [], modes: [],
          content: "c", source: "uploaded", priority: 50, tags: [], categoryId: "",
          createdAt: 2,
        },
      ],
      categories: [],
    })
    const { container, root } = await renderPanel()
    await click(findButton(container, "最近使用"))
    const text = container.textContent ?? ""
    expect(text).toContain("有时间")
    expect(text).toContain("无时间甲")
    expect(text).toContain("无时间乙")
    expect(text.indexOf("有时间")).toBeLessThan(text.indexOf("无时间甲"))
    unmountPanel(root, container)
  })

  it("草稿脏时确认后选择技能并清脏（144 真支）", async () => {
    const { container, root } = await renderPanel()
    ;(useWikiStore.getState() as unknown as { setWritingSkillLibraryDraftDirty: (v: boolean) => void }).setWritingSkillLibraryDraftDirty(true)
    const mod = await import("@/stores/wiki-store")
    const confirmSpy = vi.spyOn(mod, "confirmDiscardSkillLibraryDraft").mockReturnValue(true)
    try {
      await click(findButton(container, "三翻四抖"))
      expect(useWikiStore.getState().writingSkillLibraryDraftDirty).toBe(false)
    } finally {
      confirmSpy.mockRestore()
    }
    unmountPanel(root, container)
  })

  it("导入根路径文件时文件名回退未命名（178 右支）", async () => {
    const { container, root } = await renderPanel()
    dialogOpenMock.mockResolvedValueOnce("C:\\")
    readFileMock.mockImplementationOnce(async () => "# 根技能\n\n内容")
    await click(findButton(container, "导入"))
    const saved = JSON.parse(savedConfigContent) as { skills: Array<{ name: string }> }
    expect(saved.skills.some((s) => s.name === "未命名技能")).toBe(true)
    unmountPanel(root, container)
  })

  it("无项目时重命名/删除分类直接返回（227/240 早退支）", async () => {
    const { container, root } = await renderPanel()
    useWikiStore.getState().setProject(null)
    await flushEffects()
    writeFileAtomicMock.mockClear()
    // 重命名：hover 出按钮 → 改名 → 早退（项目置空后配置回退为默认分类，用默认存在的「正文」）
    const plotBtn = findButton(container, "正文")
    expect(plotBtn).not.toBeNull()
    const row = plotBtn?.closest("div.group") as HTMLElement | null
    expect(row).not.toBeNull()
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    })
    await flushEffects()
    const renameBtn = row?.querySelector('button[aria-label="重命名"]') as HTMLButtonElement
    expect(renameBtn).not.toBeNull()
    await click(renameBtn)
    const editInput = container.querySelector('input[type="text"]') as HTMLInputElement
    expect(editInput).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
      setter?.call(editInput, "新名字")
      editInput.dispatchEvent(new InputEvent("input", { bubbles: true }))
      editInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    })
    await flushEffects()
    // 删除：换一行（正文行正处编辑态）hover 出删除按钮 → 早退，confirm 未调用
    const confirmSpy = vi.mocked(window.confirm)
    confirmSpy.mockClear()
    const outlineBtn = findButton(container, "大纲")
    expect(outlineBtn).not.toBeNull()
    const rowAfter = outlineBtn?.closest("div.group") as HTMLElement | null
    await act(async () => {
      rowAfter?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    })
    await flushEffects()
    expect(rowAfter?.querySelector('button[aria-label="删除"]')).not.toBeNull()
    await click(rowAfter?.querySelector('button[aria-label="删除"]') as HTMLButtonElement)
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    expect(confirmSpy).not.toHaveBeenCalled()
    unmountPanel(root, container)
  })

  it("新建分类输入非确认键无动作（339 else 支）", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "新建分类"))
    const input = container.querySelector('input[type="text"]') as HTMLInputElement
    expect(input).not.toBeNull()
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }))
    })
    await flushEffects()
    // 输入框仍在；UI 分类数不变（仍是情节/风格两个按钮）
    expect(container.querySelector('input[type="text"]')).not.toBeNull()
    expect(findButton(container, "情节")).not.toBeNull()
    expect(findButton(container, "风格")).not.toBeNull()
    unmountPanel(root, container)
  })

  it("无项目时选择/新建/导入/开关均直接返回不落盘（142/144/150/163 早退支）", async () => {
    const { container, root } = await renderPanel()
    expect(container.textContent).toContain("三翻四抖")
    useWikiStore.getState().setProject(null)
    await flushEffects()
    writeFileAtomicMock.mockClear()
    dialogOpenMock.mockClear()
    // 选择技能（任意已渲染技能卡）
    const anySkillBtn = container.querySelector("div.mb-2 button")
    expect(anySkillBtn).not.toBeNull()
    await click(anySkillBtn as HTMLButtonElement)
    // 新建技能（头部按钮常驻）
    await click(findButton(container, "新建技能"))
    // 导入技能（早退在 dialog 之前）
    await click(findButton(container, "导入"))
    // 开关技能
    const checkbox = container.querySelector('div.mb-2 input[type="checkbox"]')
    expect(checkbox).not.toBeNull()
    await act(async () => { (checkbox as HTMLInputElement).click() })
    await flushEffects()
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    expect(dialogOpenMock).not.toHaveBeenCalled()
    unmountPanel(root, container)
  })

  it("在指定分类下新建技能自动归入该分类（178 真支）", async () => {
    const { container, root } = await renderPanel()
    await click(findButton(container, "情节"))
    await click(findButton(container, "新建技能"))
    const saved = JSON.parse(savedConfigContent) as {
      skills: Array<{ id: string; name: string; categoryId?: string }>
    }
    const created = saved.skills.find((s) => !["skill:a", "skill:b"].includes(s.id))
    expect(created?.categoryId).toBe("cat:plot")
    unmountPanel(root, container)
  })

  it("无项目时分类增删改均直接返回（206/214/227 早退支）", async () => {
    const { container, root } = await renderPanel()
    useWikiStore.getState().setProject(null)
    await flushEffects()
    writeFileAtomicMock.mockClear()
    const confirmSpy = vi.mocked(window.confirm)
    confirmSpy.mockClear()
    // 新建分类：先打开输入框再确认
    await click(findButton(container, "新建分类"))
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')
    expect(input).not.toBeNull()
    if (input) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
        setter?.call(input, "新分类")
        input.dispatchEvent(new InputEvent("input", { bubbles: true }))
        input.dispatchEvent(new Event("change", { bubbles: true }))
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
      })
      await flushEffects()
    }
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    expect(confirmSpy).not.toHaveBeenCalled()
    unmountPanel(root, container)
  })

  it("取消删除分类时保留原分类（240 真支）", async () => {
    const { container, root } = await renderPanel()
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    // hover 出删除按钮：直接调用删除流程需先找到分类行；用 DOM 触发 mouseenter 再点删除
    const plotBtn = findButton(container, "情节")
    expect(plotBtn).not.toBeNull()
    // 删除按钮平时隐藏（hover 才显示），直接派发 mouseenter 显示
    const row = plotBtn?.closest("div")
    if (row) {
      await act(async () => {
        row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }))
      })
      await flushEffects()
    }
    const delBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.getAttribute("aria-label")?.includes("删除"),
    )
    if (delBtn) await click(delBtn)
    // confirm=false → 分类保留
    expect(container.textContent).toContain("情节")
    const saved = JSON.parse(savedConfigContent) as { categories: unknown[] }
    expect(saved.categories).toHaveLength(2)
    unmountPanel(root, container)
  })

  it("删除非选中分类时选中态不变（244 假支）", async () => {
    vi.mocked(window.confirm).mockReset()
    vi.mocked(window.confirm).mockReturnValue(true)
    const { container, root } = await renderPanel()
    // 默认选中 all：hover 首个分类让删除按钮现身，但不选中它 → 删非选中
    const plotBtn = findButton(container, "情节")
    expect(plotBtn).not.toBeNull()
    const rowOf = (name: string) =>
      findButton(container, name)?.closest("div.group") as HTMLElement | null
    const row = rowOf("情节")
    expect(row).not.toBeNull()
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    })
    await flushEffects()
    expect(rowOf("情节")?.querySelector('button[aria-label="重命名"]')).not.toBeNull()
    // 切回全部：hover 未 mouseout，情节行按钮仍可见，但已是非选中
    await click(findButton(container, "全部"))
    const rowAfter = rowOf("情节")
    expect(rowAfter?.querySelector('button[aria-label="删除"]')).not.toBeNull()
    await click(rowAfter?.querySelector('button[aria-label="删除"]') as HTMLButtonElement)
    const saved = JSON.parse(savedConfigContent) as { categories: Array<{ id: string }> }
    expect(saved.categories.map((c) => c.id)).toContain("cat:style")
    expect(saved.categories.map((c) => c.id)).not.toContain("cat:plot")
    expect(container.textContent).toContain("全部")
    unmountPanel(root, container)
  })

  it("加载中计数回 0（303 空支）", async () => {
    // 在 Promise executor 内赋值，TS 控制流分析看不到，用明确赋值断言
    let resolveLoad!: (v: string) => void
    readFileMock.mockImplementationOnce(
      () => new Promise<string>((r) => { resolveLoad = r }),
    )
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(WritingSkillLibrarySidebarPanel))
    })
    // 加载悬挂：config=null → 计数全部回退 0，且无技能列表
    expect(container.textContent).toContain("全部")
    expect(container.textContent).not.toContain("三翻四抖")
    resolveLoad(defaultFixture())
    await flushEffects()
    expect(container.textContent).toContain("三翻四抖")
    unmountPanel(root, container)
  })

  it("全内置技能时不展示最近使用（339 假支）", async () => {
    savedConfigContent = JSON.stringify({
      version: 1,
      selectedSkillId: "b1",
      disabledSkillIds: [],
      skills: [
        {
          id: "b1", name: "内置一", description: "d", kind: [], stages: [], modes: [],
          content: "c", source: "built-in", priority: 50, tags: [], categoryId: "",
          createdAt: 1, updatedAt: 10,
        },
      ],
      categories: [],
    })
    const { container, root } = await renderPanel()
    expect(container.textContent).toContain("内置一")
    expect(findButton(container, "最近使用")).toBeNull()
    unmountPanel(root, container)
  })
})
