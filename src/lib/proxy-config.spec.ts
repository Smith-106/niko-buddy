import { describe, expect, it } from "vitest"
import {
  buildNoProxyValue,
  DEFAULT_BYPASS_LIST,
  DEFAULT_PROXY_CONFIG,
  isProxyActive,
  validateProxyUrl,
} from "./proxy-config"

describe("validateProxyUrl", () => {
  it("rejects empty URLs", () => {
    expect(validateProxyUrl("   ")).toEqual({ ok: false, error: "URL is empty" })
  })

  it("rejects malformed URLs", () => {
    expect(validateProxyUrl("not a url at all")).toEqual({ ok: false, error: "Not a valid URL" })
  })

  it("rejects unsupported schemes", () => {
    expect(validateProxyUrl("socks5://127.0.0.1:1080")).toEqual({
      ok: false,
      error: 'Unsupported scheme "socks5:". Use http:// or https://',
    })
  })

  // NOTE: the "URL is missing a host" branch is unreachable in the Node test
  // environment — Node's WHATWG URL parser always extracts a hostname for
  // successfully-parsed http(s) URLs (e.g. "http:///path" → host "path").

  it("accepts valid http/https URLs with credentials", () => {
    expect(validateProxyUrl("http://127.0.0.1:7890")).toEqual({ ok: true })
    expect(validateProxyUrl("https://user:pass@proxy.example.com:8080")).toEqual({ ok: true })
  })
})

describe("buildNoProxyValue", () => {
  it("returns the bypass list when bypassLocal is on and null otherwise", () => {
    expect(buildNoProxyValue(true)).toBe(DEFAULT_BYPASS_LIST)
    expect(buildNoProxyValue(false)).toBeNull()
  })
})

describe("isProxyActive", () => {
  it("is false when disabled, URL empty, or malformed", () => {
    expect(isProxyActive({ enabled: false, url: "http://x", bypassLocal: true })).toBe(false)
    expect(isProxyActive({ enabled: true, url: "  ", bypassLocal: true })).toBe(false)
    expect(isProxyActive({ enabled: true, url: "ftp://x", bypassLocal: true })).toBe(false)
  })

  it("is true for a valid enabled config", () => {
    expect(isProxyActive({ ...DEFAULT_PROXY_CONFIG, enabled: true, url: "http://127.0.0.1:7890" })).toBe(true)
  })
})
