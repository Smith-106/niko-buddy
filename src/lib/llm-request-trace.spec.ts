/** C4 冒烟覆盖：src/lib/llm-request-trace.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { MAX_LLM_REQUEST_CACHE_TRACES, buildLlmRequestPrefixDescriptor, buildLlmRequestCacheTrace, LlmRequestTraceCollector, copyLlmRequestCacheTrace, isLlmRequestCacheTrace } from "./llm-request-trace"
describe("llm-request-trace.ts smoke", () => {
  it("exports MAX_LLM_REQUEST_CACHE_TRACES", () => {
    expect(MAX_LLM_REQUEST_CACHE_TRACES).toBeDefined()
  })
  it("exports buildLlmRequestPrefixDescriptor", () => {
    expect(buildLlmRequestPrefixDescriptor).toBeDefined()
  })
  it("exports buildLlmRequestCacheTrace", () => {
    expect(buildLlmRequestCacheTrace).toBeDefined()
  })
  it("exports LlmRequestTraceCollector", () => {
    expect(LlmRequestTraceCollector).toBeDefined()
  })
  it("exports copyLlmRequestCacheTrace", () => {
    expect(copyLlmRequestCacheTrace).toBeDefined()
  })
  it("exports isLlmRequestCacheTrace", () => {
    expect(isLlmRequestCacheTrace).toBeDefined()
  })
})
