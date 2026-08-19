import { describe, expect, it } from "vitest"
import {
  DE_AI_BATCH_BACKOFF_BASE_MS,
  DE_AI_BATCH_BACKOFF_CAP_MS,
  DE_AI_BATCH_DEFAULT_CONCURRENCY,
  DE_AI_BATCH_JITTER,
  DE_AI_BATCH_MAX_CONCURRENCY,
  DE_AI_BATCH_MAX_RETRIES,
  DE_AI_BATCH_MIN_CONCURRENCY,
  DE_AI_BATCH_SCHEMA,
} from "./types"

describe("de-ai-batch types — 常量契约", () => {
  it("schema 版本固化", () => {
    expect(DE_AI_BATCH_SCHEMA).toBe("de-ai-batch/1.0")
  })

  it("并发区间 1-5，默认 3（验收标准）", () => {
    expect(DE_AI_BATCH_MIN_CONCURRENCY).toBe(1)
    expect(DE_AI_BATCH_MAX_CONCURRENCY).toBe(5)
    expect(DE_AI_BATCH_DEFAULT_CONCURRENCY).toBe(3)
  })

  it("退避重试参数：重试 2、基数 1s、上限 10s、抖动 20%", () => {
    expect(DE_AI_BATCH_MAX_RETRIES).toBe(2)
    expect(DE_AI_BATCH_BACKOFF_BASE_MS).toBe(1000)
    expect(DE_AI_BATCH_BACKOFF_CAP_MS).toBe(10000)
    expect(DE_AI_BATCH_JITTER).toBe(0.2)
  })
})
