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
  type StyleExemplarMarkType,
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

  it("loadStyleExemplars throws on shape without array nor exemplars field (corrupt shape)", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ not: "an array" }))
    await expect(loadStyleExemplars("/Proj")).rejects.toThrow("style exemplars file is corrupt")
  })

  it("loadStyleExemplars unwraps {$schema, exemplars:[...]} wrapped object (dual-format FIX-2/EC-1)", async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        $schema: "https://example.test/style-exemplars.schema.json",
        exemplars: [
          { id: "EX-001", chapterId: "ch1", text: "风格好的段落", markType: "style", note: "整体文风", markedAt: "2026-07-10T00:00:00Z" },
          { id: "EX-002", chapterId: "ch1", text: "声线好的对白", markType: "voice", markedAt: "2026-07-10T00:01:00Z" },
        ],
      }),
    )
    const result = await loadStyleExemplars("/Proj")
    expect(result).toHaveLength(2)
    // 字段别名映射：id→exemplarId、markedAt→createdAt
    expect(result[0]).toEqual({
      exemplarId: "EX-001",
      chapterId: "ch1",
      text: "风格好的段落",
      markType: "style",
      note: "整体文风",
      createdAt: "2026-07-10T00:00:00Z",
    })
    expect(result[1].exemplarId).toBe("EX-002")
    expect(result[1].createdAt).toBe("2026-07-10T00:01:00Z")
  })

  it("loadStyleExemplars new-format fields win over legacy aliases (id/markedAt)", async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify([
        { exemplarId: "new", id: "legacy", chapterId: "ch1", text: "x", markType: "style", createdAt: "2026-07-11T00:00:00Z", markedAt: "2026-07-10T00:00:00Z" },
      ]),
    )
    const result = await loadStyleExemplars("/Proj")
    expect(result[0].exemplarId).toBe("new")
    expect(result[0].createdAt).toBe("2026-07-11T00:00:00Z")
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

  it("markStyleExemplar appends to wrapped {$schema, exemplars} file without overwriting (F2 data-loss guard)", async () => {
    // 生产 v1.0 包装格式：mark 读路径必须解包装后追加，不得重建覆盖。
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        $schema: "https://example.test/style-exemplars.schema.json",
        exemplars: [
          { id: "EX-001", chapterId: "ch1", text: "种子段落 1", markType: "style", markedAt: "2026-07-10T00:00:00Z" },
          { id: "EX-002", chapterId: "ch1", text: "种子段落 2", markType: "voice", markedAt: "2026-07-10T00:01:00Z" },
        ],
      }),
    )
    await markStyleExemplar("/Proj", {
      chapterId: "ch1",
      text: "新段落",
      markType: "pacing",
    })
    const written = fsMocks.writeFileAtomic.mock.calls[0][1] as string
    const parsed = JSON.parse(written) as StyleExemplar[]
    // 2 条种子 + 1 条新增 = 3，不得被重建覆盖为 1。
    expect(parsed).toHaveLength(3)
    expect(parsed[0].exemplarId).toBe("EX-001")
    expect(parsed[0].createdAt).toBe("2026-07-10T00:00:00Z")
    expect(parsed[2].markType).toBe("pacing")
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
      { exemplarId: "5", chapterId: "c", text: "thrill1", markType: "thrill", createdAt: "2026-07-10T00:04:00Z" },
      { exemplarId: "6", chapterId: "c", text: "pull1", markType: "pull", createdAt: "2026-07-10T00:05:00Z" },
      { exemplarId: "7", chapterId: "c", text: "cons1", markType: "consistency", createdAt: "2026-07-10T00:06:00Z" },
    ]
    const picked = pickTopKExemplars(exemplars, STYLE_EXEMPLARS_TOP_K)
    expect(picked).toHaveLength(6)
    // 每个 markType 至少 1 个（多样性）。
    const types = new Set(picked.map((p) => p.markType))
    expect(types.has("style")).toBe(true)
    expect(types.has("voice")).toBe(true)
    expect(types.has("pacing")).toBe(true)
    expect(types.has("thrill")).toBe(true)
    expect(types.has("pull")).toBe(true)
    expect(types.has("consistency")).toBe(true)
    // style 取最新（createdAt desc）。
    const stylePicked = picked.find((p) => p.markType === "style")
    expect(stylePicked?.exemplarId).toBe("2")
  })

  it("markStyleExemplar accepts thrill and pull markTypes", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("file not found"))
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
    fsMocks.createDirectory.mockResolvedValue(undefined)
    await markStyleExemplar("/Proj", {
      chapterId: "ch1",
      text: "thrill payoff beat",
      markType: "thrill",
    })
    let written = fsMocks.writeFileAtomic.mock.calls[fsMocks.writeFileAtomic.mock.calls.length - 1]?.[1] as string
    const first = JSON.parse(written) as StyleExemplar[]
    expect(first[first.length - 1]?.markType).toBe("thrill")
    // second mark: simulate existing file containing first write
    fsMocks.readFile.mockResolvedValue(written)
    await markStyleExemplar("/Proj", {
      chapterId: "ch1",
      text: "next chapter hook beat",
      markType: "pull",
    })
    written = fsMocks.writeFileAtomic.mock.calls[fsMocks.writeFileAtomic.mock.calls.length - 1]?.[1] as string
    const types = (JSON.parse(written) as StyleExemplar[]).map((e) => e.markType)
    expect(types).toContain("thrill")
    expect(types).toContain("pull")
  })

  it("normalizeExemplar falls back through legacy aliases and empty strings for absent fields", async () => {
    // 仅提供旧式最小字段: chapterId / text / createdAt 缺失 → 空串;
    // id→exemplarId、markedAt→createdAt 副账映射仍生效。
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify([
        { id: "legacy", text: "x", markType: "style", markedAt: "2026-07-10T00:00:00Z" },
        // 全部字段缺失 → 均为空串 (双 ?? 链的末端兜底臂)
        {},
        // 非法 markType → String 强制转换臂 (不抛错, 交给 pickTopK 过滤)
        { exemplarId: "bad-type", chapterId: "c", text: "t", markType: 42 },
      ]),
    )
    const result = await loadStyleExemplars("/Proj")
    expect(result[0]).toEqual({
      exemplarId: "legacy",
      chapterId: "",
      text: "x",
      markType: "style",
      note: undefined,
      createdAt: "2026-07-10T00:00:00Z",
    })
    expect(result[1]).toEqual({
      exemplarId: "",
      chapterId: "",
      text: "",
      markType: "undefined",
      note: undefined,
      createdAt: "",
    })
    expect(result[2].markType).toBe("42")
  })

  it("markStyleExemplar rebuilds storage when the existing file has an invalid shape (arr === null)", async () => {
    // 文件存在且 JSON 合法, 但既非数组也非 {$schema, exemplars} 包装 →
    // 解包装返回 null → existing 保持 [] (不阻断标记, 重建存储)。
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ not: "an array" }))
    await markStyleExemplar("/Proj", {
      chapterId: "ch1",
      text: "新段落",
      markType: "style",
    })
    const written = fsMocks.writeFileAtomic.mock.calls[0][1] as string
    const parsed = JSON.parse(written) as StyleExemplar[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0].text).toBe("新段落")
  })

  it("pickTopKExemplars skips entries whose markType is outside the enum", () => {
    const exemplars: StyleExemplar[] = [
      { exemplarId: "bad", chapterId: "c", text: "noise", markType: "bogus" as unknown as StyleExemplarMarkType, createdAt: "2026-07-10T00:01:00Z" }, // 故意构造非法 markType 测跳过分支
      { exemplarId: "good", chapterId: "c", text: "signal", markType: "style", createdAt: "2026-07-10T00:02:00Z" },
    ]
    const picked = pickTopKExemplars(exemplars, STYLE_EXEMPLARS_TOP_K)
    expect(picked.map((p) => p.exemplarId)).toEqual(["good"])
  })

  it("pickTopKExemplars treats an unparseable createdAt as epoch 0 (sorts last)", () => {
    const exemplars: StyleExemplar[] = [
      { exemplarId: "old-ish", chapterId: "c", text: "a", markType: "style", createdAt: "not-a-date" },
      { exemplarId: "fresh", chapterId: "c", text: "b", markType: "style", createdAt: "2026-07-10T00:03:00Z" },
    ]
    const picked = pickTopKExemplars(exemplars, 2)
    expect(picked.map((p) => p.exemplarId)).toEqual(["fresh", "old-ish"])
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

  describe("F-011 Voice Preservation 第三层 — voice exemplar 支持", () => {
  it("voice 是合法 markType 枚举值", () => {
    // voice 已在 StyleExemplarMarkType 和 VALID_MARK_TYPES 中
    const validVoice: StyleExemplarMarkType = "voice"
    expect(validVoice).toBe("voice")
  })

  it("voice 类 exemplar 维持 Draft-first 例外（直写正式层，不经过 pending→accept）", async () => {
    // Draft-first 例外 C-001：exemplar 是用户标记，直写正式层
    fsMocks.readFile.mockRejectedValue(new Error("file not found"))
    await markStyleExemplar("/Proj", {
      chapterId: "ch1",
      text: "角色声线好的段落",
      markType: "voice",
      note: "对白毛边自然",
    })
    // 直接写入 .novel/style-exemplars.json，不经 pending→accept
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("/Proj/.novel")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "/Proj/.novel/style-exemplars.json",
      expect.any(String),
    )
    const written = fsMocks.writeFileAtomic.mock.calls[0][1] as string
    const parsed = JSON.parse(written) as StyleExemplar[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0].markType).toBe("voice")
    expect(parsed[0].note).toBe("对白毛边自然")
    // Draft-first 例外：exemplarId 和 createdAt 已写入正式层（无 pending 状态）
    expect(parsed[0].exemplarId).toBeTruthy()
    expect(parsed[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("voice exemplar 在 pickTopK 中与其他 markType 共同参与多样性排名", () => {
    const exemplars: StyleExemplar[] = [
      { exemplarId: "v1", chapterId: "c", text: "voice段落", markType: "voice", createdAt: "2026-07-10T00:00:00Z" },
      { exemplarId: "s1", chapterId: "c", text: "style段落", markType: "style", createdAt: "2026-07-10T00:01:00Z" },
      { exemplarId: "p1", chapterId: "c", text: "pacing段落", markType: "pacing", createdAt: "2026-07-10T00:02:00Z" },
    ]
    const picked = pickTopKExemplars(exemplars, 3)
    const types = picked.map((p) => p.markType)
    expect(types).toContain("voice")
    expect(types).toContain("style")
    expect(types).toContain("pacing")
  })
})

it("exemplarEnabled flag default true — verified via DEFAULT_NOVEL_CONFIG (TASK-004 convergence)", async () => {
    // 加载 wiki-store 的 DEFAULT_NOVEL_CONFIG 验证 exemplarEnabled 默认 true。
    // dynamic import 避免触发 zustand 全量 mock。
    const store = await import("@/stores/wiki-store")
    expect(store.DEFAULT_NOVEL_CONFIG.exemplarEnabled).toBe(true)
    expect(store.DEFAULT_NOVEL_CONFIG.conditionalRoutingEnabled).toBe(true)
  })
})
