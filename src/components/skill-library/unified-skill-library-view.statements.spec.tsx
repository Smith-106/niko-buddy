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

describe("UnifiedSkillLibraryView 语句/分支收尾（20261105-ralph-coverage-100-2）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    joinMock.mockImplementation(async (...parts: string[]) => parts.join("/"))
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

  it("rejects a de-AI JSON import whose content parses to null（94 行）", async () => {
    openDialogMock.mockResolvedValue("C:/skills/null.json")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/null.json") return "null"
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()
    writeFileAtomicMock.mockClear()

    await clickButton(container, "导入")

    // JSON.parse("null") 得到 null：!parsed 命中，直接返回 null
    expect(container.textContent).toContain("导入失败：文件内容不是有效的去AI味技能")
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    cleanup(root, container)
  })

  it("derives the de-AI skill name from a slash-terminated path（68/118 行）", async () => {
    openDialogMock.mockResolvedValue("C:/skills/dir/")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/dir/") return "纯正文规则"
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()

    await clickButton(container, "导入")

    // fileBaseName 尾斜杠 pop 出空串，回退「未命名技能」；frontmatter 无名，回退路径名
    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/de-ai-skills.json",
      expect.stringContaining("未命名技能"),
    )
    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/de-ai-skills.json",
      expect.stringContaining("纯正文规则"),
    )
    cleanup(root, container)
  })

  it("imports markdown whose frontmatter lacks name and description（82/83 行）", async () => {
    openDialogMock.mockResolvedValue("C:/skills/front2.md")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/front2.md") return "---\nfoo: bar\n---\n正文规则"
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()

    await clickButton(container, "导入")

    // name/desc 缺失：name 回退文件名 front2，description 回退空串
    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/de-ai-skills.json",
      expect.stringContaining("front2"),
    )
    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/de-ai-skills.json",
      expect.stringContaining("正文规则"),
    )
    cleanup(root, container)
  })

  it("imports de-AI JSON without description/templateId（101/102 行 else）", async () => {
    openDialogMock.mockResolvedValue("C:/skills/nodesc.json")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/nodesc.json") return JSON.stringify({ name: "无描述技能", content: "规则正文" })
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()

    await clickButton(container, "导入")

    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/de-ai-skills.json",
      expect.stringContaining("无描述技能"),
    )
    expect(useWikiStore.getState().activeView).toBe("skillLibrary")
    cleanup(root, container)
  })

  it("ignores a cancelled writing import dialog（250 行）", async () => {
    const { container, root } = await renderLibrary()
    writeFileAtomicMock.mockClear()

    await clickButton(container, "写作技能")
    await clickButton(container, "导入")

    // open 返回 null：守卫命中，不写盘、不报错
    expect(openDialogMock).toHaveBeenCalled()
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain("导入失败")
    expect(useWikiStore.getState().activeView).toBe("writingSkillLibrary")
    cleanup(root, container)
  })

  it("shows the empty-description fallback in sidebar entries（504 行）", async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) {
        return JSON.stringify({
          ...writingConfig,
          skills: [{ ...writingConfig.skills[0], description: "" }],
        })
      }
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()
    const searchInput = container.querySelector<HTMLInputElement>('[data-testid="unified-skill-search-input"]')!
    await setInputValue(searchInput, "三翻")

    expect(container.querySelector('[data-testid="unified-skill-entry-writing:skill:three"]')?.textContent)
      .toContain("未填写说明")
    cleanup(root, container)
  })

  it("toggles a favorite star on a writing sidebar entry（517 行 writing 分支）", async () => {
    const { container, root } = await renderLibrary()
    const searchInput = container.querySelector<HTMLInputElement>('[data-testid="unified-skill-search-input"]')!
    await setInputValue(searchInput, "三翻")
    const entry = container.querySelector<HTMLElement>('[data-testid="unified-skill-entry-writing:skill:three"]')
    expect(entry).not.toBeNull()
    const star = entry?.querySelector<HTMLButtonElement>('button[aria-label="收藏"]')
    expect(star).not.toBeUndefined()

    await act(async () => {
      star?.click()
    })
    await flushEffects()

    expect(useFavoriteSkillStore.getState().isFavorited("writing", "skill:three")).toBe(true)
    // 收藏变更不触发侧栏重渲染（订阅的是函数引用），改一次搜索词迫使重渲染再断言 UI
    await setInputValue(searchInput, "三翻x")
    await setInputValue(searchInput, "三翻")
    const refreshed = container.querySelector<HTMLElement>('[data-testid="unified-skill-entry-writing:skill:three"]')
    expect(refreshed?.querySelector('button[aria-label="取消收藏"]')).not.toBeNull()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="unified-skill-entry-writing:skill:three"] button[aria-label="取消收藏"]')?.click()
    })
    await flushEffects()

    expect(useFavoriteSkillStore.getState().isFavorited("writing", "skill:three")).toBe(false)
    cleanup(root, container)
  })

  it("unmount during pending sidebar load skips the resolve path（356 行）", async () => {
    const pending: Array<{ path: string; resolve: (value: string) => void; reject: (reason: unknown) => void }> = []
    readFileMock.mockImplementation(async (path: string) => new Promise<string>((resolve, reject) => {
      pending.push({ path, resolve, reject })
    }))
    const { container, root } = await renderLibrary()
    await flushEffects()
    expect(pending.length).toBeGreaterThan(0)

    cleanup(root, container)
    for (const entry of pending) {
      if (entry.path.endsWith("de-ai-skills.json")) entry.resolve(JSON.stringify(deAiConfig))
      else if (entry.path.endsWith("writing-skills.json")) entry.resolve(JSON.stringify(writingConfig))
      else entry.reject(new Error("missing"))
    }
    await flushEffects()

    // cancelled 分支直接返回：选中态保持初始 null，不再回填默认选中
    expect(document.body.contains(container)).toBe(false)
    expect(useWikiStore.getState().selectedSkillLibrarySkillId).toBeNull()
    expect(useWikiStore.getState().selectedWritingSkillLibrarySkillId).toBeNull()
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
  })

  it("unmount during pending sidebar load skips the reject path（364 行）", async () => {
    const pending: Array<{ reject: (reason: unknown) => void }> = []
    readFileMock.mockImplementation(async () => new Promise<string>((_resolve, reject) => {
      pending.push({ reject })
    }))
    const { container, root } = await renderLibrary()
    await flushEffects()
    expect(pending.length).toBeGreaterThan(0)

    cleanup(root, container)
    for (const entry of pending) entry.reject(new Error("gone"))
    await flushEffects()

    expect(document.body.contains(container)).toBe(false)
    expect(useWikiStore.getState().selectedSkillLibrarySkillId).toBeNull()
    expect(useWikiStore.getState().selectedWritingSkillLibrarySkillId).toBeNull()
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
  })

  it("回退「未命名去AI味技能」当文件名去扩展名后为空（118 行第三段 ||）", async () => {
    // 文件名以扩展名开头：stripSkillFileExtension(".md") 得到空串，且无 frontmatter name
    openDialogMock.mockResolvedValue("C:/skills/.md")
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith("de-ai-skills.json")) return JSON.stringify(deAiConfig)
      if (path.endsWith("writing-skills.json")) return JSON.stringify(writingConfig)
      if (path === "C:/skills/.md") return "纯正文规则"
      throw new Error("missing")
    })
    const { container, root } = await renderLibrary()
    writeFileAtomicMock.mockClear()

    await clickButton(container, "导入")

    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "C:/project/.niko-buddy/de-ai-skills.json",
      expect.stringContaining("未命名去AI味技能"),
    )
    const saved = JSON.parse(writeFileAtomicMock.mock.calls[0][1] as string)
    expect(saved.projectSkills[0]).toMatchObject({
      name: "未命名去AI味技能",
      description: "",
      templateId: "custom",
      content: "纯正文规则",
    })
    cleanup(root, container)
  })

  it("旧加载批次在 dataVersion 变化后失败不影响新批次（364 行 cancelled 守卫）", async () => {
    const pending: Array<{ path: string; resolve: (value: string) => void; reject: (reason: unknown) => void }> = []
    joinMock.mockImplementation((...parts: string[]) => new Promise<string>((resolve, reject) => {
      pending.push({ path: parts.join("/"), resolve, reject })
    }))
    const { container, root } = await renderLibrary()
    await flushEffects()
    const staleCount = pending.length
    expect(staleCount).toBeGreaterThan(0)

    // dataVersion 变化 → 旧 effect cleanup 把 cancelled 置真，并启动新一批加载
    await act(async () => {
      useWikiStore.getState().bumpDataVersion()
    })
    await flushEffects()
    expect(pending.length).toBeGreaterThan(staleCount)

    // 已废弃批次整批失败：cancelled 守卫直接返回，不得写入错误态
    for (const entry of pending.slice(0, staleCount)) entry.reject(new Error("stale boom"))
    await flushEffects()
    expect(container.textContent).not.toContain("技能库加载失败")

    // 新批次照常完成：条目列表可用（也证明旧批次的失败未污染共享加载状态）
    let cursor = staleCount
    for (let round = 0; round < 5 && cursor < pending.length; round += 1) {
      const batch = pending.slice(cursor)
      cursor = pending.length
      for (const entry of batch) entry.resolve(entry.path)
      await flushEffects()
    }

    const searchInput = container.querySelector<HTMLInputElement>('[data-testid="unified-skill-search-input"]')
    expect(searchInput).not.toBeNull()
    await setInputValue(searchInput!, "三翻")
    expect(container.querySelector('[data-testid="unified-skill-entry-writing:skill:three"]')).not.toBeNull()
    expect(container.textContent).not.toContain("技能库加载失败")
    expect(writeFileAtomicMock).not.toHaveBeenCalled()
    cleanup(root, container)
  })
})
