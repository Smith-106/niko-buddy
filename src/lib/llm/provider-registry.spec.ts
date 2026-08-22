// Copyright (c) 2024 Niko-hub contributors. MIT License.

/**
 * provider-registry.spec.ts — T33 provider-registry / model-resolver / model-port 联合测试
 *
 * 测试范围:
 *   1. ProviderRegistry: 注册/查询/防重复/降级 legacy
 *   2. resolveRoleModel: 纯函数属性测试
 *   3. buildRoleModelMap / buildDefaultRoleModelMap
 *   4. NovelError 三分类 (retryable/content/fatal)
 *   5. Fallback 链解析
 *   6. TaskTier 复杂度路由
 *   7. ModelPort execute/stream（mock streamChat）
 *
 * @license MIT © QMAI
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { ProviderRegistry } from "@/lib/llm/provider-registry"
import {
  resolveRoleModel,
  buildRoleModelMap,
  buildDefaultRoleModelMap,
  resolveTierModel,
  resolveTierRole,
  resolveFallbackChain,
  isRetryableError,
  isContentError,
  classifyError,
  NovelError,
  RetryableError,
  ContentError,
  FatalError,
  type ProjectModelConfig,
  type RoleModelMap,
} from "@/lib/llm/model-resolver"
import { ModelPort } from "@/lib/llm/model-port"
import type { LlmConfig } from "@/stores/wiki-store"

// ============================================================================
// ProviderRegistry
// ============================================================================

describe("ProviderRegistry", () => {
  let registry: ProviderRegistry

  beforeEach(() => {
    registry = new ProviderRegistry()
  })

  it("register 和 get 正常", () => {
    registry.register({
      name: "test-provider",
      label: "Test Provider",
      buildBody: () => ({ test: true }),
      parseStream: () => "token",
      resolveUrl: () => "https://test.api/chat",
      resolveHeaders: () => ({ Authorization: "Bearer test" }),
    })

    const reg = registry.get("test-provider")
    expect(reg).toBeDefined()
    expect(reg!.name).toBe("test-provider")
    expect(reg!.label).toBe("Test Provider")
  })

  it("has 检查存在性", () => {
    expect(registry.has("test-provider")).toBe(false)
    registry.register({
      name: "test-provider",
      label: "Test",
      buildBody: () => ({}),
      parseStream: () => null,
      resolveUrl: () => "",
      resolveHeaders: () => ({}),
    })
    expect(registry.has("test-provider")).toBe(true)
  })

  it("重复注册抛出错误", () => {
    const def = {
      name: "dup-provider",
      label: "Dup",
      buildBody: () => ({}),
      parseStream: () => null,
      resolveUrl: () => "",
      resolveHeaders: () => ({}),
    }
    registry.register(def)
    expect(() => registry.register(def)).toThrow(/already registered/)
  })

  it("getRegisteredNames 返回保序注册名列表", () => {
    registry.register({
      name: "a", label: "A", buildBody: () => ({}), parseStream: () => null,
      resolveUrl: () => "", resolveHeaders: () => ({}),
    })
    registry.register({
      name: "b", label: "B", buildBody: () => ({}), parseStream: () => null,
      resolveUrl: () => "", resolveHeaders: () => ({}),
    })
    expect(registry.getRegisteredNames()).toEqual(["a", "b"])
  })

  it("getAll 返回所有注册项", () => {
    registry.register({
      name: "x", label: "X", buildBody: () => ({}), parseStream: () => null,
      resolveUrl: () => "", resolveHeaders: () => ({}),
    })
    registry.register({
      name: "y", label: "Y", buildBody: () => ({}), parseStream: () => null,
      resolveUrl: () => "", resolveHeaders: () => ({}),
    })
    expect(registry.getAll()).toHaveLength(2)
    expect(registry.getAll().map((r) => r.name)).toEqual(["x", "y"])
  })

  it("clear 清空所有项", () => {
    registry.register({
      name: "z", label: "Z", buildBody: () => ({}), parseStream: () => null,
      resolveUrl: () => "", resolveHeaders: () => ({}),
    })
    expect(registry.has("z")).toBe(true)
    registry.clear()
    expect(registry.has("z")).toBe(false)
  })

  it("未注册 provider 返回 undefined", () => {
    expect(registry.get("nonexistent")).toBeUndefined()
  })

  it("getProviderConfig 优先使用 registry 条目", () => {
    registry.register({
      name: "custom-registry",
      label: "Registry Test",
      buildBody: () => ({ registered: true }),
      parseStream: () => "registry-token",
      resolveUrl: () => "https://registry.test/chat",
      resolveHeaders: () => ({ "X-Registry": "true" }),
    })

    const config = {
      provider: "custom-registry" as LlmConfig["provider"],
      apiKey: "test",
      model: "test-model",
      ollamaUrl: "",
      customEndpoint: "https://registry.test",
      maxContextSize: 4096,
    }

    const result = registry.getProviderConfig(config)
    // url 来自 registry 的 resolveUrl
    expect(result.url).toBe("https://registry.test/chat")
    expect(result.headers["X-Registry"]).toBe("true")
    // 通过 buildBody 透传验证
    const body = result.buildBody(
      [{ role: "user", content: "hi" }],
    )
    expect(body).toEqual({ registered: true })
  })

  it("getProviderConfig 未注册时降级 legacy (使用现有 openai provider)", () => {
    // 不注册 openai，registry 为空 → 降级 legacy getProviderConfig
    const config = {
      provider: "openai" as LlmConfig["provider"],
      apiKey: "sk-test",
      model: "gpt-4",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 4096,
    }

    // 不应抛出，应返回 legacy provider config
    const result = registry.getProviderConfig(config)
    expect(result.url).toBe("https://api.openai.com/v1/chat/completions")
    expect(result.headers["Authorization"]).toBe("Bearer sk-test")
  })
})

// ============================================================================
// resolveRoleModel — 纯函数属性测试
// ============================================================================

describe("resolveRoleModel (纯函数)", () => {
  const empty: ProjectModelConfig = {}

  it("无配置时返回空字符串", () => {
    expect(resolveRoleModel("writer", empty)).toBe("")
    expect(resolveRoleModel("critic", empty)).toBe("")
    expect(resolveRoleModel("reviser", empty)).toBe("")
    expect(resolveRoleModel("arbiter", empty)).toBe("")
    expect(resolveRoleModel("judge", empty)).toBe("")
  })

  it("writer 使用 writingModel", () => {
    const config: ProjectModelConfig = { writingModel: "gpt-4" }
    expect(resolveRoleModel("writer", config)).toBe("gpt-4")
  })

  it("critic 使用 reviewModel", () => {
    const config: ProjectModelConfig = { reviewModel: "claude-3" }
    expect(resolveRoleModel("critic", config)).toBe("claude-3")
  })

  it("reviser 默认复用 writingModel", () => {
    const config: ProjectModelConfig = { writingModel: "gpt-4" }
    expect(resolveRoleModel("reviser", config)).toBe("gpt-4")
  })

  it("arbiter 使用 reviewModel", () => {
    const config: ProjectModelConfig = { reviewModel: "claude-3" }
    expect(resolveRoleModel("arbiter", config)).toBe("claude-3")
  })

  it("judge 使用 reviewModel", () => {
    const config: ProjectModelConfig = { reviewModel: "claude-3" }
    expect(resolveRoleModel("judge", config)).toBe("claude-3")
  })

  it("专用字段为空时降级 writingModel", () => {
    const config: ProjectModelConfig = {
      writingModel: "gpt-4",
      reviewModel: "",
    }
    // critic 的 reviewModel 为空 → 降级 writingModel
    expect(resolveRoleModel("critic", config)).toBe("gpt-4")
  })

  it("纯函数属性：相同输入返回相同输出", () => {
    const config: ProjectModelConfig = {
      writingModel: "gpt-4",
      reviewModel: "claude-3",
    }
    const a = resolveRoleModel("writer", config)
    const b = resolveRoleModel("writer", config)
    expect(a).toBe(b)

    // 不同角色返回不同值
    const writer = resolveRoleModel("writer", config)
    const critic = resolveRoleModel("critic", config)
    expect(writer).toBe("gpt-4")
    expect(critic).toBe("claude-3")
  })

  it("默认全绑单模型——向后兼容", () => {
    // 现状：所有角色使用同一个模型
    const config: ProjectModelConfig = { writingModel: "same-model" }
    expect(resolveRoleModel("writer", config)).toBe("same-model")
    expect(resolveRoleModel("critic", config)).toBe("same-model")
    expect(resolveRoleModel("reviser", config)).toBe("same-model")
    expect(resolveRoleModel("arbiter", config)).toBe("same-model")
    expect(resolveRoleModel("judge", config)).toBe("same-model")
  })
})

// ============================================================================
// buildRoleModelMap / buildDefaultRoleModelMap
// ============================================================================

describe("buildRoleModelMap", () => {
  it("从 config 构建完整映射", () => {
    const config: ProjectModelConfig = {
      writingModel: "gpt-4",
      reviewModel: "claude-3",
    }
    const map = buildRoleModelMap(config)
    expect(map.writer).toBe("gpt-4")
    expect(map.critic).toBe("claude-3")
    expect(map.reviser).toBe("gpt-4")
    expect(map.arbiter).toBe("claude-3")
    expect(map.judge).toBe("claude-3")
  })

  it("空配置返回空字符串映射", () => {
    const map = buildRoleModelMap({})
    expect(map.writer).toBe("")
    expect(map.critic).toBe("")
    expect(map.reviser).toBe("")
    expect(map.arbiter).toBe("")
    expect(map.judge).toBe("")
  })
})

describe("buildDefaultRoleModelMap", () => {
  it("所有角色绑定同一模型", () => {
    const map = buildDefaultRoleModelMap("single-model")
    expect(map.writer).toBe("single-model")
    expect(map.critic).toBe("single-model")
    expect(map.reviser).toBe("single-model")
    expect(map.arbiter).toBe("single-model")
    expect(map.judge).toBe("single-model")
  })

  it("空字符串也一致", () => {
    const map = buildDefaultRoleModelMap("")
    expect(map.writer).toBe("")
    expect(map.critic).toBe("")
    expect(map.reviser).toBe("")
    expect(map.arbiter).toBe("")
    expect(map.judge).toBe("")
  })
})

// ============================================================================
// TaskTier 复杂度路由
// ============================================================================

describe("TaskTier 复杂度路由", () => {
  const modelMap: RoleModelMap = {
    writer: "gpt-4",
    critic: "claude-3",
    reviser: "gpt-4",
    arbiter: "claude-3",
    judge: "claude-3",
  }

  it("simple/standard/complex 使用 writer 模型", () => {
    expect(resolveTierModel("simple", modelMap)).toBe("gpt-4")
    expect(resolveTierModel("standard", modelMap)).toBe("gpt-4")
    expect(resolveTierModel("complex", modelMap)).toBe("gpt-4")
  })

  it("analysis 使用 critic 模型", () => {
    expect(resolveTierModel("analysis", modelMap)).toBe("claude-3")
  })

  it("resolveTierRole 返回正确角色", () => {
    expect(resolveTierRole("simple")).toBe("writer")
    expect(resolveTierRole("standard")).toBe("writer")
    expect(resolveTierRole("complex")).toBe("writer")
    expect(resolveTierRole("analysis")).toBe("critic")
  })
})

// ============================================================================
// NovelError 三分类
// ============================================================================

describe("NovelError 三分类", () => {
  it("RetryableError 的 kind 为 retryable", () => {
    const err = new RetryableError("connection timeout")
    expect(err).toBeInstanceOf(NovelError)
    expect(err).toBeInstanceOf(Error)
    expect(err.kind).toBe("retryable")
    expect(err.name).toBe("RetryableError")
    expect(err.message).toBe("connection timeout")
  })

  it("ContentError 的 kind 为 content", () => {
    const err = new ContentError("JSON parse failed")
    expect(err).toBeInstanceOf(NovelError)
    expect(err.kind).toBe("content")
    expect(err.name).toBe("ContentError")
  })

  it("FatalError 的 kind 为 fatal", () => {
    const err = new FatalError("invalid API key")
    expect(err).toBeInstanceOf(NovelError)
    expect(err.kind).toBe("fatal")
    expect(err.name).toBe("FatalError")
  })

  it("instanceof 链正确", () => {
    const retryable = new RetryableError("test")
    const content = new ContentError("test")
    const fatal = new FatalError("test")

    expect(retryable instanceof NovelError).toBe(true)
    expect(content instanceof NovelError).toBe(true)
    expect(fatal instanceof NovelError).toBe(true)

    expect(retryable instanceof RetryableError).toBe(true)
    expect(content instanceof ContentError).toBe(true)
    expect(fatal instanceof FatalError).toBe(true)
  })

  it("classifyError 分类正确", () => {
    expect(classifyError(new Error("timed out")).kind).toBe("retryable")
    expect(classifyError(new Error("network error")).kind).toBe("retryable")
    expect(classifyError(new Error("rate limit exceeded")).kind).toBe("retryable")
    expect(classifyError(new Error("connection lost")).kind).toBe("retryable")
    expect(classifyError("raw string")).toBeInstanceOf(RetryableError)

    expect(classifyError(new Error("JSON parse error")).kind).toBe("content")
    expect(classifyError(new Error("content policy violation")).kind).toBe("content")

    expect(classifyError(new Error("unauthorized")).kind).toBe("fatal")
    expect(classifyError(new Error("invalid api key")).kind).toBe("fatal")
  })

  it("classifyError 保留已分类 NovelError", () => {
    const original = new ContentError("already classified")
    const classified = classifyError(original)
    expect(classified).toBe(original)
    expect(classified.kind).toBe("content")
  })
})

// ============================================================================
// isRetryableError / isContentError
// ============================================================================

describe("isRetryableError / isContentError", () => {
  it("isRetryableError 识别 NovelError retryable", () => {
    expect(isRetryableError(new RetryableError("timeout"))).toBe(true)
    expect(isRetryableError(new ContentError("parse"))).toBe(false)
    expect(isRetryableError(new FatalError("auth"))).toBe(false)
  })

  it("isRetryableError 识别普通 Error 中的 retryable 关键词", () => {
    expect(isRetryableError(new Error("timed out"))).toBe(true)
    expect(isRetryableError(new Error("network error"))).toBe(true)
    expect(isRetryableError(new Error("rate limit"))).toBe(true)
    expect(isRetryableError(new Error("HTTP 429"))).toBe(true)
    expect(isRetryableError(new Error("generic error"))).toBe(false)
  })

  it("isContentError 识别 NovelError content", () => {
    expect(isContentError(new ContentError("parse"))).toBe(true)
    expect(isContentError(new RetryableError("timeout"))).toBe(false)
  })

  it("isContentError 识别普通 Error 中的 content 关键词", () => {
    expect(isContentError(new Error("JSON parse failed"))).toBe(true)
    expect(isContentError(new Error("解析失败"))).toBe(true)
    expect(isContentError(new Error("moderation flag"))).toBe(true)
    expect(isContentError(new Error("generic error"))).toBe(false)
  })
})

// ============================================================================
// Fallback 链解析
// ============================================================================

describe("Fallback 链解析", () => {
  const chain = {
    primary: "gpt-4",
    fallbacks: ["claude-3", "gemini-pro"],
    exhaustedAction: "checkpoint" as const,
    contentFailAction: "manual_review" as const,
  }

  it("attemptIndex=0 返回 primary 和全部 fallbacks", () => {
    const result = resolveFallbackChain(0, chain)
    expect(result.currentModel).toBe("gpt-4")
    expect(result.remainingFallbacks).toEqual(["claude-3", "gemini-pro"])
    expect(result.exhausted).toBe(false)
  })

  it("attemptIndex=1 返回第一个 fallback", () => {
    const result = resolveFallbackChain(1, chain)
    expect(result.currentModel).toBe("claude-3")
    expect(result.remainingFallbacks).toEqual(["gemini-pro"])
    expect(result.exhausted).toBe(false)
  })

  it("attemptIndex=2 返回第二个 fallback", () => {
    const result = resolveFallbackChain(2, chain)
    expect(result.currentModel).toBe("gemini-pro")
    expect(result.remainingFallbacks).toEqual([])
    expect(result.exhausted).toBe(false)
  })

  it("attemptIndex=3 链耗尽", () => {
    const result = resolveFallbackChain(3, chain)
    expect(result.currentModel).toBe("")
    expect(result.remainingFallbacks).toEqual([])
    expect(result.exhausted).toBe(true)
  })

  it("空 fallbacks 时 attemptIndex=0 正常，>=1 耗尽", () => {
    const noFallback = { ...chain, fallbacks: [] }
    const r0 = resolveFallbackChain(0, noFallback)
    expect(r0.currentModel).toBe("gpt-4")
    expect(r0.exhausted).toBe(false)

    const r1 = resolveFallbackChain(1, noFallback)
    expect(r1.currentModel).toBe("")
    expect(r1.exhausted).toBe(true)
  })
})

// ============================================================================
// ModelPort
// ============================================================================

describe("ModelPort", () => {
  let port: ModelPort

  beforeEach(() => {
    port = new ModelPort()
  })

  describe("execute", () => {
    it("收集 token 后 resolve 完整文本", async () => {
      // 模拟 streamChat 逐个发送 token 后调用 onDone
      const mockStreamChat = vi.spyOn(
        await import("@/lib/llm-client"),
        "streamChat",
      ).mockImplementation((_config, _messages, callbacks) => {
        callbacks.onToken("Hello")
        callbacks.onToken(" ")
        callbacks.onToken("World")
        callbacks.onDone()
        return Promise.resolve()
      })

      const result = await port.execute({
        config: { provider: "openai", apiKey: "test", model: "gpt-4", ollamaUrl: "", customEndpoint: "", maxContextSize: 4096 } as LlmConfig,
        messages: [{ role: "user", content: "hi" }],
      })

      expect(result).toBe("Hello World")
      expect(mockStreamChat).toHaveBeenCalledTimes(1)
      mockStreamChat.mockRestore()
    })

    it("出错时 reject", async () => {
      vi.spyOn(
        await import("@/lib/llm-client"),
        "streamChat",
      ).mockImplementation((_config, _messages, callbacks) => {
        callbacks.onError(new Error("API error"))
        return Promise.resolve()
      })

      await expect(
        port.execute({
          config: { provider: "openai", apiKey: "test", model: "gpt-4", ollamaUrl: "", customEndpoint: "", maxContextSize: 4096 } as LlmConfig,
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toThrow("API error")
    })
  })

  describe("stream", () => {
    it("透传回调", async () => {
      const onToken = vi.fn()
      const onReasoningToken = vi.fn()
      const onDone = vi.fn()
      const onError = vi.fn()

      vi.spyOn(
        await import("@/lib/llm-client"),
        "streamChat",
      ).mockImplementation((_config, _messages, callbacks) => {
        callbacks.onToken("Hello")
        callbacks.onReasoningToken?.("thinking...")
        callbacks.onDone()
        return Promise.resolve()
      })

      await port.stream({
        config: { provider: "openai", apiKey: "test", model: "gpt-4", ollamaUrl: "", customEndpoint: "", maxContextSize: 4096 } as LlmConfig,
        messages: [{ role: "user", content: "hi" }],
        onToken,
        onReasoningToken,
        onDone,
        onError,
      })

      expect(onToken).toHaveBeenCalledWith("Hello")
      expect(onReasoningToken).toHaveBeenCalledWith("thinking...")
      expect(onDone).toHaveBeenCalledTimes(1)
      expect(onError).not.toHaveBeenCalled()
    })

    it("错误回调", async () => {
      const onDone = vi.fn()
      const onError = vi.fn()

      vi.spyOn(
        await import("@/lib/llm-client"),
        "streamChat",
      ).mockImplementation((_config, _messages, callbacks) => {
        callbacks.onError(new Error("Stream error"))
        return Promise.resolve()
      })

      await port.stream({
        config: { provider: "openai", apiKey: "test", model: "gpt-4", ollamaUrl: "", customEndpoint: "", maxContextSize: 4096 } as LlmConfig,
        messages: [{ role: "user", content: "hi" }],
        onToken: () => {},
        onDone,
        onError,
      })

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Stream error" }))
      expect(onDone).not.toHaveBeenCalled()
    })
  })
})

// ============================================================================
// 默认导出实例
// ============================================================================

describe("默认导出实例", () => {
  it("defaultModelPort 是 ModelPort 实例", async () => {
    const { defaultModelPort } = await import("@/lib/llm/model-port")
    expect(defaultModelPort).toBeInstanceOf(ModelPort)
  })

  it("defaultRegistry 是 ProviderRegistry 实例", async () => {
    const { defaultRegistry } = await import("@/lib/llm/provider-registry")
    expect(defaultRegistry).toBeInstanceOf(ProviderRegistry)
  })
})