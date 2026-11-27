// @vitest-environment jsdom
/**
 * model-routes-view.spec.tsx — 模型分工视图契约（P1-02 响应式订阅 + 4 条核心写作路由 + 快捷设置入口）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: vi.fn(), listDirectory: vi.fn() }
})

import { readFile } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { ModelRoutesView, loadModelRoutesSnapshot } from "./model-routes-view"

const readFileMock = vi.mocked(readFile)

function resetModelStore() {
  const prevNovel = useWikiStore.getState().novelConfig
  const prevLlm = useWikiStore.getState().llmConfig
  useWikiStore.setState({
    defaultLlmModel: "",
    aiChatModel: "",
    providerConfigs: {},
    activeView: "modelRoutes",
    activeSettingsCategory: null,
    llmConfig: { ...prevLlm, model: "" },
    novelConfig: {
      ...prevNovel,
      reviewModel: "",
      summaryModel: "",
      extractModel: "",
      plannerModel: "",
      polishModel: "",
      canonAuditModel: "",
      consensusEnabled: false,
      consensusWritingModels: [],
      consensusReviewModels: {},
    },
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

  it("响应式订阅 store：4 条核心写作路由真实解析，且设置变更立即同步刷新", () => {
    useWikiStore.setState({
      defaultLlmModel: "openai/gpt-4o",
      aiChatModel: "openai/gpt-4o-mini",
      novelConfig: {
        ...useWikiStore.getState().novelConfig,
        reviewModel: "anthropic/claude-sonnet",
        summaryModel: "",
        extractModel: "deepseek/deepseek-chat",
      },
    })
    render(<ModelRoutesView projectPath="C:/proj" />)
    expect(screen.getByTestId("model-routes-base-id").textContent).toContain("openai/gpt-4o-mini")

    expect(screen.getByTestId("model-route-writing").textContent).toContain("跟随主模型")
    expect(screen.getByTestId("model-route-review").textContent).toContain("anthropic/claude-sonnet")
    expect(screen.getByTestId("model-route-review").textContent).toContain("专用覆盖")
    expect(screen.getByTestId("model-route-summary").textContent).toContain("跟随主模型")
    expect(screen.getByTestId("model-route-extract").textContent).toContain("deepseek/deepseek-chat")
    expect(screen.getByTestId("model-route-extract").textContent).toContain("专用覆盖")
    expect(screen.getByTestId("model-routes-no-providers").textContent).toContain("尚未保存任何模型服务配置")

    // 动态修改 store：组件无需重挂载即刻同步
    act(() => {
      useWikiStore.setState({
        novelConfig: {
          ...useWikiStore.getState().novelConfig,
          summaryModel: "openai/gpt-4o",
        },
      })
    })
    expect(screen.getByTestId("model-route-summary").textContent).toContain("专用覆盖")
    expect(screen.getByTestId("model-route-summary").textContent).toContain("openai/gpt-4o")
  })

  it("store 全空 → 诚实「尚未配置可用模型」文案", () => {
    render(<ModelRoutesView projectPath="C:/proj" />)
    expect(screen.getByTestId("model-routes-empty").textContent).toContain("尚未配置可用模型")
    expect(screen.queryByTestId("model-routes-base")).toBeNull()
  })

  it("多模型协同开启时展示写作/审稿席位，并支持跳转模型设置与写作路由设置", () => {
    useWikiStore.setState({
      defaultLlmModel: "openai/gpt-4o",
      novelConfig: {
        ...useWikiStore.getState().novelConfig,
        consensusEnabled: true,
        consensusWritingModels: ["openai/gpt-4o", "anthropic/claude-sonnet"],
        consensusReviewModels: { consistency: ["deepseek/deepseek-r1"] },
      },
      providerConfigs: {
        openai: {
          label: "OpenAI",
          savedModels: [
            { id: "m1", name: "gpt-4o", model: "gpt-4o", createdAt: 0 },
            { id: "m2", name: "o3", model: "o3", createdAt: 0 },
          ],
        },
        deepseek: { savedModels: [] },
      },
    })
    render(<ModelRoutesView projectPath="C:/proj" />)

    const consensus = screen.getByTestId("model-routes-consensus")
    expect(consensus.textContent).toContain("openai/gpt-4o")
    expect(consensus.textContent).toContain("anthropic/claude-sonnet")
    expect(consensus.textContent).toContain("deepseek/deepseek-r1")

    expect(screen.queryByTestId("model-routes-no-providers")).toBeNull()
    expect(screen.getByTestId("model-routes-providers").textContent).toContain("共 2 个")
    expect(screen.getByTestId("model-provider-openai").textContent).toContain("已保存模型 2 个")
    expect(screen.getByTestId("model-provider-deepseek").textContent).toContain("已保存模型 0 个")

    fireEvent.click(screen.getByTestId("model-routes-open-llm-settings"))
    expect(useWikiStore.getState().activeSettingsCategory).toBe("llm")
    expect(useWikiStore.getState().activeView).toBe("settings")

    fireEvent.click(screen.getByTestId("model-routes-open-novel-settings"))
    expect(useWikiStore.getState().activeSettingsCategory).toBe("novel")
    expect(useWikiStore.getState().activeView).toBe("settings")
  })

  it("loadModelRoutesSnapshot：纯装载返回 4 条任务路由与来源摘要", () => {
    const state = useWikiStore.getState()
    const snapshot = loadModelRoutesSnapshot({
      llmConfig: { ...state.llmConfig, model: "" },
      novelConfig: { ...state.novelConfig, reviewModel: "anthropic/claude-x", summaryModel: "", extractModel: "" },
      defaultLlmModel: "openai/gpt-4o",
      aiChatModel: "",
      providerConfigs: {
        openai: {
          label: "OpenAI",
          savedModels: [{ id: "m1", name: "gpt-4o", model: "gpt-4o", createdAt: 0 }],
        },
      },
    })
    expect(snapshot).not.toBeNull()
    expect(snapshot?.routes).toHaveLength(4)
    expect(snapshot?.routes.find((r) => r.task === "writing")?.lockedTemperature).toBe(0.8)
    expect(snapshot?.routes.find((r) => r.task === "review")?.lockedTemperature).toBe(0.15)
    expect(snapshot?.routes.find((r) => r.task === "review")?.isOverride).toBe(true)
    expect(snapshot?.routes.find((r) => r.task === "writing")?.isOverride).toBe(false)
    expect(snapshot?.roleRoutes).toHaveLength(3)
    expect(snapshot?.roleRoutes.find((r) => r.task === "planner")).toMatchObject({
      isOverride: false,
      lockedTemperature: 0.5,
      fallbackTarget: "primary",
    })
    expect(snapshot?.roleRoutes.find((r) => r.task === "polish")).toMatchObject({
      isOverride: false,
      lockedTemperature: 0.6,
      fallbackTarget: "primary",
    })
    expect(snapshot?.roleRoutes.find((r) => r.task === "canon_audit")).toMatchObject({
      isOverride: false,
      lockedTemperature: 0.15,
      fallbackTarget: "review",
      resolvedModel: "anthropic/claude-x",
    })
    expect(snapshot?.sources).toEqual([{ id: "openai", label: "OpenAI", savedModelCount: 1 }])

    expect(
      loadModelRoutesSnapshot({
        llmConfig: { ...state.llmConfig, model: "" },
        novelConfig: {
          ...state.novelConfig,
          reviewModel: "",
          summaryModel: "",
          extractModel: "",
          plannerModel: "",
          polishModel: "",
          canonAuditModel: "",
        },
        defaultLlmModel: "  ",
        aiChatModel: "",
        providerConfigs: {},
      }),
    ).toBeNull()
  })

  it("Phase 3: 展示分角色温度锁定条与三条可选角色路由（canon_audit 跟随审稿模型并支持独立覆盖）", () => {
    useWikiStore.setState({
      defaultLlmModel: "openai/gpt-4o",
      aiChatModel: "openai/gpt-4o-mini",
      novelConfig: {
        ...useWikiStore.getState().novelConfig,
        reviewModel: "anthropic/claude-sonnet",
        plannerModel: "google/gemini-2.5-pro",
        polishModel: "",
        canonAuditModel: "",
      },
    })
    render(<ModelRoutesView projectPath="C:/proj" />)

    const tempLocks = screen.getByTestId("model-routes-temp-locks")
    expect(tempLocks.textContent).toContain("0.5")
    expect(tempLocks.textContent).toContain("0.8")
    expect(tempLocks.textContent).toContain("0.6")
    expect(tempLocks.textContent).toContain("0.15")

    expect(screen.getByTestId("model-route-temp-writing").textContent).toContain("0.8")
    expect(screen.getByTestId("model-route-temp-review").textContent).toContain("0.15")

    const optionalSection = screen.getByTestId("model-routes-optional-roles")
    expect(optionalSection).toBeTruthy()
    expect(screen.getByTestId("model-route-planner").textContent).toContain("google/gemini-2.5-pro")
    expect(screen.getByTestId("model-route-planner").textContent).toContain("专用覆盖")
    expect(screen.getByTestId("model-route-temp-planner").textContent).toContain("0.5")

    expect(screen.getByTestId("model-route-polish").textContent).toContain("跟随主模型")
    expect(screen.getByTestId("model-route-temp-polish").textContent).toContain("0.6")

    expect(screen.getByTestId("model-route-canon_audit").textContent).toContain("anthropic/claude-sonnet")
    expect(screen.getByTestId("model-route-canon_audit").textContent).toContain("跟随审稿模型")
    expect(screen.getByTestId("model-route-temp-canon_audit").textContent).toContain("0.15")

    act(() => {
      useWikiStore.setState({
        novelConfig: {
          ...useWikiStore.getState().novelConfig,
          canonAuditModel: "deepseek/deepseek-reasoner",
        },
      })
    })
    expect(screen.getByTestId("model-route-canon_audit").textContent).toContain("deepseek/deepseek-reasoner")
    expect(screen.getByTestId("model-route-canon_audit").textContent).toContain("专用覆盖")
  })
})
