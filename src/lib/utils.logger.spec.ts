import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { logger, setLogTraceId, getLogTraceId } from "./utils"

/**
 * ISS-20260709-019: structured logger tests.
 *
 * Verifies the human-readable console shape (default) + JSON line shape
 * (NOVEL_LOG_JSON=1) + trace-id stamping. PAT-DC1: the logger never
 * introspects Error objects — callers pass already-sanitized strings.
 */
describe("ISS-20260709-019 structured logger", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let infoSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    setLogTraceId("")
    delete process.env.NOVEL_LOG_JSON
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("error/warn/info route to the matching console method (human-readable)", () => {
    logger.error("Scope", "boom")
    logger.warn("Scope", "careful")
    logger.info("Scope", "ok")
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(infoSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toBe("[Scope] boom")
    expect(warnSpy.mock.calls[0][0]).toBe("[Scope] careful")
    expect(infoSpy.mock.calls[0][0]).toBe("[Scope] ok")
  })

  it("stamps the trace-id when set", () => {
    setLogTraceId("run-42")
    logger.error("Scope", "boom")
    expect(errorSpy.mock.calls[0][0]).toBe("[Scope] [run-42] boom")
  })

  it("appends context as JSON when provided", () => {
    logger.error("Scope", "boom", { chapter: 8, model: "claude" })
    expect(errorSpy.mock.calls[0][0]).toBe('[Scope] boom {"chapter":8,"model":"claude"}')
  })

  it("omits the context suffix when context is empty/undefined", () => {
    logger.error("Scope", "boom", {})
    expect(errorSpy.mock.calls[0][0]).toBe("[Scope] boom")
    logger.error("Scope", "boom")
    expect(errorSpy.mock.calls[1][0]).toBe("[Scope] boom")
  })

  it("emits a JSON line to stderr when NOVEL_LOG_JSON=1", () => {
    process.env.NOVEL_LOG_JSON = "1"
    setLogTraceId("run-42")
    logger.error("Scope", "boom", { chapter: 8 })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const line = errorSpy.mock.calls[0][0] as string
    const parsed = JSON.parse(line)
    expect(parsed.level).toBe("error")
    expect(parsed.scope).toBe("Scope")
    expect(parsed.traceId).toBe("run-42")
    expect(parsed.message).toBe("boom")
    expect(parsed.context).toEqual({ chapter: 8 })
    expect(typeof parsed.ts).toBe("string")
  })

  it("getLogTraceId returns the current trace-id", () => {
    setLogTraceId("run-99")
    expect(getLogTraceId()).toBe("run-99")
  })
})
