import { afterEach, expect, test, vi } from "vitest"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

test("uses native fetch in a plain browser without Tauri internals", async () => {
  const nativeFetch = vi.fn(async () => new Response("ok"))

  vi.stubGlobal("window", {})
  vi.stubGlobal("fetch", nativeFetch)

  const { getHttpFetch } = await import("./tauri-fetch")
  const httpFetch = await getHttpFetch()

  await expect(httpFetch("https://example.com")).resolves.toBeInstanceOf(Response)
  // withUrlGuard always forwards (input, init); init is undefined when omitted.
  expect(nativeFetch).toHaveBeenCalledWith("https://example.com", undefined)
})
