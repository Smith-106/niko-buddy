import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

const fsState = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  fileExists: vi.fn(),
  readFile: vi.fn(),
  readFileAsBase64: vi.fn(),
  writeFile: vi.fn(),
}))
const captionImageMock = vi.hoisted(() => vi.fn())

vi.mock("@/commands/fs", () => fsState)
vi.mock("@/lib/vision-caption", () => ({ captionImage: captionImageMock }))

import {
  __test,
  captionMarkdownImages,
  loadCaptionCache,
} from "./image-caption-pipeline"

const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "sk-test",
  model: "gpt-4o",
  maxContextSize: 128000,
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  reasoning: { mode: "off" },
}

const B64 = "aGVsbG8=" // base64 of "hello"
const CACHE_PATH = "/P/.qmai/image-caption-cache.json"

let helloHash = ""
let warnSpy: ReturnType<typeof vi.spyOn>

beforeAll(async () => {
  helloHash = await __test.sha256OfBase64(B64)
})

beforeEach(() => {
  vi.clearAllMocks()
  fsState.createDirectory.mockReset().mockResolvedValue(undefined)
  fsState.fileExists.mockReset().mockResolvedValue(false)
  fsState.readFile.mockReset().mockRejectedValue(new Error("no cache file"))
  fsState.readFileAsBase64.mockReset().mockRejectedValue(new Error("no image"))
  fsState.writeFile.mockReset().mockResolvedValue(undefined)
  captionImageMock.mockReset().mockResolvedValue("a caption")
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe("sha256OfBase64", () => {
  it("computes the SHA-256 of the decoded bytes", async () => {
    expect(helloHash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
  })

  it("hashes an empty payload", async () => {
    await expect(__test.sha256OfBase64("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
  })
})

describe("findImageReferences", () => {
  it("captures full match, alt, url, index and length", () => {
    const refs = __test.findImageReferences("![a](x.png) text ![b](y.png)")
    expect(refs).toHaveLength(2)
    expect(refs[0]).toEqual({ full: "![a](x.png)", alt: "a", url: "x.png", index: 0, length: 11 })
    expect(refs[1]).toMatchObject({ url: "y.png", alt: "b" })
    expect(refs[1].index).toBe(17)
    expect(refs[1].length).toBe(11)
  })

  it("ignores html <img> tags and returns [] for plain text", () => {
    expect(__test.findImageReferences('<img src="x.png">')).toEqual([])
    expect(__test.findImageReferences("no images here")).toEqual([])
  })
})

describe("loadCaptionCache", () => {
  it("returns a hash → caption map when the cache file exists", async () => {
    fsState.fileExists.mockResolvedValue(true)
    fsState.readFile.mockResolvedValue(
      JSON.stringify({ [helloHash]: { caption: "cached", mimeType: "image/png", model: "m", capturedAt: "t" } }),
    )
    const map = await loadCaptionCache("/P")
    expect([...map.entries()]).toEqual([[helloHash, "cached"]])
  })

  it("returns an empty map when the cache file is missing", async () => {
    await expect(loadCaptionCache("/P")).resolves.toEqual(new Map())
    expect(fsState.readFile).not.toHaveBeenCalled()
  })

  it("returns an empty map for a non-object / array / null payload", async () => {
    for (const payload of ["[]", "null", "42"]) {
      fsState.fileExists.mockResolvedValue(true)
      fsState.readFile.mockResolvedValue(payload)
      await expect(loadCaptionCache("/P")).resolves.toEqual(new Map())
    }
  })

  it("warns and returns an empty map when the cache is corrupt", async () => {
    fsState.fileExists.mockResolvedValue(true)
    fsState.readFile.mockResolvedValue("{broken")
    await expect(loadCaptionCache("/P")).resolves.toEqual(new Map())
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("corrupt cache"), expect.any(String))
  })

  it("warns and returns an empty map when reading fails with a non-Error", async () => {
    fsState.fileExists.mockResolvedValue(true)
    fsState.readFile.mockRejectedValue("disk error")
    await expect(loadCaptionCache("/P")).resolves.toEqual(new Map())
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("corrupt cache"), "disk error")
  })
})

describe("captionMarkdownImages", () => {
  it("short-circuits when the markdown has no image references", async () => {
    const result = await captionMarkdownImages("/P", "plain text", llmConfig)
    expect(result).toEqual({ enrichedMarkdown: "plain text", freshCaptions: 0, cachedCaptions: 0, failed: 0 })
    expect(fsState.fileExists).not.toHaveBeenCalled()
  })

  it("short-circuits when every reference is filtered out by shouldCaption", async () => {
    const result = await captionMarkdownImages("/P", "![a](x.png)", llmConfig, {
      shouldCaption: () => false,
    })
    expect(result).toEqual({ enrichedMarkdown: "![a](x.png)", freshCaptions: 0, cachedCaptions: 0, failed: 0 })
    expect(fsState.fileExists).not.toHaveBeenCalled()
  })

  it("captions a fresh image, persists the cache and rewrites the alt text", async () => {
    fsState.readFileAsBase64.mockResolvedValue({ base64: B64, mimeType: "image/png" })
    captionImageMock.mockResolvedValue("The logo caption")
    const result = await captionMarkdownImages("/P", "![old](logo.png)", llmConfig)
    expect(result).toEqual({
      enrichedMarkdown: "![The logo caption](logo.png)",
      freshCaptions: 1,
      cachedCaptions: 0,
      failed: 0,
    })
    expect(captionImageMock).toHaveBeenCalledWith(
      B64,
      "image/png",
      llmConfig,
      undefined,
      { contextBefore: "", contextAfter: "" },
    )
    expect(fsState.createDirectory).toHaveBeenCalledWith("/P/.qmai")
    expect(fsState.writeFile).toHaveBeenCalledWith(CACHE_PATH, expect.stringContaining(helloHash))
  })

  it("serves a caption from the cache without calling the LLM", async () => {
    fsState.fileExists.mockResolvedValue(true)
    fsState.readFile.mockResolvedValue(
      JSON.stringify({ [helloHash]: { caption: "cached caption", mimeType: "image/png", model: "m", capturedAt: "t" } }),
    )
    fsState.readFileAsBase64.mockResolvedValue({ base64: B64, mimeType: "image/png" })
    const result = await captionMarkdownImages("/P", "![x](img.png)", llmConfig)
    expect(result).toEqual({
      enrichedMarkdown: "![cached caption](img.png)",
      freshCaptions: 0,
      cachedCaptions: 1,
      failed: 0,
    })
    expect(captionImageMock).not.toHaveBeenCalled()
    expect(fsState.writeFile).not.toHaveBeenCalled()
  })

  it("resolves absolute image URLs as-is against the wiki root fallback", async () => {
    fsState.readFileAsBase64.mockResolvedValue({ base64: B64, mimeType: "image/png" })
    await captionMarkdownImages("/P", "![](/abs/img.png)", llmConfig)
    expect(fsState.readFileAsBase64).toHaveBeenCalledWith("/abs/img.png")
  })

  it("uses the urlToAbsPath hook and counts unresolvable URLs as failures", async () => {
    fsState.readFileAsBase64.mockResolvedValue({ base64: B64, mimeType: "image/png" })
    captionImageMock.mockResolvedValue("cap")
    const result = await captionMarkdownImages("/P", "![a](x.png) ![b](y.png)", llmConfig, {
      urlToAbsPath: (url) => (url === "x.png" ? "/custom/x.png" : null),
    })
    expect(result).toEqual({
      enrichedMarkdown: "![cap](x.png) ![b](y.png)",
      freshCaptions: 1,
      cachedCaptions: 0,
      failed: 1,
    })
    expect(fsState.readFileAsBase64).toHaveBeenCalledWith("/custom/x.png")
    expect(fsState.readFileAsBase64).not.toHaveBeenCalledWith("/custom/y.png")
  })

  it("continues past a base64 read failure and counts it as failed", async () => {
    fsState.readFileAsBase64.mockRejectedValue(new Error("ENOENT"))
    const result = await captionMarkdownImages("/P", "![a](x.png)", llmConfig)
    expect(result.failed).toBe(1)
    expect(result.enrichedMarkdown).toBe("![a](x.png)")
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failed to read /P/wiki/x.png"), "ENOENT")
  })

  it("logs a non-Error read failure verbatim", async () => {
    fsState.readFileAsBase64.mockRejectedValue("permission denied")
    const result = await captionMarkdownImages("/P", "![a](x.png)", llmConfig)
    expect(result.failed).toBe(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failed to read /P/wiki/x.png"), "permission denied")
  })

  it("continues past a caption LLM failure and counts it as failed", async () => {
    fsState.readFileAsBase64.mockResolvedValue({ base64: B64, mimeType: "image/png" })
    captionImageMock.mockRejectedValue("vision down")
    const result = await captionMarkdownImages("/P", "![a](x.png)", llmConfig)
    expect(result.failed).toBe(1)
    expect(result.freshCaptions).toBe(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("caption failed for /P/wiki/x.png"), "vision down")
  })

  it("logs an Error caption failure with its message", async () => {
    fsState.readFileAsBase64.mockResolvedValue({ base64: B64, mimeType: "image/png" })
    captionImageMock.mockRejectedValue(new Error("vision timeout"))
    const result = await captionMarkdownImages("/P", "![a](x.png)", llmConfig)
    expect(result.failed).toBe(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("caption failed for /P/wiki/x.png"), "vision timeout")
  })

  it("still returns the enriched markdown when persisting the cache fails", async () => {
    fsState.readFileAsBase64.mockResolvedValue({ base64: B64, mimeType: "image/png" })
    captionImageMock.mockResolvedValue("cap")
    fsState.writeFile.mockRejectedValue(new Error("disk full"))
    const result = await captionMarkdownImages("/P", "![a](x.png)", llmConfig)
    expect(result.freshCaptions).toBe(1)
    expect(result.enrichedMarkdown).toBe("![cap](x.png)")
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failed to persist cache"), "disk full")
  })

  it("logs a non-Error cache persist failure verbatim", async () => {
    fsState.readFileAsBase64.mockResolvedValue({ base64: B64, mimeType: "image/png" })
    captionImageMock.mockResolvedValue("cap")
    fsState.writeFile.mockRejectedValue("readonly filesystem")
    const result = await captionMarkdownImages("/P", "![a](x.png)", llmConfig)
    expect(result.freshCaptions).toBe(1)
    expect(result.enrichedMarkdown).toBe("![cap](x.png)")
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failed to persist cache"), "readonly filesystem")
  })

  it("runs a concurrent worker pool with progress reporting", async () => {
    // distinct base64 per URL so each ref hashes differently and all stay fresh
    const byUrl: Record<string, string> = {
      "1.png": Buffer.from("img1").toString("base64"),
      "2.png": Buffer.from("img2").toString("base64"),
      "3.png": Buffer.from("img3").toString("base64"),
    }
    fsState.readFileAsBase64.mockImplementation((p: string) =>
      Promise.resolve({ base64: byUrl[p.split("/").pop()!] ?? B64, mimeType: "image/png" }),
    )
    captionImageMock.mockImplementation(async (b64: string) => `cap-${b64}`)
    const progress: Array<[number, number]> = []
    const result = await captionMarkdownImages(
      "/P",
      "![a](1.png) ![b](2.png) ![c](3.png)",
      llmConfig,
      {
        concurrency: 2,
        onProgress: (done, total) => progress.push([done, total]),
      },
    )
    expect(result.freshCaptions).toBe(3)
    expect(result.enrichedMarkdown).toBe(
      `![cap-${byUrl["1.png"]}](1.png) ![cap-${byUrl["2.png"]}](2.png) ![cap-${byUrl["3.png"]}](3.png)`,
    )
    expect(captionImageMock).toHaveBeenCalledTimes(3)
    expect(progress.sort((x, y) => x[0] - y[0])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })

  it("caps the worker count at the number of unique refs", async () => {
    fsState.readFileAsBase64.mockResolvedValue({ base64: B64, mimeType: "image/png" })
    captionImageMock.mockResolvedValue("cap")
    const progress: number[] = []
    const result = await captionMarkdownImages("/P", "![a](1.png)", llmConfig, {
      concurrency: 5,
      onProgress: (done) => progress.push(done),
    })
    expect(result.freshCaptions).toBe(1)
    expect(progress).toEqual([1])
  })

  it("aborts immediately when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await captionMarkdownImages("/P", "![a](x.png)", llmConfig, {
      signal: controller.signal,
    })
    expect(result).toEqual({ enrichedMarkdown: "![a](x.png)", freshCaptions: 0, cachedCaptions: 0, failed: 0 })
    expect(fsState.readFileAsBase64).not.toHaveBeenCalled()
  })

  it("honours a non-aborted signal and forwards it to captionImage", async () => {
    const controller = new AbortController()
    fsState.readFileAsBase64.mockResolvedValue({ base64: B64, mimeType: "image/png" })
    captionImageMock.mockResolvedValue("cap")
    await captionMarkdownImages("/P", "![a](x.png)", llmConfig, { signal: controller.signal })
    expect(captionImageMock).toHaveBeenCalledWith(B64, "image/png", llmConfig, controller.signal, {
      contextBefore: "",
      contextAfter: "",
    })
  })

  it("de-duplicates refs sharing the same URL into one caption call", async () => {
    fsState.readFileAsBase64.mockResolvedValue({ base64: B64, mimeType: "image/png" })
    captionImageMock.mockResolvedValue("cap")
    const result = await captionMarkdownImages("/P", "![a](x.png) ![b](x.png)", llmConfig)
    expect(result.freshCaptions).toBe(1)
    expect(result.enrichedMarkdown).toBe("![cap](x.png) ![cap](x.png)")
    expect(captionImageMock).toHaveBeenCalledTimes(1)
  })

  it("sanitises captions for safe markdown alt text", async () => {
    fsState.readFileAsBase64.mockResolvedValue({ base64: B64, mimeType: "image/png" })
    captionImageMock.mockResolvedValue("line1\nline2 ]fig")
    const result = await captionMarkdownImages("/P", "![old](s.png)", llmConfig)
    expect(result.enrichedMarkdown).toBe("![line1 line2 )fig](s.png)")
  })

  it("supports mixed filtering inside one document", async () => {
    fsState.readFileAsBase64.mockResolvedValue({ base64: B64, mimeType: "image/png" })
    captionImageMock.mockResolvedValue("cap")
    const result = await captionMarkdownImages("/P", "![a](ok.png) ![b](skip.jpg)", llmConfig, {
      shouldCaption: (url) => url.endsWith(".png"),
    })
    expect(result.freshCaptions).toBe(1)
    expect(result.enrichedMarkdown).toBe("![cap](ok.png) ![b](skip.jpg)")
  })
})
