// Copyright (c) 2024 Niko-hub contributors. MIT License.

import { describe, expect, it } from "vitest"
import { shouldRetryWithoutReasoning } from "./llm-client"
import { isReasoningOnlyResponseError, withReasoningDisabled } from "./reasoning-retry"

const REASONING_ONLY_ERROR = new Error(
  "模型只输出了 136,434 字符的思考内容，但没有输出正文。这通常表示接口触发了思考 token 上限、模型没有从思考阶段切换到正式回答，或当前兼容接口的流式输出不完整。请缩短输入、提高 max_tokens，或在设置里切换其他模型后重试。",
)

describe("53 号报告延伸: reasoning-only 自动降级重试决策", () => {
  it("isReasoningOnlyResponseError: 匹配思考无正文错误文案", () => {
    expect(isReasoningOnlyResponseError(REASONING_ONLY_ERROR)).toBe(true)
    expect(isReasoningOnlyResponseError(new Error("connection lost"))).toBe(false)
  })

  it("shouldRetryWithoutReasoning: 思考开启 + reasoning-only 错误 → 重试", () => {
    expect(
      shouldRetryWithoutReasoning(REASONING_ONLY_ERROR, { reasoning: { mode: "auto" } }),
    ).toBe(true)
  })

  it("shouldRetryWithoutReasoning: 思考已禁用 → 不重试（避免死循环）", () => {
    expect(
      shouldRetryWithoutReasoning(REASONING_ONLY_ERROR, { reasoning: { mode: "off" } }),
    ).toBe(false)
  })

  it("shouldRetryWithoutReasoning: overrides 显式禁用思考 → 不重试", () => {
    expect(
      shouldRetryWithoutReasoning(
        REASONING_ONLY_ERROR,
        { reasoning: { mode: "auto" } },
        withReasoningDisabled(),
      ),
    ).toBe(false)
  })

  it("shouldRetryWithoutReasoning: 非 reasoning-only 错误 → 不重试", () => {
    expect(
      shouldRetryWithoutReasoning(new Error("db down"), { reasoning: { mode: "auto" } }),
    ).toBe(false)
  })

  it("withReasoningDisabled: 保留其余 overrides 仅关思考", () => {
    const overrides = withReasoningDisabled({ max_tokens: 8192 })
    expect(overrides).toEqual({ max_tokens: 8192, reasoning: { mode: "off" } })
  })
})
