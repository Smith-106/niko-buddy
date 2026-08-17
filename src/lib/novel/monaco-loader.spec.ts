import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const loaderConfigMock = vi.fn()
vi.mock("@monaco-editor/react", () => ({
  loader: { config: (...args: unknown[]) => loaderConfigMock(...args) },
}))

import { configureMonaco } from "./monaco-loader"

// source uses `self` (browser global); alias it to globalThis in node env
;(globalThis as unknown as { self: unknown }).self = globalThis

const globalScope = globalThis as unknown as {
  MonacoEnvironment?: { getWorkerUrl?: () => string }
}

describe("monaco-loader configureMonaco", () => {
  const originalEnv = globalScope.MonacoEnvironment

  beforeEach(() => {
    loaderConfigMock.mockReset()
  })

  afterEach(() => {
    globalScope.MonacoEnvironment = originalEnv
  })

  it("creates MonacoEnvironment when absent and configures loader", () => {
    delete globalScope.MonacoEnvironment
    configureMonaco()
    expect(globalScope.MonacoEnvironment).toBeDefined()
    expect(globalScope.MonacoEnvironment!.getWorkerUrl!()).toContain("workerMain.js")
    expect(loaderConfigMock).toHaveBeenCalledWith({
      paths: { vs: expect.stringContaining("monaco-editor@0.52.0") },
    })
  })

  it("keeps existing MonacoEnvironment and still configures loader", () => {
    globalScope.MonacoEnvironment = { getWorkerUrl: () => "existing-worker" }
    configureMonaco()
    expect(globalScope.MonacoEnvironment!.getWorkerUrl!()).toBe("existing-worker")
    expect(loaderConfigMock).toHaveBeenCalledTimes(1)
  })
})
