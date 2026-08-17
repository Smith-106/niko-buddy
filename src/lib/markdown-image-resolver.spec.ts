import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  convertFileSrc: vi.fn((p: string) => `asset://${p}`),
}))

vi.mock("@/lib/platform", () => ({
  isTauri: mocks.isTauri,
}))

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mocks.convertFileSrc,
}))

import {
  resolveMarkdownImageSrc,
  resolveMarkdownImageSrcAsync,
} from "./markdown-image-resolver"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("resolveMarkdownImageSrc", () => {
  it("returns empty source unchanged", () => {
    expect(resolveMarkdownImageSrc("", "/p")).toBe("")
  })

  it("passes through external and data URIs", () => {
    expect(resolveMarkdownImageSrc("https://x/y.png", "/p")).toBe("https://x/y.png")
    expect(resolveMarkdownImageSrc("data:image/png;base64,abc", "/p")).toBe("data:image/png;base64,abc")
    expect(resolveMarkdownImageSrc("blob:http://x/1", "/p")).toBe("blob:http://x/1")
    expect(resolveMarkdownImageSrc("file:///tmp/x.png", "/p")).toBe("file:///tmp/x.png")
    expect(resolveMarkdownImageSrc("tauri://local/x.png", "/p")).toBe("tauri://local/x.png")
  })

  it("returns the source unchanged without a project", () => {
    expect(resolveMarkdownImageSrc("a.png", null)).toBe("a.png")
  })

  it("returns the source unchanged outside tauri", () => {
    mocks.isTauri.mockReturnValue(false)
    expect(resolveMarkdownImageSrc("a.png", "/p")).toBe("a.png")
  })

  it("converts absolute paths directly", () => {
    mocks.isTauri.mockReturnValue(true)
    expect(resolveMarkdownImageSrc("/abs/x.png", "/p")).toBe("asset:///abs/x.png")
    expect(resolveMarkdownImageSrc("C:\\img\\x.png", "/p")).toBe("asset://C:\\img\\x.png")
    expect(resolveMarkdownImageSrc("\\\\server\\share\\x.png", "/p")).toBe("asset://\\\\server\\share\\x.png")
  })

  it("joins wiki-relative paths under the project wiki root and strips ./", () => {
    mocks.isTauri.mockReturnValue(true)
    expect(resolveMarkdownImageSrc("media/a/img-1.png", "/p")).toBe("asset:///p/wiki/media/a/img-1.png")
    expect(resolveMarkdownImageSrc("./media/b.png", "C:\\proj")).toBe("asset://C:/proj/wiki/media/b.png")
    expect(mocks.convertFileSrc).toHaveBeenCalledWith("C:/proj/wiki/media/b.png")
  })
})

describe("resolveMarkdownImageSrcAsync", () => {
  it("mirrors the sync behavior with the same early returns", async () => {
    mocks.isTauri.mockReturnValue(false)
    await expect(resolveMarkdownImageSrcAsync("x.png", "/p")).resolves.toBe("x.png")
    await expect(resolveMarkdownImageSrcAsync("x.png", null)).resolves.toBe("x.png")
    await expect(resolveMarkdownImageSrcAsync("https://x/y.png", null)).resolves.toBe("https://x/y.png")
    await expect(resolveMarkdownImageSrcAsync("", "/p")).resolves.toBe("")
    mocks.isTauri.mockReturnValue(true)
    await expect(resolveMarkdownImageSrcAsync("media/c.png", "/p")).resolves.toBe("asset:///p/wiki/media/c.png")
    await expect(resolveMarkdownImageSrcAsync("/abs/d.png", "/p")).resolves.toBe("asset:///abs/d.png")
  })
})
