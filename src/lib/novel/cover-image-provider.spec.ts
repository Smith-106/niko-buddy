import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildCoverImageTask,
  COVER_ASPECT_SIZE,
  runCoverImageGeneration,
  slugify,
  type CoverImagePort,
} from "./cover-image-provider"
import { buildCoverBrief, type BookCoverMeta } from "./cover-brief"

const META: BookCoverMeta = {
  title: "雪夜行",
  genre: "玄幻",
  protagonistBrief: "黑衣剑客",
  tone: "孤寂",
  keyImagery: ["剑", "雪"],
}

const fsMocks = vi.hoisted(() => ({
  fileExists: vi.fn(async () => false),
  createDirectory: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
}))

vi.mock("@/commands/fs", () => fsMocks)

describe("cover-image-provider (64 号实施：P0-5 封面 provider)", () => {
  beforeEach(() => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.writeFile.mockClear()
    fsMocks.createDirectory.mockClear()
  })

  it("slugify：书名 → 安全文件名", () => {
    expect(slugify("雪夜行")).toBe("雪夜行")
    expect(slugify("Star Wars: 新希望!")).toBe("star-wars-新希望")
    expect(slugify("!!!")).toBe("untitled")
  })

  it("buildCoverImageTask：竖版默认 2:3 + prompt 含契约与比例约束", () => {
    const brief = buildCoverBrief(META)
    const task = buildCoverImageTask(META, brief)
    expect(task.aspect).toBe("portrait")
    expect(task.width).toBe(COVER_ASPECT_SIZE.portrait.width)
    expect(task.height).toBe(COVER_ASPECT_SIZE.portrait.height)
    expect(task.prompt).toContain("竖版 2:3")
    expect(task.prompt).toContain("雪夜行")
  })

  it("buildCoverImageTask：方形/横版尺寸表驱动", () => {
    const brief = buildCoverBrief(META)
    const square = buildCoverImageTask(META, brief, "square")
    expect(square.width).toBe(1024)
    expect(square.height).toBe(1024)
    const landscape = buildCoverImageTask(META, brief, "landscape")
    expect(landscape.width).toBe(1536)
  })

  it("runCoverImageGeneration：目标已存在 → skipped（幂等零覆盖）", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    const port: CoverImagePort = { generate: vi.fn(async () => new Uint8Array()) }
    const brief = buildCoverBrief(META)
    const task = buildCoverImageTask(META, brief)
    const result = await runCoverImageGeneration(port, "/proj", task)
    expect(result.ok).toBe(true)
    expect(result.reason).toBe("skipped")
    expect(port.generate).not.toHaveBeenCalled()
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("runCoverImageGeneration：正常生成 → generated + 落 .novel/covers", async () => {
    const port: CoverImagePort = {
      generate: vi.fn(async (input) => {
        expect(input.prompt).toContain("雪夜行")
        return new TextEncoder().encode("png-bytes")
      }),
    }
    const brief = buildCoverBrief(META)
    const task = buildCoverImageTask(META, brief)
    const result = await runCoverImageGeneration(port, "/proj", task)
    expect(result.ok).toBe(true)
    expect(result.reason).toBe("generated")
    expect(fsMocks.writeFile).toHaveBeenCalledWith(expect.stringContaining(".novel/covers"), "png-bytes")
  })

  it("runCoverImageGeneration：port 抛错 → failed（不吞异常）", async () => {
    const port: CoverImagePort = {
      generate: vi.fn(async () => {
        throw new Error("provider 401")
      }),
    }
    const brief = buildCoverBrief(META)
    const result = await runCoverImageGeneration(port, "/proj", buildCoverImageTask(META, brief))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("failed")
    expect(result.message).toContain("provider 401")
  })

  it("runCoverImageGeneration：abort → canceled", async () => {
    const controller = new AbortController()
    controller.abort()
    const port: CoverImagePort = { generate: vi.fn(async () => new Uint8Array()) }
    const brief = buildCoverBrief(META)
    const result = await runCoverImageGeneration(port, "/proj", buildCoverImageTask(META, brief), controller.signal)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("canceled")
  })
})
