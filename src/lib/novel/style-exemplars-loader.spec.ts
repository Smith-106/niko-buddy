import { beforeEach, describe, expect, it, vi } from "vitest"

// fs mocks — loadStyleExemplars / markStyleExemplar 用 readFile /
// writeFileAtomic / createDirectory from @/commands/fs（projection-store 模式）。
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string): Promise<string> => ""),
  writeFileAtomic: vi.fn(async (_path: string, _contents: string): Promise<void> => {}),
  createDirectory: vi.fn(async (_path: string): Promise<void> => {}),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
}))

import {
  loadStyleExemplars,
  markStyleExemplar,
  pickTopKExemplars,
  STYLE_EXEMPLARS_TOP_K,
  STYLE_EXEMPLAR_TEXT_MAX_CHARS,
  type StyleExemplar,
} from "./style-exemplars-loader"

describe("EPIC-001 / ADR-29 / TASK-004: style-exemplars-loader", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFileAtomic.mockClear()
    fsMocks.createDirectory.mockClear()
  })

  it("loadStyleExemplars returns [] on missing file (backward compatible)", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("file not found"))
    const result = await loadStyleExemplars("/MissingProject")
    expect(result).toEqual([])
  })

  it("loadStyleExemplars throws SANITIZED error on corrupt JSON (PAT-DC1 CWE-532)", async () => {
    fsMocks.readFile.mockResolvedValue("{ truncated json")
    await expect(loadStyleExemplars("/Corrupt")).rejects.toThrow("style exemplars file is corrupt")
  })

  it("loadStyleExemplars sanitized error exposes NO raw json or path (PAT-DC1)", async () => {
    const rawJson = '{"secret":"path":"C:\\\\leak\\\\secret.json","token":"abc123"}'
    fsMocks.readFile.mockResolvedValue(rawJson)
    let errorMsg = ""
    try {
      await loadStyleExemplars("/Proj")
    } catch (e) {
      errorMsg = (e as Error).message
    }
    // 脱敏：错误消息不得包含 raw JSON 片段或文件路径。
    expect(errorMsg).toBe("style exemplars file is corrupt")
    expect(errorMsg).not.toContain("secret")
    expect(errorMsg).not.toContain("abc123")
    expect(errorMsg).not.toContain("/Proj")
    expect(errorMsg).not.toContain("leak")
  })

  it("loadStyleExemplars throws on non-array JSON (corrupt shape)", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ not: "an array" }))
    await expect(loadStyleExemplars("/Proj")).rejects.toThrow("style exemplars file is corrupt")
  })

  it("loadStyleExemplars returns parsed array on valid file", async () => {
    const exemplars: StyleExemplar[] = [
      { exemplarId: "a", chapterId: "ch1", text: "风格好的段落", markType: "style", createdAt: "2026-07-10T00:00:00Z" },
      { exemplarId: "b", chapterId: "ch1", text: "声线好的对白", markType: "voice", createdAt: "2026-07-10T00:01:00Z" },
    ]
    fsMocks.readFile.mockResolvedValue(JSON.stringify(exemplars))
    const result = await loadStyleExemplars("/Proj")
    expect(result).toEqual(exemplars)
  })

  it("markStyleExemplar persists to .novel/style-exemplars.json (Draft-first exception C-001)", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("file not found"))
    await markStyleExemplar("/Proj", {
      chapterId: "ch1",
      text: "好的段落",
      markType: "style",
    })
    // createDirectory(.novel) + writeFileAtomic(style-exemplars.json)
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("/Proj/.novel")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "/Proj/.novel/style-exemplars.json",
      expect.any(String),
    )
    const written = fsMocks.writeFileAtomic.mock.calls[0][1] as string
    const parsed = JSON.parse(written) as StyleExemplar[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0].chapterId).toBe("ch1")
    expect(parsed[0].text).toBe("好的段落")
    expect(parsed[0].markType).toBe("style")
    // exemplarId 用 crypto.randomUUID()（非空字符串）。
    expect(parsed[0].exemplarId).toBeTruthy()
    // createdAt 是 ISO 时间戳。
    expect(parsed[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("markStyleExemplar read-modify-write appends to existing exemplars", async () => {
    const existing: StyleExemplar[] = [
      { exemplarId: "old", chapterId: "ch0", text: "旧段落", markType: "style", createdAt: "2026-07-09T00:00:00Z" },
    ]
    fsMocks.readFile.mockResolvedValue(JSON.stringify(existing))
    await markStyleExemplar("/Proj", {
      chapterId: "ch1",
      text: "新段落",
      markType: "pacing",
      note: "节奏好",
    })
    const written = fsMocks.writeFileAtomic.mock.calls[0][1] as string
    const parsed = JSON.parse(written) as StyleExemplar[]
    expect(parsed).toHaveLength(2)
    expect(parsed[1].note).toBe("节奏好")
    expect(parsed[1].markType).toBe("pacing")
  })

  it("markStyleExemplar rejects invalid markType (enum validation, PAT-G2 twin)", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("file not found"))
    await expect(
      markStyleExemplar("/Proj", {
        chapterId: "ch1",
        text: "x",
        // @ts-expect-error — 故意传非法 markType 测枚举校验
        markType: "invalid_type",
      }),
    ).rejects.toThrow("invalid markType")
  })

  it("pickTopKExemplars returns [] for empty list (zero-exemplar graceful degrade)", () => {
    expect(pickTopKExemplars([])).toEqual([])
  })

  it("pickTopKExemplars diversifies by markType (one per type first)", () => {
    const exemplars: StyleExemplar[] = [
      { exemplarId: "1", chapterId: "c", text: "style1", markType: "style", createdAt: "2026-07-10T00:00:00Z" },
      { exemplarId: "2", chapterId: "c", text: "style2", markType: "style", createdAt: "2026-07-10T00:01:00Z" },
      { exemplarId: "3", chapterId: "c", text: "voice1", markType: "voice", createdAt: "2026-07-10T00:02:00Z" },
      { exemplarId: "4", chapterId: "c", text: "pacing1", markType: "pacing", createdAt: "2026-07-10T00:03:00Z" },
    ]
    const picked = pickTopKExemplars(exemplars, STYLE_EXEMPLARS_TOP_K)
    expect(picked).toHaveLength(3)
    // 每个 markType 至少 1 个（多样性）。
    const types = new Set(picked.map((p) => p.markType))
    expect(types.has("style")).toBe(true)
    expect(types.has("voice")).toBe(true)
    expect(types.has("pacing")).toBe(true)
    // style 取最新（createdAt desc）。
    const stylePicked = picked.find((p) => p.markType === "style")
    expect(stylePicked?.exemplarId).toBe("2")
  })

  it("pickTopKExemplars truncates text to STYLE_EXEMPLAR_TEXT_MAX_CHARS (token budget)", () => {
    const longText = "x".repeat(STYLE_EXEMPLAR_TEXT_MAX_CHARS + 500)
    const exemplars: StyleExemplar[] = [
      { exemplarId: "1", chapterId: "c", text: longText, markType: "style", createdAt: "2026-07-10T00:00:00Z" },
    ]
    const picked = pickTopKExemplars(exemplars, STYLE_EXEMPLARS_TOP_K)
    expect(picked).toHaveLength(1)
    expect(picked[0].text.length).toBe(STYLE_EXEMPLAR_TEXT_MAX_CHARS)
  })

  it("pickTopKExemplars respects top-K limit", () => {
    const exemplars: StyleExemplar[] = Array.from({ length: 10 }, (_, i) => ({
      exemplarId: String(i),
      chapterId: "c",
      text: `t${i}`,
      markType: "style" as const,
      createdAt: new Date(2026, 6, 10, 0, i).toISOString(),
    }))
    const picked = pickTopKExemplars(exemplars, STYLE_EXEMPLARS_TOP_K)
    expect(picked).toHaveLength(STYLE_EXEMPLARS_TOP_K)
    // 全部同 markType，按 createdAt desc 取最新 top-K。
    expect(picked[0].exemplarId).toBe("9")
  })

  it("exemplarEnabled flag default true — verified via DEFAULT_NOVEL_CONFIG (TASK-004 convergence)", async () => {
    // 加载 wiki-store 的 DEFAULT_NOVEL_CONFIG 验证 exemplarEnabled 默认 true。
    // dynamic import 避免触发 zustand 全量 mock。
    const store = await import("@/stores/wiki-store")
    expect(store.DEFAULT_NOVEL_CONFIG.exemplarEnabled).toBe(true)
    expect(store.DEFAULT_NOVEL_CONFIG.conditionalRoutingEnabled).toBe(true)
  })
})
