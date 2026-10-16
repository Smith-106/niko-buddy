import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  chooseTechniqueIndex,
  createPreferenceStore,
  preferenceStore,
  preferenceStorePath,
  recordFeedback,
  scorePreference,
  type PreferenceMap,
} from "./technique-preference"

// vi.hoisted: 内存文件系统 mock, 控制 load 读 + save 写
// (走 @/commands/fs readFile/writeFileAtomic/createDirectory, 同 aura-evolution.spec)。
const fsMocks = vi.hoisted(() => {
  const files = new Map<string, string>()
  return {
    files,
    readFile: vi.fn(async (p: string) => {
      const k = String(p).replace(/\\/g, "/")
      if (!files.has(k)) throw new Error(`ENOENT: ${p}`)
      return files.get(k) as string
    }),
    writeFileAtomic: vi.fn(async (p: string, c: string) => {
      files.set(String(p).replace(/\\/g, "/"), c)
    }),
    createDirectory: vi.fn(async () => {}),
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fsMocks.readFile,
    writeFileAtomic: fsMocks.writeFileAtomic,
    createDirectory: fsMocks.createDirectory,
  }
})

const readFileMock = fsMocks.readFile
const writeFileAtomicMock = fsMocks.writeFileAtomic
const createDirectoryMock = fsMocks.createDirectory

beforeEach(() => {
  fsMocks.files.clear()
  readFileMock.mockClear()
  writeFileAtomicMock.mockClear()
  createDirectoryMock.mockClear()
})

describe("T3 技法偏好回灌最小版", () => {
  it("recordFeedback 空 map 采纳 → {accept:1, reject:0}", () => {
    expect(recordFeedback({}, "t1", true)).toEqual({ t1: { accept: 1, reject: 0 } })
  })

  it("recordFeedback 空 map 拒绝 → {accept:0, reject:1}", () => {
    expect(recordFeedback({}, "t1", false)).toEqual({ t1: { accept: 0, reject: 1 } })
  })

  it("recordFeedback 累加已有条目 (accept+1 / reject 保持)", () => {
    const map: PreferenceMap = { t1: { accept: 2, reject: 1 } }
    expect(recordFeedback(map, "t1", true)).toEqual({ t1: { accept: 3, reject: 1 } })
    expect(recordFeedback(map, "t1", false)).toEqual({ t1: { accept: 2, reject: 2 } })
  })

  it("recordFeedback 不可变更新 (入参 map 不被修改)", () => {
    const map: PreferenceMap = { t1: { accept: 1, reject: 0 } }
    const next = recordFeedback(map, "t1", true)
    expect(map).toEqual({ t1: { accept: 1, reject: 0 } })
    expect(next).not.toBe(map)
    expect(next["t1"]).not.toBe(map["t1"])
  })

  it("scorePreference 返回 accept-reject", () => {
    expect(scorePreference({ accept: 5, reject: 2 })).toBe(3)
    expect(scorePreference({ accept: 0, reject: 4 })).toBe(-4)
  })

  it("scorePreference 缺省 (undefined) → 0", () => {
    expect(scorePreference(undefined)).toBe(0)
  })

  it("chooseTechniqueIndex 分数最高者胜出", () => {
    const prefs = [
      { id: "a", score: 1 },
      { id: "b", score: 5 },
      { id: "c", score: 3 },
    ]
    expect(chooseTechniqueIndex(3, 0, prefs)).toBe(1)
  })

  it("chooseTechniqueIndex 并列最高取首个", () => {
    const prefs = [
      { id: "a", score: 4 },
      { id: "b", score: 4 },
    ]
    expect(chooseTechniqueIndex(2, 1, prefs)).toBe(0)
  })

  it("chooseTechniqueIndex 空 prefs 回退 cursor%poolSize", () => {
    expect(chooseTechniqueIndex(4, 6, [])).toBe(2)
  })

  it("chooseTechniqueIndex 全零/全负分回退 cursor%poolSize", () => {
    expect(chooseTechniqueIndex(3, 1, [{ id: "a", score: 0 }])).toBe(1)
    expect(chooseTechniqueIndex(3, 5, [{ id: "a", score: -2 }])).toBe(2)
  })

  it("chooseTechniqueIndex poolSize<=0 → 0 (不抛)", () => {
    expect(chooseTechniqueIndex(0, 3, [{ id: "a", score: 9 }])).toBe(0)
  })

  it("load 读失败 (文件缺失) 回 {} 不抛", async () => {
    const store = createPreferenceStore()
    await expect(store.load("/no-such-proj")).resolves.toEqual({})
  })

  it("load 损坏 JSON / 非法形状回 {} 不抛", async () => {
    fsMocks.files.set("/p/.novel/technique-preference.json", "{bad json")
    await expect(preferenceStore.load("/p")).resolves.toEqual({})
    fsMocks.files.set("/p/.novel/technique-preference.json", JSON.stringify([1, 2, 3]))
    await expect(preferenceStore.load("/p")).resolves.toEqual({})
  })

  it("save/load round-trip (原子写 + 路径约定)", async () => {
    const map: PreferenceMap = { t1: { accept: 2, reject: 1 } }
    await preferenceStore.save("/p", map)
    expect(createDirectoryMock).toHaveBeenCalledWith("/p/.novel")
    expect(writeFileAtomicMock).toHaveBeenCalledWith(
      "/p/.novel/technique-preference.json",
      expect.any(String),
    )
    await expect(preferenceStore.load("/p")).resolves.toEqual(map)
  })

  it("preferenceStorePath 遵循 `${pp}/.novel/technique-preference.json`", () => {
    expect(preferenceStorePath("/p")).toBe("/p/.novel/technique-preference.json")
  })
})
