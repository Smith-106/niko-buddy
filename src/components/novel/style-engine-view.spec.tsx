// @vitest-environment jsdom
/**
 * StyleEngineView 测试
 *
 * 组件经 barrel（@/lib/novel）调用真实 writing-style-store 逻辑，
 * 在 @/commands/fs 边界 mock（实际函数名：readFile / writeFileAtomic /
 * createDirectory；writeFile 存在但 store 写盘走 writeFileAtomic）。
 * 覆盖：预设列表渲染、启用/关闭开关写盘、选中预设 sidecar 预览、
 * 无预设诚实空态、写盘失败显式报错。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, fireEvent, waitFor, within, setupDomGlobals } from "@/test-helpers/component-test-utils"
import { StyleEngineView } from "./style-engine-view"
import type { BookStyleProfile, WritingStylePreset } from "@/lib/novel"

// 覆盖补齐：load 失败分支经 barrel 注入（默认透传真实实现，既有用例行为不变）。
vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    loadWritingStyleStore: vi.fn((...args: [string]) => actual.loadWritingStyleStore(...args)),
  }
})

import { loadWritingStyleStore } from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fsMocks.readFile,
    writeFileAtomic: fsMocks.writeFileAtomic,
    createDirectory: fsMocks.createDirectory,
  }
})

function makeProfile(overrides?: Partial<BookStyleProfile>): BookStyleProfile {
  return {
    schemaVersion: 1,
    generatedAt: 1700000000000,
    sampledChapterIds: ["ch1"],
    narrativeDensity: "高密度叙事",
    descriptionWeight: "描写克制",
    emotionRendering: "白描",
    sentenceStyle: "短句为主",
    rhetoricDensity: "低比喻",
    transitionStyle: "跳切",
    narrativeVoice: "第三人称全知视角",
    dialogueStyle: "短促对白",
    thematicHabits: "留白",
    constitution: "宪法：只学文风，不借人物。",
    samples: ["样本一段", "样本二段", "样本三段"],
    ...overrides,
  }
}

function makePreset(
  id: string,
  name: string,
  sourceBook: string,
  profileOverrides?: Partial<BookStyleProfile>,
): WritingStylePreset {
  return {
    id,
    name,
    sourceBook,
    profile: makeProfile(profileOverrides),
    createdAt: 1700000000000,
    updatedAt: 1700000000001,
  }
}

function storeJson(styles: WritingStylePreset[], enabledStyleId: string | null): string {
  return JSON.stringify({ version: 1, enabledStyleId, styles })
}

function lastWritePayload(): { enabledStyleId: string | null; styles: WritingStylePreset[] } {
  const calls = fsMocks.writeFileAtomic.mock.calls
  return JSON.parse(calls[calls.length - 1][1])
}

const PROJECT_PATH = "E:/Novel"

beforeEach(() => {
  setupDomGlobals({ scrollTo: true })
  vi.clearAllMocks()
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  fsMocks.readFile.mockResolvedValue(storeJson([], null))
})

afterEach(() => {
  cleanup()
})

describe("StyleEngineView", () => {
  it("渲染预设列表（name/sourceBook）与当前启用态", async () => {
    const presets = [
      makePreset("s1", "沧海文风", "沧海卷"),
      makePreset("s2", "市井文风", "市井篇", { constitution: "宪法：市井气。" }),
    ]
    fsMocks.readFile.mockResolvedValue(storeJson(presets, "s1"))
    render(<StyleEngineView projectPath={PROJECT_PATH} />)

    expect(await screen.findByTestId("style-engine-view")).toBeInTheDocument()
    const list = await screen.findByTestId("style-list")
    expect(list).toBeInTheDocument()
    const items = within(list)
    expect(items.getByText("沧海文风")).toBeInTheDocument()
    expect(items.getByText("《沧海卷》")).toBeInTheDocument()
    expect(items.getByText("市井文风")).toBeInTheDocument()
    expect(items.getByText("《市井篇》")).toBeInTheDocument()
    // s1 已启用徽标 + 开关打开
    expect(items.getByText("已启用")).toBeInTheDocument()
    expect(items.getByRole("switch", { name: "启用风格预设「沧海文风」" })).toBeChecked()
    expect(items.getByRole("switch", { name: "启用风格预设「市井文风」" })).not.toBeChecked()
    // store 路径：<projectPath>/.niko-buddy/writing-style.json
    expect(fsMocks.readFile).toHaveBeenCalledWith(expect.stringContaining("writing-style.json"))
    // 头部汇总当前启用
    expect(screen.getByText(/当前启用：沧海文风/)).toBeInTheDocument()
  })

  it("启用开关切换并写盘（setEnabledWritingStyle 内部 save 落盘）", async () => {
    const presets = [makePreset("s1", "沧海文风", "沧海卷"), makePreset("s2", "市井文风", "市井篇")]
    fsMocks.readFile.mockResolvedValue(storeJson(presets, null))
    render(<StyleEngineView projectPath={PROJECT_PATH} />)
    const list = await screen.findByTestId("style-list")

    fireEvent.click(within(list).getByRole("switch", { name: "启用风格预设「市井文风」" }))
    await waitFor(() => {
      expect(fsMocks.writeFileAtomic).toHaveBeenCalled()
    })
    const payload = lastWritePayload()
    expect(payload.enabledStyleId).toBe("s2")
    expect(payload.styles).toHaveLength(2)
    // 写盘路径同样指向 writing-style.json
    const writeCalls = fsMocks.writeFileAtomic.mock.calls
    expect(writeCalls[writeCalls.length - 1][0]).toContain("writing-style.json")
    // 成功提示 + 启用徽标
    expect(await screen.findByRole("status")).toHaveTextContent("已启用风格预设「市井文风」")
    expect(within(list).getByRole("switch", { name: "启用风格预设「市井文风」" })).toBeChecked()
  })

  it("关闭已启用预设（开关 off → enabledStyleId=null 写盘）", async () => {
    const presets = [makePreset("s1", "沧海文风", "沧海卷")]
    fsMocks.readFile.mockResolvedValue(storeJson(presets, "s1"))
    render(<StyleEngineView projectPath={PROJECT_PATH} />)
    const list = await screen.findByTestId("style-list")
    const toggle = await within(list).findByRole("switch", { name: "启用风格预设「沧海文风」" })
    expect(toggle).toBeChecked()

    fsMocks.writeFileAtomic.mockClear()
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(fsMocks.writeFileAtomic).toHaveBeenCalled()
    })
    expect(lastWritePayload().enabledStyleId).toBeNull()
    expect(await screen.findByRole("status")).toHaveTextContent("已关闭风格预设「沧海文风」的启用")
    expect(within(list).getByRole("switch", { name: "启用风格预设「沧海文风」" })).not.toBeChecked()
  })

  it("选中预设切换 sidecar 预览文本", async () => {
    const presets = [
      makePreset("s1", "沧海文风", "沧海卷"),
      makePreset("s2", "市井文风", "市井篇", {
        constitution: "宪法：市井气。",
        narrativeVoice: "第一人称市井视角",
        samples: ["市井样本一", "市井样本二"],
      }),
    ]
    fsMocks.readFile.mockResolvedValue(storeJson(presets, "s1"))
    render(<StyleEngineView projectPath={PROJECT_PATH} />)

    const preview = await screen.findByTestId("style-preview")
    // 默认选中启用项 s1
    expect(preview).toHaveTextContent("宪法：只学文风，不借人物。")
    expect(preview).toHaveTextContent("源作品：沧海卷")
    expect(preview).toHaveTextContent("第三人称全知视角")
    // 只取前 2 段样本
    expect(preview).toHaveTextContent("样本一段")
    expect(preview).toHaveTextContent("样本二段")
    expect(preview).not.toHaveTextContent("样本三段")

    // 点击选中 s2 → 预览切换
    const list = await screen.findByTestId("style-list")
    fireEvent.click(within(list).getByRole("button", { name: /市井文风/ }))
    await waitFor(() => {
      expect(screen.getByTestId("style-preview")).toHaveTextContent("宪法：市井气。")
    })
    expect(screen.getByTestId("style-preview")).toHaveTextContent("源作品：市井篇")
    expect(screen.getByTestId("style-preview")).toHaveTextContent("第一人称市井视角")
    expect(screen.getByTestId("style-preview")).toHaveTextContent("市井样本一")
  })

  it("无预设时显示诚实空态（文件缺失 → load 兜底空 store）", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("no such file"))
    render(<StyleEngineView projectPath={PROJECT_PATH} />)

    expect(await screen.findByTestId("style-empty")).toBeInTheDocument()
    expect(screen.getByTestId("style-empty")).toHaveTextContent("暂无风格预设")
    expect(screen.queryByTestId("style-list")).not.toBeInTheDocument()
    expect(screen.queryByTestId("style-preview")).not.toBeInTheDocument()
  })

  it("空 styles 数组同样显示空态", async () => {
    fsMocks.readFile.mockResolvedValue(storeJson([], null))
    render(<StyleEngineView projectPath={PROJECT_PATH} />)
    expect(await screen.findByTestId("style-empty")).toBeInTheDocument()
  })

  it("写盘失败显式报错不静默（启用态保持原值）", async () => {
    const presets = [makePreset("s1", "沧海文风", "沧海卷"), makePreset("s2", "市井文风", "市井篇")]
    fsMocks.readFile.mockResolvedValue(storeJson(presets, null))
    render(<StyleEngineView projectPath={PROJECT_PATH} />)
    const list = await screen.findByTestId("style-list")

    fsMocks.writeFileAtomic.mockRejectedValueOnce(new Error("磁盘只读"))
    fireEvent.click(within(list).getByRole("switch", { name: "启用风格预设「沧海文风」" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("磁盘只读")
    // 未静默：开关保持关闭，无成功提示
    expect(within(list).getByRole("switch", { name: "启用风格预设「沧海文风」" })).not.toBeChecked()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("挂载零写盘（M3：只读装载，不调用写盘）", async () => {
    fsMocks.readFile.mockResolvedValue(storeJson([makePreset("s1", "沧海文风", "沧海卷")], null))
    render(<StyleEngineView projectPath={PROJECT_PATH} />)
    await screen.findByTestId("style-list")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("projectPath 变化时重新加载", async () => {
    fsMocks.readFile.mockResolvedValue(storeJson([makePreset("s1", "沧海文风", "沧海卷")], null))
    const { rerender } = render(<StyleEngineView projectPath={PROJECT_PATH} />)
    await screen.findByTestId("style-list")
    expect(fsMocks.readFile).toHaveBeenCalledWith(expect.stringContaining("E:/Novel"))

    fsMocks.readFile.mockResolvedValue(storeJson([makePreset("s9", "边塞文风", "边塞篇")], null))
    rerender(<StyleEngineView projectPath="F:/Other" />)
    await waitFor(() => {
      expect(fsMocks.readFile).toHaveBeenCalledWith(expect.stringContaining("F:/Other"))
    })
    expect(await screen.findByTestId("style-list")).toHaveTextContent("边塞文风")
  })
})

describe("StyleEngineView 覆盖补齐：空项目/装载失败/空态导航", () => {
  it("projectPath 为空 → 清空预设并结束加载（不读盘）", async () => {
    render(<StyleEngineView projectPath="" />)
    expect(await screen.findByTestId("style-empty")).toBeInTheDocument()
    expect(fsMocks.readFile).not.toHaveBeenCalled()
  })

  it("装载依赖抛错 → 显式报错（启用态保持原值，不静默空态）", async () => {
    vi.mocked(loadWritingStyleStore).mockRejectedValueOnce(new Error("store gone"))
    render(<StyleEngineView projectPath={PROJECT_PATH} />)
    const alert = await screen.findByTestId("style-error")
    expect(alert.textContent).toContain("store gone")
    expect(screen.queryByTestId("style-list")).not.toBeInTheDocument()
  })

  it("空态按钮 → 跳转拆文库（setActiveView bookAnalysis）", async () => {
    render(<StyleEngineView projectPath={PROJECT_PATH} />)
    expect(await screen.findByTestId("style-empty")).toBeInTheDocument()
    fireEvent.click(screen.getByText("去拆文库提取文风"))
    expect(useWikiStore.getState().activeView).toBe("bookAnalysis")
  })
})

describe("StyleEngineView 分支覆盖补齐：预览空段/幽灵启用/装载竞态/保存守卫", () => {
  it("极简预设预览：空源书/空宪法/空维度/缺 samples → 各段全部隐藏", async () => {
    const minimal = makePreset("sx", "极简文风", "", {
      constitution: "",
      narrativeVoice: "",
      dialogueStyle: "",
      sentenceStyle: "",
    })
    delete (minimal.profile as Partial<BookStyleProfile>).samples
    fsMocks.readFile.mockResolvedValue(storeJson([minimal], null))
    render(<StyleEngineView projectPath={PROJECT_PATH} />)

    const preview = await screen.findByTestId("style-preview")
    expect(preview).toHaveTextContent("预设：极简文风")
    expect(preview).not.toHaveTextContent("源作品")
    expect(preview).not.toHaveTextContent("风格宪法")
    expect(preview).not.toHaveTextContent("关键维度")
    expect(preview).not.toHaveTextContent("模仿锚点")
  })

  it("启用 ID 幽灵（不在 styles 中）→ findSelected 回退首项 + 显示未启用", async () => {
    fsMocks.readFile.mockResolvedValue(storeJson([makePreset("s1", "沧海文风", "沧海卷")], "ghost"))
    render(<StyleEngineView projectPath={PROJECT_PATH} />)

    const preview = await screen.findByTestId("style-preview")
    expect(preview).toHaveTextContent("预设：沧海文风")
    expect(screen.getByText(/当前未启用任何风格预设/)).toBeInTheDocument()
  })

  it("切换项目后复选保持（store 仍含该项 → 复用 current）", async () => {
    const presets = [makePreset("s1", "沧海文风", "沧海卷"), makePreset("s2", "市井文风", "市井篇")]
    fsMocks.readFile.mockResolvedValue(storeJson(presets, null))
    const { rerender } = render(<StyleEngineView projectPath={PROJECT_PATH} />)
    const list = await screen.findByTestId("style-list")
    fireEvent.click(within(list).getByRole("button", { name: /市井文风/ }))
    await waitFor(() => {
      expect(screen.getByTestId("style-preview")).toHaveTextContent("预设：市井文风")
    })

    fsMocks.readFile.mockResolvedValue(storeJson(presets, null))
    rerender(<StyleEngineView projectPath="F:/Other" />)
    await waitFor(() => {
      expect(screen.getByTestId("style-preview")).toHaveTextContent("预设：市井文风")
    })
  })

  it("装载飞行中卸载 → cancelled 直接返回且不关 loading（不报错）", async () => {
    let resolveRead!: (value: string) => void
    fsMocks.readFile.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveRead = resolve
      }),
    )
    const { unmount } = render(<StyleEngineView projectPath={PROJECT_PATH} />)
    expect(fsMocks.readFile).toHaveBeenCalledTimes(1)
    unmount()
    resolveRead(storeJson([makePreset("s1", "沧海文风", "沧海卷")], null))
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByTestId("style-engine-view")).toBeNull()
    expect(screen.queryByTestId("style-list")).toBeNull()
  })

  it("装载抛非 Error → 默认加载失败文案", async () => {
    vi.mocked(loadWritingStyleStore).mockRejectedValueOnce("string-fail")
    render(<StyleEngineView projectPath={PROJECT_PATH} />)
    const alert = await screen.findByTestId("style-error")
    expect(alert.textContent).toContain("风格预设加载失败")
  })

  it("装载失败后才卸载 → 跳过 setError（无报错残留）", async () => {
    // loadWritingStyleStore 真实实现吞掉读盘错（返回空 store），
    // 112 的 catch 只能经模块 mock 抛错到达：延迟 reject + 先卸载。
    let rejectLoad!: (reason: unknown) => void
    vi.mocked(loadWritingStyleStore).mockReturnValueOnce(
      new Promise<never>((_, reject) => {
        rejectLoad = reject
      }),
    )
    const { unmount } = render(<StyleEngineView projectPath={PROJECT_PATH} />)
    unmount()
    rejectLoad(new Error("late failure"))
    await Promise.resolve()
    await Promise.resolve()
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })

  it("保存中重复切换 → 直接返回（写盘只调一次）", async () => {
    fsMocks.readFile.mockResolvedValue(storeJson([makePreset("s1", "沧海文风", "沧海卷")], null))
    let resolveWrite!: (value: void) => void
    fsMocks.writeFileAtomic.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveWrite = resolve
      }),
    )
    render(<StyleEngineView projectPath={PROJECT_PATH} />)
    const list = await screen.findByTestId("style-list")
    const toggle = within(list).getByRole("switch", { name: "启用风格预设「沧海文风」" })
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    resolveWrite(undefined)
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("已启用风格预设「沧海文风」")
    })
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
  })

  it("保存抛非 Error → 默认保存失败文案", async () => {
    fsMocks.readFile.mockResolvedValue(storeJson([makePreset("s1", "沧海文风", "沧海卷")], null))
    render(<StyleEngineView projectPath={PROJECT_PATH} />)
    const list = await screen.findByTestId("style-list")
    fsMocks.writeFileAtomic.mockRejectedValueOnce("disk-gone-string")
    fireEvent.click(within(list).getByRole("switch", { name: "启用风格预设「沧海文风」" }))
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("风格预设保存失败")
  })
})
