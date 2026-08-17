import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { logger, setLogTraceId, getLogTraceId, cn, pad, toErrorMessage, uniqueNonEmpty, validateSeverity } from "./utils"

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

  it("emits an empty context object in JSON mode when none is given", () => {
    process.env.NOVEL_LOG_JSON = "1"
    // JSON 模式下所有级别统一走 console.error（机器消费单行）
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    logger.warn("Scope", "no-ctx")
    expect(errSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(errSpy.mock.calls[0][0] as string)
    expect(parsed.level).toBe("warn")
    expect(parsed.context).toEqual({})
    errSpy.mockRestore()
  })

  it("getLogTraceId returns the current trace-id", () => {
    setLogTraceId("run-99")
    expect(getLogTraceId()).toBe("run-99")
  })
})

describe("cn", () => {
  it("merges tailwind class lists, deduplicating conflicts", () => {
    expect(cn("px-2", "px-4")).toBe("px-4")
    expect(cn("text-red-500", false && "text-blue-500", null, undefined)).toBe("text-red-500")
    expect(cn(["a", "b"])).toBe("a b")
  })
})

describe("pad", () => {
  it("zero-pads single digits and keeps double digits", () => {
    expect(pad(1)).toBe("01")
    expect(pad(9)).toBe("09")
    expect(pad(10)).toBe("10")
    expect(pad(0)).toBe("00")
  })
})

describe("toErrorMessage", () => {
  it("extracts the message from Error instances", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom")
  })

  it("stringifies non-Error values", () => {
    expect(toErrorMessage("raw string")).toBe("raw string")
    expect(toErrorMessage(42)).toBe("42")
    expect(toErrorMessage(undefined)).toBe("undefined")
  })
})

describe("uniqueNonEmpty", () => {
  it("trims, dedupes, and drops empty values", () => {
    expect(uniqueNonEmpty([" a ", "b", "a", "", "  ", "b"])).toEqual(["a", "b"])
  })

  it("returns an empty array for empty input", () => {
    expect(uniqueNonEmpty([])).toEqual([])
    expect(uniqueNonEmpty(["", " "])).toEqual([])
  })
})

describe("validateSeverity", () => {
  it("passes through valid severities", () => {
    expect(validateSeverity("error")).toBe("error")
    expect(validateSeverity("warning")).toBe("warning")
    expect(validateSeverity("info")).toBe("info")
  })

  it("falls back to warning for invalid values", () => {
    expect(validateSeverity("critical")).toBe("warning")
    expect(validateSeverity(null)).toBe("warning")
    expect(validateSeverity(undefined)).toBe("warning")
  })
})
