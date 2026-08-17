// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/hooks/use-batch-model-test.ts

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { useBatchModelTest } from "./use-batch-model-test"

const mocks = vi.hoisted(() => ({
  testSettingsLlmModel: vi.fn(),
}))

vi.mock("@/lib/settings-model-test", () => ({
  testSettingsLlmModel: mocks.testSettingsLlmModel,
}))

const t = vi.fn((key: string, params?: Record<string, string | number>) => {
  return params ? `${key}:${JSON.stringify(params)}` : key
})

function makeConfig(_modelId: string) {
  return {
    provider: "custom" as const,
    apiKey: "",
    model: _modelId,
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
    apiMode: "chat_completions" as const,
    reasoning: { mode: "auto" as const },
    localCliIsolation: false,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  t.mockClear()
})

describe("useBatchModelTest", () => {
  it("rejects an empty model list without calling the tester", async () => {
    const { result } = renderHook(() => useBatchModelTest(t))
    await act(async () => {
      await result.current.runBatchTest([], makeConfig)
    })
    expect(result.current.modelTestState).toEqual({
      loading: false,
      success: false,
      message: "请先输入或选择模型",
    })
    expect(mocks.testSettingsLlmModel).not.toHaveBeenCalled()
  })

  it("rejects a list containing a falsy model id", async () => {
    const { result } = renderHook(() => useBatchModelTest(t))
    await act(async () => {
      await result.current.runBatchTest(["", "a"], makeConfig)
    })
    expect(result.current.modelTestState.message).toBe("请先输入或选择模型")
  })

  it("reports per-model progress and an all-success summary", async () => {
    mocks.testSettingsLlmModel.mockImplementation(async (config: { model: string }) => ({
      model: config.model,
      content: "ok",
    }))
    const { result } = renderHook(() => useBatchModelTest(t))
    await act(async () => {
      await result.current.runBatchTest(["a", "b"], makeConfig)
    })
    expect(mocks.testSettingsLlmModel).toHaveBeenCalledTimes(2)
    const state = result.current.modelTestState
    expect(state.loading).toBe(false)
    expect(state.success).toBe(true)
    expect(state.message).toContain("settings.sections.llm.testModelsAllSuccess")
    expect(state.failedModels).toBeUndefined()
  })

  it("reports a partial failure with failed model names and joined messages", async () => {
    mocks.testSettingsLlmModel.mockImplementation(async (config: { model: string }) => {
      if (config.model === "bad") throw new Error("boom")
      return { model: config.model, content: "ok" }
    })
    const { result } = renderHook(() => useBatchModelTest(t))
    await act(async () => {
      await result.current.runBatchTest(["good", "bad"], makeConfig)
    })
    const state = result.current.modelTestState
    expect(state.loading).toBe(false)
    expect(state.success).toBe(false)
    expect(state.failedModels).toEqual(["bad"])
    expect(state.message).toContain("settings.sections.llm.testModelsPartialFailed")
    expect(state.message).toContain("bad: boom")
  })

  it("captures non-Error failures as String(error)", async () => {
    mocks.testSettingsLlmModel.mockRejectedValue("plain-string-error")
    const { result } = renderHook(() => useBatchModelTest(t))
    await act(async () => {
      await result.current.runBatchTest(["x"], makeConfig)
    })
    expect(result.current.modelTestState.failedModels).toEqual(["x"])
    expect(result.current.modelTestState.message).toContain("x: plain-string-error")
  })

  it("outer catch: a throwing t() while publishing per-model progress surfaces the raw error message", async () => {
    const throwingT = vi.fn((key: string) => {
      if (key === "settings.sections.llm.testingModelProgress") throw new Error("translate-failed")
      return key
    })
    mocks.testSettingsLlmModel.mockResolvedValue({ model: "a", content: "ok" })
    const { result } = renderHook(() => useBatchModelTest(throwingT))
    await act(async () => {
      await result.current.runBatchTest(["a"], makeConfig)
    })
    expect(result.current.modelTestState).toEqual({
      loading: false,
      success: false,
      message: "translate-failed",
    })
  })

  it("outer catch: non-Error throws are stringified", async () => {
    const throwingT = vi.fn((key: string) => {
      if (key === "settings.sections.llm.testingModelProgress") throw 42
      return key
    })
    const { result } = renderHook(() => useBatchModelTest(throwingT))
    await act(async () => {
      await result.current.runBatchTest(["a"], makeConfig)
    })
    expect(result.current.modelTestState.message).toBe("42")
  })

  it("retryFailed no-ops when there are no failed models", async () => {
    const { result } = renderHook(() => useBatchModelTest(t))
    await act(async () => {
      await result.current.retryFailed(makeConfig)
    })
    expect(mocks.testSettingsLlmModel).not.toHaveBeenCalled()
  })

  it("retryFailed re-runs the stored failed model list", async () => {
    mocks.testSettingsLlmModel
      .mockRejectedValueOnce(new Error("first-fail"))
      .mockResolvedValueOnce({ model: "m1", content: "ok" })
    const { result } = renderHook(() => useBatchModelTest(t))
    await act(async () => {
      await result.current.runBatchTest(["m1"], makeConfig)
    })
    expect(result.current.modelTestState.failedModels).toEqual(["m1"])

    await act(async () => {
      await result.current.retryFailed(makeConfig)
    })
    expect(mocks.testSettingsLlmModel).toHaveBeenCalledTimes(2)
    expect(result.current.modelTestState.success).toBe(true)
  })

  it("clearTestState resets loading/success/message", async () => {
    const { result } = renderHook(() => useBatchModelTest(t))
    await act(async () => {
      await result.current.runBatchTest(["a"], makeConfig)
    })
    act(() => result.current.clearTestState())
    expect(result.current.modelTestState).toEqual({ loading: false, success: false, message: "" })
  })

  it("removeFailedModel filters a single model out", async () => {
    mocks.testSettingsLlmModel.mockRejectedValue(new Error("x"))
    const { result } = renderHook(() => useBatchModelTest(t))
    await act(async () => {
      await result.current.runBatchTest(["a", "b"], makeConfig)
    })
    expect(result.current.modelTestState.failedModels).toEqual(["a", "b"])

    act(() => result.current.removeFailedModel("a"))
    expect(result.current.modelTestState.failedModels).toEqual(["b"])
  })

  it("removeFailedModel clears the message when the last failure is dismissed on a failed state", async () => {
    mocks.testSettingsLlmModel.mockRejectedValue(new Error("x"))
    const { result } = renderHook(() => useBatchModelTest(t))
    await act(async () => {
      await result.current.runBatchTest(["a"], makeConfig)
    })
    act(() => result.current.removeFailedModel("a"))
    const state = result.current.modelTestState
    expect(state.failedModels).toEqual([])
    expect(state.message).toBe("")
  })

  it("removeFailedModel no-ops when there is no failedModels list", () => {
    const { result } = renderHook(() => useBatchModelTest(t))
    act(() => result.current.removeFailedModel("nope"))
    expect(result.current.modelTestState.failedModels).toBeUndefined()
  })
})
