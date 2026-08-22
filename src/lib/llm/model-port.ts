// Copyright (c) 2024 Niko-hub contributors. MIT License.

/**
 * model-port.ts — T33 ModelPort 端口
 *
 * 蓝图 §7 T33:
 *   ModelPort execute/stream 两方法，基于现有 llm-client.ts 的 streamChat 封装。
 *   execute: 完整响应收集 → Promise<string>
 *   stream:  流式回调 → Promise<void>
 *
 * 不动 deep-chapter-generation.ts 的调用点（接线归后续）；只建层不改主链行为。
 *
 * @license MIT © QMAI
 */

import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage, RequestOverrides } from "@/lib/llm-providers"

// ── Re-exports ──────────────────────────────────────────────────────────────────
export type { ChatMessage, RequestOverrides, StreamCallbacks }

// ── Types ────────────────────────────────────────────────────────────────────────

/** ModelPort.execute 选项。 */
export interface ModelPortExecuteOptions {
  /** LLM 配置。 */
  config: LlmConfig
  /** 消息列表。 */
  messages: ChatMessage[]
  /** 可选：中止信号。 */
  signal?: AbortSignal
  /** 可选：请求覆盖参数。 */
  requestOverrides?: RequestOverrides
}

/** ModelPort.stream 选项（含回调）。 */
export interface ModelPortStreamOptions extends ModelPortExecuteOptions {
  /** Token 回调。 */
  onToken: (token: string) => void
  /** 可选：思考 token 回调。 */
  onReasoningToken?: (token: string) => void
  /** 完成回调。 */
  onDone: () => void
  /** 错误回调。 */
  onError: (error: Error) => void
}

// ── ModelPort ────────────────────────────────────────────────────────────────────

/**
 * ModelPort — LLM 调用端口。
 *
 * 职责:
 *   封装 llm-client.ts 的 streamChat，提供 execute/stream 两方法。
 *   execute: 收集完整响应后以 Promise<string> 返回。
 *   stream: 通过回调传递流式 token。
 *
 * 设计原则:
 *   - 薄封装：不改变 streamChat 的传输行为
 *   - 向后兼容：现有代码可直接使用 streamChat，不强制迁移
 *   - 接线归后续：deep-chapter-generation.ts 等调用点不改
 */
export class ModelPort {
  /**
   * 执行 LLM 调用并返回完整响应文本。
   * 内部收集所有 token 后以 Promise<string> 返回。
   * 出错时 Promise reject。
   */
  async execute(options: ModelPortExecuteOptions): Promise<string> {
    const { config, messages, signal, requestOverrides } = options
    let result = ""

    await new Promise<void>((resolve, reject) => {
      streamChat(
        config,
        messages,
        {
          onToken: (token: string) => {
            result += token
          },
          onDone: () => {
            resolve()
          },
          onError: (error: Error) => {
            reject(error)
          },
        },
        signal,
        requestOverrides,
      )
    })

    return result
  }

  /**
   * 执行 LLM 流式调用，通过回调传递 token。
   * Promise resolve 时机由 onDone 回调控制，出错时 onError 回调。
   */
  async stream(options: ModelPortStreamOptions): Promise<void> {
    const {
      config,
      messages,
      signal,
      requestOverrides,
      onToken,
      onReasoningToken,
      onDone,
      onError,
    } = options

    return streamChat(
      config,
      messages,
      { onToken, onReasoningToken, onDone, onError },
      signal,
      requestOverrides,
    )
  }
}

/** 全局默认 ModelPort 实例。 */
export const defaultModelPort = new ModelPort()