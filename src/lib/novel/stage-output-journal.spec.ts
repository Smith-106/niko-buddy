/**
 * stage-output-journal.spec.ts — T18 组件 1 编排面 LLM 工件缓存收敛测试（目标覆盖率 100%）。
 *
 * 覆盖：指令 digest 键缓存（命中/未命中/TTL 过期/崩溃后命中跳过 LLM）+ JSONL 容错解析 +
 * 记录构造/序列化 + resolveStageOutput 编排查询 + 默认 deps。
 * 不依赖 Tauri 运行时：mock `@/commands/fs`。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import {
  JOURNAL_DIR_NAME,
  JOURNAL_TTL_MS,
  JOURNAL_SCHEMA_VERSION,
  journalDirPath,
  journalFilePath,
  parentDir,
  computeInstructionDigest,
  buildStageRecord,
  isExpired,
  parseJournalLines,
  findLatestRecord,
  serializeRecord,
  saveJournalEntry,
  loadJournalEntry,
  resolveStageOutput,
  defaultStageJournalDeps,
  type StageJournalDeps,
  type StageOutputRecord,
} from "./stage-output-journal"

vi.mock("@/commands/fs", () => ({
  createDirectory: vi.fn(async () => {}),
  readFile: vi.fn(async () => ""),
  writeFileAtomic: vi.fn(async () => {}),
}))

const createDirectoryMock = vi.mocked(createDirectory)
const readFileMock = vi.mocked(readFile)
const writeFileAtomicMock = vi.mocked(writeFileAtomic)

function mockDeps(over: Partial<StageJournalDeps> = {}): StageJournalDeps {
  return {
    read: async () => "",
    writeFile: async () => {},
    createDirectory: async () => {},
    ...over,
  }
}

const NOW = 1_000_000_000_000

function rec(over: Partial<StageOutputRecord> = {}): StageOutputRecord {
  return {
    digest: "abc",
    stage: "gen",
    createdAt: NOW,
    expiresAt: NOW + JOURNAL_TTL_MS,
    ttlMs: JOURNAL_TTL_MS,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    payload: { text: "章文" },
    ...over,
  }
}

beforeEach(() => {
  createDirectoryMock.mockReset()
  readFileMock.mockReset()
  writeFileAtomicMock.mockReset()
  createDirectoryMock.mockResolvedValue(undefined)
  readFileMock.mockResolvedValue("")
  writeFileAtomicMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── 路径 / 常量 ──

describe("路径与常量", () => {
  it("journalDirPath 收敛到 .novel/journal 且归一化反斜杠", () => {
    expect(JOURNAL_DIR_NAME).toBe("journal")
    expect(journalDirPath("C:\\proj")).toBe("C:/proj/.novel/journal")
    expect(journalDirPath("C:/proj")).toBe("C:/proj/.novel/journal")
  })

  it("journalFilePath 挂在 [digest].jsonl", () => {
    expect(journalFilePath("C:/proj", "d1")).toBe("C:/proj/.novel/journal/d1.jsonl")
  })

  it("parentDir 取最后一级分隔符之前的目录，兼容 / 与 \\", () => {
    expect(parentDir("a/b/c.jsonl")).toBe("a/b")
    expect(parentDir("a\\b\\c.jsonl")).toBe("a\\b")
    expect(parentDir("c.jsonl")).toBe(".")
  })
})

// ── digest ──

describe("computeInstructionDigest", () => {
  it("复用 T07：同语义（键序不同）指令产出同一幂等键", async () => {
    const a = await computeInstructionDigest({ cmd: "gen", ch: 1, n: 2 })
    const b = await computeInstructionDigest({ n: 2, cmd: "gen", ch: 1 })
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(b)
  })

  it("不同内容产出不同 digest", async () => {
    const a = await computeInstructionDigest({ x: 1 })
    const b = await computeInstructionDigest({ x: 2 })
    expect(a).not.toBe(b)
  })
})

// ── buildStageRecord / isExpired ──

describe("buildStageRecord / isExpired", () => {
  it("构造记录：expiresAt = createdAt + ttlMs，schema 版本置 1", () => {
    const r = buildStageRecord("d", "gen", { v: 1 }, NOW)
    expect(r).toMatchObject({
      digest: "d",
      stage: "gen",
      createdAt: NOW,
      schemaVersion: JOURNAL_SCHEMA_VERSION,
    })
    expect(r.expiresAt).toBe(NOW + JOURNAL_TTL_MS)
    expect(r.ttlMs).toBe(JOURNAL_TTL_MS)
  })

  it("可自定义 ttlMs", () => {
    const r = buildStageRecord("d", "gen", 1, NOW, 5000)
    expect(r.expiresAt).toBe(NOW + 5000)
    expect(r.ttlMs).toBe(5000)
  })

  it("isExpired：expiresAt <= now 为过期", () => {
    expect(isExpired(rec({ expiresAt: NOW + 1 }), NOW)).toBe(false)
    expect(isExpired(rec({ expiresAt: NOW }), NOW)).toBe(true)
    expect(isExpired(rec({ expiresAt: NOW - 1 }), NOW)).toBe(true)
  })
})

// ---- 解析容错 ---- 

describe("parseJournalLines", () => {
  it("空串 / 空白返回空数组", () => {
    expect(parseJournalLines("")).toEqual([])
    expect(parseJournalLines("   \n \n")).toEqual([])
  })

  it("解析多行，跳过空行与畸形行", () => {
    const raw = [
      serializeRecord(rec({ digest: "a", stage: "s1", payload: 1 })),
      "not-json{",
      "",
      serializeRecord(rec({ digest: "b", stage: "s2", payload: 2 })),
    ].join("\n")
    const out = parseJournalLines(raw)
    expect(out.length).toBe(2)
    expect(out[0]!.digest).toBe("a")
    expect(out[1]!.digest).toBe("b")
  })

  it("跳过缺基础字段（非对象 / 缺 digest / 非数字时间戳）", () => {
    const raw = [
      JSON.stringify({ stage: "s", createdAt: 1, expiresAt: 2 }), // 缺 digest
      JSON.stringify({ digest: "a", stage: "s", createdAt: "x", expiresAt: 2 }), // 时间戳非数字
      JSON.stringify("str"), // 非对象
      JSON.stringify(rec({ stage: "s", payload: 9 })), // 合法
    ].join("\n")
    const out = parseJournalLines(raw)
    expect(out.length).toBe(1)
    expect(out[0]!.payload).toBe(9)
  })
})

// ---- findLatestRecord ---- 

describe("findLatestRecord", () => {
  it("返回 digest+stage 匹配中 createdAt 最大的一条", () => {
    const older = rec({ digest: "a", stage: "s", createdAt: 100, expiresAt: 200 })
    const newer = rec({ digest: "a", stage: "s", createdAt: 300, expiresAt: 400 })
    const other = rec({ digest: "b", stage: "s", createdAt: 999, expiresAt: 1000 })
    const hit = findLatestRecord([older, other, newer], "a", "s")
    expect(hit).toBe(newer)
  })

  it("无匹配返回 null", () => {
    expect(findLatestRecord([rec()], "zz", "s")).toBeNull()
    expect(findLatestRecord([], "a", "s")).toBeNull()
  })

  it("前一条已是最新时跳过不覆盖（createdAt 非更新路径）", () => {
    const newer = rec({ digest: "a", stage: "s", createdAt: 300, expiresAt: 400 })
    const older = rec({ digest: "a", stage: "s", createdAt: 100, expiresAt: 200 })
    // 先处理 newer 再处理 older：older.createdAt(100) <= latest.createdAt(300) → 不覆盖
    expect(findLatestRecord([newer, older], "a", "s")).toBe(newer)
  })
})

// ---- serialize ---- 

describe("serializeRecord", () => {
  it("序列化单行为合法 JSON", () => {
    const line = serializeRecord(rec())
    expect(JSON.parse(line)).toMatchObject({
      digest: "abc",
      stage: "gen",
      schemaVersion: JOURNAL_SCHEMA_VERSION,
    })
  })
})

// ---- loadJournalEntry ---- 

describe("loadJournalEntry", () => {
  const projectId = "C:/proj"

  it("文件缺失/空 → 未命中返回 null", async () => {
    readFileMock.mockRejectedValue(new Error("enoent"))
    expect(await loadJournalEntry(mockDeps(), projectId, "abc", "gen", NOW)).toBeNull()
    // deps.read 吞掉失败返回空串（默认行为）
    expect(await loadJournalEntry(mockDeps({ read: async () => "" }), projectId, "abc", "gen", NOW)).toBeNull()
  })

  it("匹配但 TTL 过期 → 未命中返回 null（重新走 LLM）", async () => {
    const expired = rec({ digest: "abc", stage: "gen", expiresAt: NOW - 1 })
    const deps = mockDeps({ read: async () => serializeRecord(expired) + "\n" })
    expect(await loadJournalEntry(deps, projectId, "abc", "gen", NOW)).toBeNull()
  })

  it("命中且未过期 → 返回完整记录（跳 LLM）", async () => {
    const record = rec({ digest: "abc", stage: "gen", payload: { text: "章文" }, expiresAt: NOW + 1000 })
    const deps = mockDeps({ read: async () => serializeRecord(record) + "\n" })
    const r = await loadJournalEntry(deps, projectId, "abc", "gen", NOW)
    expect(r).not.toBeNull()
    expect(r!.digest).toBe("abc")
    expect(r!.payload).toEqual({ text: "章文" })
  })

  it("digest 或 stage 不匹配 → 未命中返回 null", async () => {
    const record = rec({ digest: "abc", stage: "gen", expiresAt: NOW + 1000 })
    const deps = mockDeps({ read: async () => serializeRecord(record) + "\n" })
    expect(await loadJournalEntry(deps, projectId, "abc", "OTHER", NOW)).toBeNull()
    expect(await loadJournalEntry(deps, projectId, "zzz", "gen", NOW)).toBeNull()
  })

  it("多行时取最新且未过期记录", async () => {
    const oldHit = rec({ digest: "abc", stage: "gen", createdAt: 100, expiresAt: NOW + 1000, payload: "old" })
    const newHit = rec({ digest: "abc", stage: "gen", createdAt: 200, expiresAt: NOW + 1000, payload: "new" })
    const deps = mockDeps({
      read: async () => `${serializeRecord(oldHit)}\n${serializeRecord(newHit)}\n`,
    })
    const r = await loadJournalEntry(deps, projectId, "abc", "gen", NOW)
    expect(r!.payload).toBe("new")
  })
})

// ---- saveJournalEntry ---- 

describe("saveJournalEntry", () => {
  const projectId = "C:/proj"

  it("写入新记录：末尾换行，返回行数", async () => {
    const record = rec()
    const deps = mockDeps({
      read: async () => "",
      writeFile: vi.fn(async () => {}),
    })
    const wrote: string[] = []
    const spyDeps = {
      ...deps,
      writeFile: async (_p: string, c: string) => {
        wrote.push(c)
      },
    }
    const n = await saveJournalEntry(spyDeps, projectId, record)
    expect(n).toBe(1)
    expect(wrote[0]).toBe(serializeRecord(record) + "\n")
    expect(writeFileAtomicMock).not.toHaveBeenCalled() // 走 mock deps 的 writeFile
  })

  it("同 digest+stage 的旧行被替换（其余行保留）", async () => {
    const old = rec({ digest: "abc", stage: "gen", createdAt: 1, payload: "old" })
    const other = rec({ digest: "abc", stage: "other", createdAt: 1, payload: "keep" })
    const deps = mockDeps({
      read: async () => `${serializeRecord(old)}\n${serializeRecord(other)}\n`,
      writeFile: vi.fn(async () => {}),
    })
    let written = ""
    const spy = { ...deps, writeFile: async (_p: string, c: string) => { written = c } }
    const fresh = rec({ digest: "abc", stage: "gen", createdAt: 2, payload: "new" })
    const n = await saveJournalEntry(spy, projectId, fresh)
    expect(n).toBe(2)
    const parsed = parseJournalLines(written)
    const genRecs = parsed.filter((r) => r.stage === "gen")
    expect(genRecs).toHaveLength(1)
    expect(genRecs[0]!.payload).toBe("new")
    expect(parsed.some((r) => r.stage === "other")).toBe(true)
  })

  it("不同 digest → 各自独立文件路径", () => {
    expect(journalFilePath("C:/proj", "a")).toContain("/a.jsonl")
    expect(journalFilePath("C:/proj", "b")).toContain("/b.jsonl")
  })
})

// ---- resolveStageOutput（崩溃后命中跳过 LLM） ---- 

describe("resolveStageOutput", () => {
  const projectId = "C:/proj"

  it("命中缓存则不调用 producer（跳过 LLM 重调用）", async () => {
    const record = rec({ digest: "abc", stage: "gen", payload: { done: true }, expiresAt: NOW + 1000 })
    const deps = mockDeps({
      read: async () => serializeRecord(record) + "\n",
      writeFile: vi.fn(async () => {}),
    })
    const producer = vi.fn(async () => ({ shouldNotRun: true }))
    const res = await resolveStageOutput(deps, projectId, "abc", "gen", producer as never, NOW)
    expect(res.hit).toBe(true)
    expect(producer).not.toHaveBeenCalled() // 未重调 LLM
  })

  it("未命中则调用 producer 并落盘，返回 hit=false", async () => {
    const deps = mockDeps({
      read: async () => "",
      writeFile: vi.fn(async () => {}),
    })
    const producer = vi.fn(async () => ({ fresh: 1 }))
    const res = await resolveStageOutput(deps, projectId, "abc", "gen", producer, NOW)
    expect(res.hit).toBe(false)
    expect(producer).toHaveBeenCalledTimes(1)
    expect(res.record!.payload).toEqual({ fresh: 1 })
  })

  it("未命中但命运：TTL 过期后同一 digest 再次 resolve → 命中（弹崩溃后跳过 LLM）", async () => {
    const expired = rec({ digest: "abc", stage: "gen", expiresAt: NOW - 1, payload: "stale" })
    const deps = mockDeps({
      read: async () => serializeRecord(expired) + "\n",
      writeFile: vi.fn(async () => {}),
    })
    const count = { n: 0 }
    const res = await resolveStageOutput(deps, projectId, "abc", "gen", async () => ({ n: ++count.n }), NOW)
    expect(res.hit).toBe(false) // 旧记录已过期 → 重生产
    expect(res.record!.payload).toEqual({ n: 1 })
  })
})

describe("defaultStageJournalDeps", () => {
  it("read 失败返回空串", async () => {
    readFileMock.mockRejectedValue(new Error("boom"))
    const deps = defaultStageJournalDeps()
    expect(await deps.read("x")).toBe("")
    expect(await deps.read("y")).toBe("")
  })

  it("read 返回真实内容", async () => {
    readFileMock.mockResolvedValue("line")
    expect(await defaultStageJournalDeps().read("x")).toBe("line")
  })

  it("writeFile 建目录后原子写", async () => {
    const deps = defaultStageJournalDeps()
    await deps.writeFile("C:/proj/.novel/journal/a.jsonl", "{}")
    expect(createDirectoryMock).toHaveBeenCalledWith("C:/proj/.novel/journal")
    expect(writeFileAtomicMock).toHaveBeenCalledWith("C:/proj/.novel/journal/a.jsonl", "{}")
  })

  it("createDirectory 透传", async () => {
    await defaultStageJournalDeps().createDirectory("d")
    expect(createDirectoryMock).toHaveBeenCalledWith("d")
  })
})