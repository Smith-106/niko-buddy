// Copyright (c) 2024 Niko-hub contributors. MIT License.

/**
 * provider-registry.ts — T33 provider 注册表
 *
 * 蓝图 §7 T33:
 *   switch→registry 并存后收编。新 provider 通过 registerProvider() add-only 注册；
 *   getProviderConfig() 优先查 registry，未命中则降级至 legacy switch (llm-providers.ts)。
 *   收编阶段（后续）将 switch 分支逐一迁移为 registerProvider 调用，届时 switch 可移除。
 *
 * 机械层约束:
 *   纯数据 + 注册表操作，无 IO / 无网络 / 无模型调用。
 *
 * @license MIT © QMAI
 */

import { getProviderConfig as legacyGetProviderConfig } from "@/lib/llm-providers"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage, RequestOverrides } from "@/lib/llm-providers"

// ── Re-exports ──────────────────────────────────────────────────────────────────
export type { ChatMessage, RequestOverrides }

// ── Types ────────────────────────────────────────────────────────────────────────

/** Provider 名称（与 LlmConfig.provider 一致）。 */
export type ProviderName = LlmConfig["provider"]

/** 自定义 provider 名称（注册表扩展命名空间，不限于 LlmConfig 联合类型）。 */
export type ExtendedProviderName = string

/** Provider 注册项定义。 */
export interface ProviderRegistration {
  /** Provider 唯一名称。 */
  name: string
  /** 人类可读标签。 */
  label: string
  /** 构建请求体。 */
  buildBody: (
    config: LlmConfig,
    messages: ChatMessage[],
    overrides?: RequestOverrides,
  ) => unknown
  /** 解析 SSE 行，返回 token 文本或 null。 */
  parseStream: (line: string) => string | null
  /** 可选：从 SSE 行提取 token 用量。 */
  extractUsage?: (line: string) => { input: number; output: number } | null
  /** 解析请求 URL。 */
  resolveUrl: (config: LlmConfig) => string
  /** 解析请求头。 */
  resolveHeaders: (config: LlmConfig) => Record<string, string>
}

// ── Registry ─────────────────────────────────────────────────────────────────────

/**
 * 线程安全（单线程 JS）add-only provider 注册表。
 * 注册后不可覆盖，防止运行时恶意篡改或意外覆盖。
 */
export class ProviderRegistry {
  private readonly _entries = new Map<string, ProviderRegistration>()

  /**
   * 注册一个 provider。add-only：同名已存在则抛出错误。
   * 收编阶段将现有 switch 分支逐一迁移为 register() 调用。
   */
  register(registration: ProviderRegistration): void {
    if (this._entries.has(registration.name)) {
      throw new Error(
        `Provider '${registration.name}' is already registered. ` +
        "Registration is add-only and cannot be overridden.",
      )
    }
    this._entries.set(registration.name, registration)
  }

  /**
   * 按名称获取注册项。未注册返回 undefined。
   */
  get(name: string): ProviderRegistration | undefined {
    return this._entries.get(name)
  }

  /**
   * 检查 provider 是否已注册。
   */
  has(name: string): boolean {
    return this._entries.has(name)
  }

  /**
   * 获取所有已注册 provider 名称（保序）。
   */
  getRegisteredNames(): string[] {
    return Array.from(this._entries.keys())
  }

  /**
   * 获取所有已注册 provider 定义（保序）。
   */
  getAll(): ProviderRegistration[] {
    return Array.from(this._entries.values())
  }

  /**
   * 清除所有注册项（仅用于测试）。
   */
  clear(): void {
    this._entries.clear()
  }

  /**
   * 获取 ProviderConfig（兼容 llm-providers.ts 的 getProviderConfig 返回值）。
   * 优先查 registry，未命中则降级至 legacy switch。
   */
  getProviderConfig(
    config: LlmConfig,
  ): ReturnType<typeof legacyGetProviderConfig> {
    const reg = this._entries.get(config.provider)
    if (reg) {
      return {
        url: reg.resolveUrl(config),
        headers: reg.resolveHeaders(config),
        buildBody: (messages, overrides) => reg.buildBody(config, messages, overrides),
        parseStream: reg.parseStream,
        extractUsage: reg.extractUsage,
      }
    }
    return legacyGetProviderConfig(config)
  }
}

// ── 全局单例 ────────────────────────────────────────────────────────────────────

/**
 * 全局默认注册表实例。
 * 生产代码使用此实例；测试可创建独立实例避免状态污染。
 */
export const defaultRegistry = new ProviderRegistry()