// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(async (_path: string): Promise<void> => undefined),
  writeFileAtomic: vi.fn(async (_path: string, _contents: string): Promise<void> => undefined),
  readFile: vi.fn(async (_path: string): Promise<string> => ""),
  fileExists: vi.fn(async (_path: string): Promise<boolean> => false),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, ...fsMocks }
})

const { CONFIRMED_PLAN_DIR, confirmedPlanPath, loadConfirmedPlan, saveConfirmedPlan } = await import(
  "./confirmed-plan-store"
)

/** 最小内存盘：fileExists/readFile 共享同一份内容，模拟真实读写往返。 */
function useInMemoryDisk(initial: Record<string, string> = {}): Map<string, string> {
  const disk = new Map<string, string>(Object.entries(initial))
  fsMocks.fileExists.mockImplementation(async (path: string) => disk.has(path))
  fsMocks.readFile.mockImplementation(async (path: string) => {
    const found = disk.get(path)
    if (found === undefined) throw new Error(`ENOENT: no such file '${path}'`)
    return found
  })
  fsMocks.writeFileAtomic.mockImplementation(async (path: string, contents: string) => {
    disk.set(path, contents)
  })
  return disk
}

beforeEach(() => {
  fsMocks.createDirectory.mockClear()
  fsMocks.writeFileAtomic.mockClear()
  fsMocks.readFile.mockClear()
  fsMocks.fileExists.mockClear()
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  fsMocks.readFile.mockReset()
  fsMocks.fileExists.mockReset()
  fsMocks.readFile.mockResolvedValue("")
  fsMocks.fileExists.mockResolvedValue(false)
})

describe("confirmedPlanPath", () => {
  it("落在 .novel/plans/chapter-<N>.md，并把反斜杠项目路径归一化", () => {
    expect(confirmedPlanPath("E:\\Novel\\book1\\", 7)).toBe(
      `E:/Novel/book1/${CONFIRMED_PLAN_DIR}/chapter-7.md`,
    )
    expect(CONFIRMED_PLAN_DIR).toBe(".novel/plans")
  })
})

describe("saveConfirmedPlan", () => {
  it("正常写：建目录 + 原子写（临时文件 + rename 由后端 writeFileAtomic 保证）", async () => {
    await saveConfirmedPlan("E:/Novel", 3, "# 第3章计划\n\n- 开场：雨夜")

    expect(fsMocks.createDirectory).toHaveBeenCalledWith(`E:/Novel/${CONFIRMED_PLAN_DIR}`)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      `E:/Novel/${CONFIRMED_PLAN_DIR}/chapter-3.md`,
      "# 第3章计划\n\n- 开场：雨夜",
    )
  })

  it("空 plan / 纯空白 plan 一律不写盘（也不建目录）", async () => {
    await saveConfirmedPlan("E:/Novel", 3, "")
    await saveConfirmedPlan("E:/Novel", 3, "   \n\t  ")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsMocks.createDirectory).not.toHaveBeenCalled()
  })

  it("非法 chapterNumber（0 / 负数 / 小数 / NaN / Infinity）一律不写盘", async () => {
    for (const bad of [0, -1, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await saveConfirmedPlan("E:/Novel", bad, "# 计划")
    }
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsMocks.createDirectory).not.toHaveBeenCalled()
  })

  it("写盘失败向上抛（降级责任收在调用点，不在此处静默吞掉）", async () => {
    fsMocks.writeFileAtomic.mockRejectedValueOnce(new Error("磁盘只读"))
    await expect(saveConfirmedPlan("E:/Novel", 3, "# 计划")).rejects.toThrow("磁盘只读")
  })
})

describe("loadConfirmedPlan", () => {
  it("正常读写往返：写进去什么读回来什么", async () => {
    useInMemoryDisk()
    await saveConfirmedPlan("E:/Novel", 5, "# 第5章计划\n\n1. 起\n2. 承")
    await expect(loadConfirmedPlan("E:/Novel", 5)).resolves.toBe("# 第5章计划\n\n1. 起\n2. 承")
  })

  it("文件不存在返回 undefined（且不记 warn：未生成过不是错误）", async () => {
    useInMemoryDisk()
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(loadConfirmedPlan("E:/Novel", 9)).resolves.toBeUndefined()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("读取失败返回 undefined（不抛），并记 warn 留痕", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockRejectedValue(new Error("EACCES: permission denied"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(loadConfirmedPlan("E:/Novel", 2)).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("fileExists 自身失败也降级为 undefined（不抛）", async () => {
    fsMocks.fileExists.mockRejectedValue(new Error("file_exists 不可用"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(loadConfirmedPlan("E:/Novel", 2)).resolves.toBeUndefined()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("空白内容按「无计划」降级（不返回空串充当计划）", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue("  \n\t ")
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(loadConfirmedPlan("E:/Novel", 2)).resolves.toBeUndefined()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("非法 chapterNumber 不读盘，直接 undefined", async () => {
    await expect(loadConfirmedPlan("E:/Novel", 0)).resolves.toBeUndefined()
    await expect(loadConfirmedPlan("E:/Novel", -2)).resolves.toBeUndefined()
    await expect(loadConfirmedPlan("E:/Novel", 2.5)).resolves.toBeUndefined()
    expect(fsMocks.fileExists).not.toHaveBeenCalled()
    expect(fsMocks.readFile).not.toHaveBeenCalled()
  })
})

describe("往返保真与覆盖写", () => {
  it("中文 / emoji / 全角标点 / CRLF 往返不损坏", async () => {
    const plan = "# 第 12 章 · 破晓🌅\r\n\r\n- 主角：陈默（“沉默”的默）\r\n- 伏笔：那枚铜钱🪙\r\n"
    useInMemoryDisk()
    await saveConfirmedPlan("E:/Novel", 12, plan)
    const back = await loadConfirmedPlan("E:/Novel", 12)
    expect(back).toBe(plan)
    expect(back).toContain("破晓🌅")
    expect(back).toContain("陈默（“沉默”的默）")
    expect(back).toContain("🪙")
  })

  it("同章二次写生效（覆盖旧计划，不追加、不残留）", async () => {
    const disk = useInMemoryDisk()
    await saveConfirmedPlan("E:/Novel", 4, "旧计划：主角留在城里")
    await saveConfirmedPlan("E:/Novel", 4, "新计划：主角连夜出城")
    const path = `E:/Novel/${CONFIRMED_PLAN_DIR}/chapter-4.md`
    expect(disk.get(path)).toBe("新计划：主角连夜出城")
    expect(disk.size).toBe(1)
    await expect(loadConfirmedPlan("E:/Novel", 4)).resolves.toBe("新计划：主角连夜出城")
  })

  it("不同章节互不覆盖", async () => {
    const disk = useInMemoryDisk()
    await saveConfirmedPlan("E:/Novel", 1, "第一章计划")
    await saveConfirmedPlan("E:/Novel", 2, "第二章计划")
    expect(disk.size).toBe(2)
    await expect(loadConfirmedPlan("E:/Novel", 1)).resolves.toBe("第一章计划")
    await expect(loadConfirmedPlan("E:/Novel", 2)).resolves.toBe("第二章计划")
  })
})
