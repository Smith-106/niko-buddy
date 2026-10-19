// @vitest-environment jsdom
/**
 * model-routes-view.spec.tsx — 模型路由配置只读视图契约。
 *
 * 覆盖：
 *   1. 空 projectPath → 空态（未指定项目路径），不读 store 之外任何磁盘；
 *   2. store 有默认模型 → 基准模型 + 五角色兜底解析渲染；
 *   3. store 三源全空 → 诚实「未配置」文案（loader 返回 null）；
 *   4. 纯装载函数单测：provider 摘要 + 审查模型优先回退链。
 *
 * 磁盘统一经 `@/commands/fs`（本视图实际只读内存 store，此处 mock 仅作统一边界）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: vi.fn(), listDirectory: vi.fn() }
})

import { readFile } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { ModelRoutesView, loadModelRoutesSnapshot } from "./model-routes-view"

const readFileMock = vi.mocked(readFile)

function resetModelStore() {
  useWikiStore.setState({
    defaultLlmModel: "",
    aiChatModel: "",
    providerConfigs: {},
    novelConfig: { ...useWikiStore.getState().novelConfig, reviewModel: "" },
  })
}

afterEach(cleanup)

beforeEach(() => {
  readFileMock.mockReset()
  resetModelStore()
})

describe("ModelRoutesView", () => {
  it("空 projectPath → 空态，不读磁盘", () => {
    render(<ModelRoutesView projectPath="" />)
    expect(screen.getByTestId("model-routes-view")).toBeTruthy()
    expect(screen.getByTestId("model-routes-empty").textContent).toContain("未指定项目路径")
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it("store 有默认模型 → 基准模型 + 五角色兜底渲染", () => {
    useWikiStore.setState({ defaultLlmModel: "openai/gpt-4o", aiChatModel: "openai/gpt-4o-mini" })
    render(<ModelRoutesView projectPath="C:/proj" />)
    expect(screen.getByTestId("model-routes-base-id").textContent).toContain("openai/gpt-4o")
    // 角色绑定表为空，五角色全部走兜底，如实展示。
    for (const role of ["writer", "critic", "reviser", "arbiter", "judge"]) {
      const row = screen.getByTestId(`model-route-${role}`)
      expect(row.textContent).toContain("openai/gpt-4o")
      expect(row.textContent).toContain("走兜底")
    }
    expect(screen.getByTestId("model-routes-no-providers").textContent).toContain("暂无 provider 配置")
  })

  it("store 三源全空 → 诚实「未配置」文案", () => {
    render(<ModelRoutesView projectPath="C:/proj" />)
    expect(screen.getByTestId("model-routes-empty").textContent).toContain("全局未配置可用模型")
    expect(screen.queryByTestId("model-routes-base")).toBeNull()
  })

  it("loadModelRoutesSnapshot：审查模型优先 + provider 摘要", () => {
    const snapshot = loadModelRoutesSnapshot({
      reviewModel: "anthropic/claude-x",
      defaultLlmModel: "openai/gpt-4o",
      aiChatModel: "",
      providerConfigs: {
        openai: {
          label: "OpenAI",
          savedModels: [
            { id: "m1", name: "gpt-4o", model: "gpt-4o", createdAt: 0 },
            { id: "m2", name: "o3", model: "o3", createdAt: 0 },
          ],
        },
      },
    })
    expect(snapshot).not.toBeNull()
    expect(snapshot?.baseModelId).toBe("anthropic/claude-x")
    expect(snapshot?.resolutions).toHaveLength(5)
    expect(snapshot?.resolutions.every((row) => row.resolution.usedDefault)).toBe(true)
    expect(snapshot?.providers).toEqual([{ id: "openai", label: "OpenAI", savedModelCount: 2 }])
    expect(loadModelRoutesSnapshot({ reviewModel: "", defaultLlmModel: "  ", aiChatModel: "", providerConfigs: {} })).toBeNull()
  })
})
