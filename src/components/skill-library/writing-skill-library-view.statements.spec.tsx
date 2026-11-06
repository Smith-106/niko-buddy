// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { WritingSkillLibrarySidebarPanel, WritingSkillLibraryView } from "./writing-skill-library-view"

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

// 真实面板只会以 ok:true 回调 onImported，宿主的 `!result.ok` 守卫需要一条失败回执才能触达。
// 包装式 mock：仍然渲染真实面板（既有用例不受影响），同时曝光当次 props 供失败回执注入。
const packPanelProps = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock("@/components/skills/SkillPackPanel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/skills/SkillPackPanel")>()
  return {
    ...actual,
    SkillPackPanel: (props: Parameters<typeof actual.SkillPackPanel>[0]) => {
      packPanelProps.length = 0
      packPanelProps.push(props as unknown as Record<string, unknown>)
      return actual.SkillPackPanel(props)
    },
  }
})

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

async function click(button: HTMLElement | null) {
  if (!button) throw new Error("button not found")
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  await flushEffects()
}

describe("WritingSkillLibraryView 语句/分支收尾（20261105-ralph-coverage-100-2）", () => {
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

  async function waitForEnabledCheckbox(container: HTMLElement) {
    for (let i = 0; i < 30; i += 1) {
      const checkbox = container.querySelector<HTMLInputElement>(
        '[data-testid="writing-skill-enabled-checkbox"]',
      )
      if (checkbox) return checkbox
      await flushEffects()
    }
    throw new Error("enabled checkbox never mounted")
  }

  it("无项目时切换启用直接返回（203 行守卫命中，不写盘）", async () => {
    seedSkill()
    const { container, root } = await renderLibrary()
    await waitForEnabledCheckbox(container)
    writeFileAtomicMock.mockClear()

    // 项目关闭后视图重载为内置配置，启用复选框仅 saving 时禁用，仍可点击
    useWikiStore.getState().setProject(null as never)
    const checkbox = await waitForEnabledCheckbox(container)
    expect(checkbox.disabled).toBe(false)
    expect(checkbox.checked).toBe(true)
    await click(checkbox)

    // handleToggleEnabled 首行守卫命中：不落盘、不改启用态
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-testid="writing-skill-enabled-checkbox"]',
      )?.checked,
    ).toBe(true)
    cleanup(root, container)
  })

  it("脏草稿下取消放弃修改则切换启用直接返回（204 行）", async () => {
    seedSkill()
    const { container, root } = await renderLibrary()
    await setInputValue(container.querySelector('[data-testid="writing-skill-name-input"]')!, "三翻四抖-草稿")
    expect(useWikiStore.getState().writingSkillLibraryDraftDirty).toBe(true)
    writeFileAtomicMock.mockClear()

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    await click(container.querySelector('[data-testid="writing-skill-enabled-checkbox"]'))

    expect(confirmSpy).toHaveBeenCalledWith("当前技能还有未保存修改，确定放弃修改吗？")
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLInputElement>('[data-testid="writing-skill-name-input"]')?.value)
      .toBe("三翻四抖-草稿")
    expect(useWikiStore.getState().writingSkillLibraryDraftDirty).toBe(true)
    confirmSpy.mockRestore()
    cleanup(root, container)
  })

  it("脏草稿下确认放弃修改则切换启用落盘并清脏（205 行）", async () => {
    seedSkill()
    const { container, root } = await renderLibrary()
    await setInputValue(container.querySelector('[data-testid="writing-skill-name-input"]')!, "三翻四抖-草稿")
    writeFileAtomicMock.mockClear()

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    await click(container.querySelector('[data-testid="writing-skill-enabled-checkbox"]'))

    expect(writeFileAtomicMock).toHaveBeenCalled()
    const saved = JSON.parse(savedConfigContent)
    expect(saved.disabledSkillIds).toEqual(["skill:one"])
    expect(useWikiStore.getState().writingSkillLibraryDraftDirty).toBe(false)
    expect(container.textContent).toContain("已保存")
    confirmSpy.mockRestore()
    cleanup(root, container)
  })

  it("删除时用户取消则直接返回（214 行，不写盘）", async () => {
    seedSkill()
    const { container, root } = await renderLibrary()
    writeFileAtomicMock.mockClear()

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    await click(container.querySelector('[data-testid="writing-skill-delete-button"]'))

    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLInputElement>('[data-testid="writing-skill-name-input"]')?.value)
      .toBe("三翻四抖")
    confirmSpy.mockRestore()
    cleanup(root, container)
  })

  it("脏草稿下取消放弃修改则删除直接返回（211 行）", async () => {
    seedSkill()
    const { container, root } = await renderLibrary()
    await setInputValue(container.querySelector('[data-testid="writing-skill-name-input"]')!, "三翻四抖-草稿")
    writeFileAtomicMock.mockClear()

    // 两次 confirm 共用 window.confirm：第一次（放弃草稿）false 即直接返回
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false)
    await click(container.querySelector('[data-testid="writing-skill-delete-button"]'))

    expect(confirmSpy).toHaveBeenCalledWith("当前技能还有未保存修改，确定放弃修改吗？")
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLInputElement>('[data-testid="writing-skill-name-input"]')?.value)
      .toBe("三翻四抖-草稿")
    confirmSpy.mockRestore()
    cleanup(root, container)
  })

  it("脏草稿下两次确认则删除落盘并清脏（212 行）", async () => {
    seedSkill()
    const { container, root } = await renderLibrary()
    await setInputValue(container.querySelector('[data-testid="writing-skill-name-input"]')!, "三翻四抖-草稿")
    writeFileAtomicMock.mockClear()

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    await click(container.querySelector('[data-testid="writing-skill-delete-button"]'))

    expect(confirmSpy).toHaveBeenCalledTimes(2)
    expect(writeFileAtomicMock).toHaveBeenCalled()
    const saved = JSON.parse(savedConfigContent)
    expect(saved.skills.find((s: { id: string }) => s.id === "skill:one")).toBeUndefined()
    expect(useWikiStore.getState().writingSkillLibraryDraftDirty).toBe(false)
    confirmSpy.mockRestore()
    cleanup(root, container)
  })

  it("外链技能改名保存跳过正文校验与补丁（179/196 行 else）", async () => {
    seedSkill({ source: "linked", linkedPath: "C:/linked/skill.md", content: "旧内容" })
    // 外链正文走 linkedPath 读取：该路径返回旧内容，其余路径返回配置 JSON
    readFileMock.mockImplementation(async (path: string) => {
      if (path === "C:/linked/skill.md") return "旧内容"
      if (savedConfigContent) return savedConfigContent
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()
    expect(container.textContent).toContain("引用")

    await setInputValue(container.querySelector('[data-testid="writing-skill-name-input"]')!, "外链改名")
    writeFileAtomicMock.mockClear()
    await click(container.querySelector('[data-testid="writing-skill-save-button"]'))

    // isLinkedSkill 分支：跳过「规则正文不能为空」校验与 patch.content 赋值
    expect(writeFileAtomicMock).toHaveBeenCalled()
    const saved = JSON.parse(savedConfigContent)
    expect(saved.skills.find((s: { id: string }) => s.id === "skill:one")).toMatchObject({
      name: "外链改名",
      content: "旧内容",
    })
    // 保存成功以落盘为准：成功提示会被草稿同步 effect（name 变化）立即清空
    cleanup(root, container)
  })

  it("导入零技能包走选中回退并由宿主落盘（168 行 ??）", async () => {
    seedSkill()
    const { container, root } = await renderLibrary()
    for (let i = 0; i < 20; i += 1) {
      if (container.querySelector('[data-testid="skill-pack-section"]')) break
      await flushEffects()
    }
    expect(container.querySelector('[data-testid="skill-pack-section"]')).not.toBeNull()
    writeFileAtomicMock.mockClear()

    // 合法空包：parse 通过、skills 为 []，面板仍回调 onImported（ok:true）
    const { buildPack: buildEmptyPack, serializePack: serializeEmptyPack } = await import("@/lib/novel")
    const emptyPackText = serializeEmptyPack(buildEmptyPack([], { name: "niko-skills", version: "1.0.0" }))
    const fileInput = container.querySelector<HTMLInputElement>('[data-testid="skillpack-file"]')!
    expect(fileInput).not.toBeNull()
    const file = new File([emptyPackText], "empty.nbskill", { type: "application/json" })
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true })
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    await flushEffects()

    // 空包无末位技能 id，回退 selectedSkillId 后宿主照常落盘
    expect(writeFileAtomicMock).toHaveBeenCalled()
    expect(container.textContent).toContain("已保存")
    cleanup(root, container)
  })

  it("技能包回执为失败时不落盘、不抛未处理异常（160 行 !result.ok 守卫）", async () => {
    seedSkill()
    // 失败回执是 ImportFailure（无 skills 字段）：绕过守卫会崩在归一化阶段并留下未处理拒绝
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown) => { rejections.push(reason) }
    process.on("unhandledRejection", onUnhandled)
    let view: { container: HTMLElement; root: Root } | null = null
    try {
      view = await renderLibrary()
      for (let i = 0; i < 20; i += 1) {
        if (packPanelProps.length > 0) break
        await flushEffects()
      }
      expect(packPanelProps.length).toBeGreaterThan(0)
      writeFileAtomicMock.mockClear()
      const contentBefore = savedConfigContent

      // 失败回执由生产解析器真实产出：空对象不是合法技能包
      const { buildPack, serializePack, importNbskillPack } = await import("@/lib/novel")
      const failure = importNbskillPack({}, { categoryId: "cat-a" })
      expect(failure.ok).toBe(false)
      const onImported = packPanelProps[packPanelProps.length - 1].onImported as (result: unknown) => void
      await act(async () => {
        onImported(failure)
      })
      await flushEffects()
      // 宏任务边界：潜在的未处理拒绝只有到这里才会被 Node 判为未处理
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      // 守卫命中：整包拒绝不写盘、不伪造成功提示、也不把异常泄给调用方
      expect(rejections).toEqual([])
      expect(writeFileAtomicMock).not.toHaveBeenCalled()
      expect(savedConfigContent).toBe(contentBefore)
      expect(view.container.textContent).not.toContain("已保存")

      // 同一回调通道的成功回执照常落盘：证明上面未写盘源于守卫，而非管线未接通
      const successPack = JSON.parse(serializePack(buildPack([], { name: "niko-skills", version: "1.0.0" })))
      const success = importNbskillPack(successPack, { categoryId: "cat-a" })
      expect(success.ok).toBe(true)
      await act(async () => {
        onImported(success)
      })
      await flushEffects()
      expect(writeFileAtomicMock).toHaveBeenCalledWith(
        "C:/project/.niko-buddy/writing-skills.json",
        expect.stringContaining("三翻四抖"),
      )
    } finally {
      process.off("unhandledRejection", onUnhandled)
      if (view) cleanup(view.root, view.container)
    }
  })

  it("视图加载失败展示错误态（290 行 loadError 分支）", async () => {
    seedSkill()
    // 侧栏 + 视图各一次 loadUserSkillConfig，全部 join 失败才进入视图错误态
    joinMock.mockRejectedValueOnce(new Error("join boom")).mockRejectedValueOnce(new Error("join boom"))
    const { container, root } = await renderLibrary()
    const view = container.querySelector('[data-testid="writing-skill-library-view"]')!
    expect(view.textContent).toContain("写作技能加载失败")
    cleanup(root, container)
  })

  it("无项目时技能包导入入口不渲染（39 行守卫的渲染前提）", async () => {
    seedSkill()
    // 渲染前就无项目：组件首帧读到的 project 即为 null
    useWikiStore.getState().setProject(null as never)
    const { container, root } = await renderLibrary()
    // 导入按钮位于 `{config && project ? (`（561 行）之内，无项目时不渲染
    expect(container.querySelector('[data-testid="skill-bundle-import-open"]')).toBeNull()
    // 因此 handleOpenBundleImport 首行 `if (!project) return`（39 行）无触发入口
    expect(dialogOpenMock).not.toHaveBeenCalled()
    cleanup(root, container)
  })
})
