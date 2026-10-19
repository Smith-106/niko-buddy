// @vitest-environment jsdom
/**
 * anti-ai-rules-view.spec.tsx — 反AI规则视图（规则浏览＋技能开关）。
 *
 * 覆盖：
 * 1. 默认配置（无磁盘文件 → 5 内置技能）：视图框架 + 7 类 + 技能列表 + 预览统计；
 * 2. 开关切换写盘成功：禁用 1 个 → 写盘调用 + 预览计数更新 + 状态翻转；
 * 3. 保存失败显式报错：writeFileAtomic 抛错 → 保存失败文案；
 * 4. 配置损坏 → 加载失败文案 + anti-ai-empty 空态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fsMock.readFile,
    writeFile: fsMock.writeFile,
    writeFileAtomic: fsMock.writeFileAtomic,
    createDirectory: fsMock.createDirectory,
  }
})

const pathMock = vi.hoisted(() => ({
  join: vi.fn(),
}))

vi.mock("@tauri-apps/api/path", () => ({
  join: pathMock.join,
}))

import { AntiAiRulesView } from "./anti-ai-rules-view"

const PROJECT_PATH = "E:/Novel"

beforeEach(() => {
  vi.clearAllMocks()
  pathMock.join.mockImplementation(async (...parts: string[]) => parts.join("/"))
  // 默认：无磁盘配置 → loadDeAiSkillConfig 回退到默认（5 内置技能全启用）
  fsMock.readFile.mockRejectedValue(new Error("no file"))
  fsMock.writeFile.mockResolvedValue(undefined)
  fsMock.writeFileAtomic.mockResolvedValue(undefined)
  fsMock.createDirectory.mockResolvedValue(undefined)
})

afterEach(cleanup)

const EXPECTED_CATEGORIES = ["词汇", "句式", "叙事", "对白", "心理", "场景", "节奏"]

describe("AntiAiRulesView", () => {
  it("渲染视图框架：7 类规则 + 5 内置技能 + 预览统计", async () => {
    render(<AntiAiRulesView projectPath={PROJECT_PATH} />)
    expect(screen.getByTestId("anti-ai-rules-view")).toBeTruthy()

    const categories = screen.getByTestId("anti-ai-categories")
    expect(categories).toBeTruthy()
    for (const category of EXPECTED_CATEGORIES) {
      expect(
        screen.getByTestId(`anti-ai-category-${category}`),
        `缺失分类 ${category}`,
      ).toBeTruthy()
    }

    // 技能列表：5 内置技能只读展示 + 开关
    const skills = screen.getByTestId("anti-ai-skills")
    expect(skills).toBeTruthy()
    expect(await screen.findByText("综合去AI味")).toBeTruthy()
    expect(screen.getByText("减少解释腔")).toBeTruthy()
    expect(screen.getByText("对话口语化")).toBeTruthy()
    expect(screen.getByText("打破工整句式")).toBeTruthy()
    expect(screen.getByText("保留文艺感")).toBeTruthy()
    expect(screen.queryByTestId("anti-ai-empty")).toBeNull()

    // 生效预览：启用 5 / 禁用 0
    const preview = await screen.findByTestId("anti-ai-preview")
    expect(preview.textContent).toContain("启用 5 个技能")
    expect(preview.textContent).toContain("禁用 0 个")
  })

  it("技能开关切换：禁用后写盘保存并更新预览计数", async () => {
    render(<AntiAiRulesView projectPath={PROJECT_PATH} />)
    const toggle = await screen.findByTestId("anti-ai-toggle-built-in:comprehensive")
    expect(screen.getByTestId("anti-ai-skill-status-built-in:comprehensive").textContent).toContain("已启用")

    fireEvent.click(toggle)

    await waitFor(() => expect(fsMock.writeFileAtomic).toHaveBeenCalledTimes(1))
    // 写盘内容包含禁用 id
    const written = String(fsMock.writeFileAtomic.mock.calls[0]?.[1] ?? "")
    expect(written).toContain("built-in:comprehensive")

    // 状态翻转为已禁用，预览计数更新为启用 4 / 禁用 1
    expect(
      screen.getByTestId("anti-ai-skill-status-built-in:comprehensive").textContent,
    ).toContain("已禁用")
    const preview = screen.getByTestId("anti-ai-preview")
    expect(preview.textContent).toContain("启用 4 个技能")
    expect(preview.textContent).toContain("禁用 1 个")
    expect(screen.queryByTestId("anti-ai-save-error")).toBeNull()
  })

  it("保存失败：显式报错且不翻转状态", async () => {
    fsMock.writeFileAtomic.mockRejectedValue(new Error("disk full"))
    render(<AntiAiRulesView projectPath={PROJECT_PATH} />)
    const toggle = await screen.findByTestId("anti-ai-toggle-built-in:reduce-explanation")

    fireEvent.click(toggle)

    const error = await screen.findByTestId("anti-ai-save-error")
    expect(error.textContent).toContain("保存失败")
    // 写盘失败 → 配置不更新，仍为已启用
    expect(
      screen.getByTestId("anti-ai-skill-status-built-in:reduce-explanation").textContent,
    ).toContain("已启用")
    const preview = screen.getByTestId("anti-ai-preview")
    expect(preview.textContent).toContain("启用 5 个技能")
  })

  it("配置损坏：加载失败文案 + 空态 anti-ai-empty", async () => {
    fsMock.readFile.mockResolvedValue("{{{ not json")
    render(<AntiAiRulesView projectPath={PROJECT_PATH} />)

    const loadError = await screen.findByTestId("anti-ai-load-error")
    expect(loadError.textContent).toContain("加载失败")
    // 技能无可用 → 空态（规则分类仍为 7 类只读展示，不受技能配置影响）
    expect(screen.getByTestId("anti-ai-empty").textContent).toContain("暂无可用技能")
    expect(screen.getByTestId("anti-ai-categories")).toBeTruthy()
  })
})
