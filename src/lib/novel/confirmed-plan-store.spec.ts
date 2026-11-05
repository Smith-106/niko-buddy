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

const {
  CONFIRMED_PLAN_DIR,
  confirmedPlanPath,
  loadConfirmedPlan,
  loadConfirmedPlanRecord,
  saveConfirmedPlan,
} = await import("./confirmed-plan-store")

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

/** 把落盘文本拆成「头部字段 + 正文」，用于断言序列化格式与正文逐字节保真。 */
function splitFrontmatter(raw: string): { header: string[]; body: string } {
  const lines = raw.split("\n")
  expect(lines[0]).toBe("---")
  const close = lines.indexOf("---", 1)
  expect(close).toBeGreaterThan(0)
  return { header: lines.slice(1, close), body: raw.slice(lines.slice(0, close + 1).join("\n").length + 1) }
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
  it("正常写：建目录 + 原子写，内容是 source/savedAt 头部 + 原文", async () => {
    await saveConfirmedPlan("E:/Novel", 3, "# 第3章计划\n\n- 开场：雨夜")

    expect(fsMocks.createDirectory).toHaveBeenCalledWith(`E:/Novel/${CONFIRMED_PLAN_DIR}`)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const [path, contents] = fsMocks.writeFileAtomic.mock.calls[0] as [string, string]
    expect(path).toBe(`E:/Novel/${CONFIRMED_PLAN_DIR}/chapter-3.md`)
    const { header, body } = splitFrontmatter(contents)
    // RVF-01：缺省来源必须是 "model"——本模块没有用户确认路径，不得自称已确认。
    expect(header).toContain("source: model")
    const savedAtLine = header.find((line) => line.startsWith("savedAt: "))
    expect(savedAtLine).toBeDefined()
    const savedAt = savedAtLine!.slice("savedAt: ".length)
    expect(Number.isNaN(new Date(savedAt).getTime())).toBe(false)
    expect(savedAt).toBe(new Date(savedAt).toISOString())
    expect(body).toBe("# 第3章计划\n\n- 开场：雨夜")
  })

  it("显式 source 原样落盘（user 只在真有确认 UI 时才会出现）", async () => {
    await saveConfirmedPlan("E:/Novel", 3, "# 计划", "user")
    const [, contents] = fsMocks.writeFileAtomic.mock.calls[0] as [string, string]
    expect(splitFrontmatter(contents).header).toContain("source: user")
  })

  it("未知/非法 source 一律降级为 model（绝不把模型自拟升格成用户确认）", async () => {
    await saveConfirmedPlan("E:/Novel", 3, "# 计划", "USER" as never)
    const [, contents] = fsMocks.writeFileAtomic.mock.calls[0] as [string, string]
    expect(splitFrontmatter(contents).header).toContain("source: model")
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

describe("loadConfirmedPlanRecord", () => {
  it("正常读写往返：原文逐字符一致，且带上 source 与 savedAt", async () => {
    useInMemoryDisk()
    await saveConfirmedPlan("E:/Novel", 5, "# 第5章计划\n\n1. 起\n2. 承")
    const record = await loadConfirmedPlanRecord("E:/Novel", 5)
    expect(record?.plan).toBe("# 第5章计划\n\n1. 起\n2. 承")
    expect(record?.source).toBe("model")
    expect(Number.isNaN(new Date(record!.savedAt).getTime())).toBe(false)
  })

  it("向后兼容：旧的无头部文件读成 source=model、savedAt 空（不伪造时间）", async () => {
    useInMemoryDisk({
      [`E:/Novel/${CONFIRMED_PLAN_DIR}/chapter-2.md`]: "# 旧计划\n\n- 场景一\n- 场景二\n",
    })
    const record = await loadConfirmedPlanRecord("E:/Novel", 2)
    expect(record).toEqual({
      plan: "# 旧计划\n\n- 场景一\n- 场景二\n",
      source: "model",
      savedAt: "",
    })
  })

  it("向后兼容：旧文件正文以 Markdown 水平线 --- 开头也整份保留（不误切头部）", async () => {
    const legacy = "---\n\n# 旧计划\n\n- 场景一\n"
    useInMemoryDisk({ [`E:/Novel/${CONFIRMED_PLAN_DIR}/chapter-8.md`]: legacy })
    const record = await loadConfirmedPlanRecord("E:/Novel", 8)
    expect(record?.plan).toBe(legacy)
    expect(record?.source).toBe("model")
    expect(record?.savedAt).toBe("")
  })

  it("头部里出现未知 key 视为旧格式（整份当计划，不吃掉正文）", async () => {
    const legacy = "---\ntitle: 第9章\n---\n正文\n"
    useInMemoryDisk({ [`E:/Novel/${CONFIRMED_PLAN_DIR}/chapter-9.md`]: legacy })
    const record = await loadConfirmedPlanRecord("E:/Novel", 9)
    expect(record?.plan).toBe(legacy)
    expect(record?.savedAt).toBe("")
  })

  it("首行与次行都是水平线（旧文件零字段头）也整份保留（不删任何正文）", async () => {
    const legacy = "---\n---\n正文第一行\n正文第二行\n"
    useInMemoryDisk({ [`E:/Novel/${CONFIRMED_PLAN_DIR}/chapter-10.md`]: legacy })
    const record = await loadConfirmedPlanRecord("E:/Novel", 10)
    expect(record?.plan).toBe(legacy)
    expect(record?.source).toBe("model")
    expect(record?.savedAt).toBe("")
  })

  it("头部超过扫描上限（>5 行仍未见到闭合分隔线）判为旧格式，整份保留正文", async () => {
    // 防误切的第二道闸：真实头部固定 2 行，放宽到 5 行；超出即不再当头部切。
    // 宁可把带头的文件整份当计划（保守），也不吃掉用户正文。
    const overflow =
      "---\nsource: model\nsavedAt: t1\nsource: model\nsavedAt: t2\nsource: model\n正文第一行\n正文第二行\n"
    useInMemoryDisk({ [`E:/Novel/${CONFIRMED_PLAN_DIR}/chapter-11.md`]: overflow })
    const record = await loadConfirmedPlanRecord("E:/Novel", 11)
    expect(record?.plan).toBe(overflow)
    expect(record?.source).toBe("model")
    expect(record?.savedAt).toBe("")
    // 保守降级的可观察结果：正文行仍在计划里（没有被当成头部吃掉）
    expect(record?.plan).toContain("正文第一行\n正文第二行")
  })

  it("文件只有一行水平线 ---（无换行）当旧格式整份保留", async () => {
    // 首行是分隔线但整份内容没有换行：头部无从解析，按旧格式处理（plan 就是原文本）。
    useInMemoryDisk({ [`E:/Novel/${CONFIRMED_PLAN_DIR}/chapter-13.md`]: "---" })
    const record = await loadConfirmedPlanRecord("E:/Novel", 13)
    expect(record).toEqual({ plan: "---", source: "model", savedAt: "" })
  })

  it("头部缺换行（最后一行无行尾换行且无闭合分隔线）当旧格式，正文不被吃掉", async () => {
    const truncated = "---\nsource: user"
    useInMemoryDisk({ [`E:/Novel/${CONFIRMED_PLAN_DIR}/chapter-14.md`]: truncated })
    const record = await loadConfirmedPlanRecord("E:/Novel", 14)
    expect(record?.plan).toBe(truncated)
    // 未闭合的头部不算头部：不得把半截头部读成「用户已确认」（单向降级）。
    expect(record?.source).toBe("model")
    expect(record?.savedAt).toBe("")
  })

  it("CRLF 头部（Windows 落盘）同样能认出头部，正文的 CRLF 逐字节保留", async () => {
    const crlf = "---\r\nsource: user\r\nsavedAt: 2026-01-01T00:00:00.000Z\r\n---\r\n正文第一行\r\n"
    useInMemoryDisk({ [`E:/Novel/${CONFIRMED_PLAN_DIR}/chapter-15.md`]: crlf })
    const record = await loadConfirmedPlanRecord("E:/Novel", 15)
    expect(record?.source).toBe("user")
    expect(record?.savedAt).toBe("2026-01-01T00:00:00.000Z")
    // 只剥掉头部行自身的 \r；正文行尾的 CRLF 属于原文，不得被改写。
    expect(record?.plan).toBe("正文第一行\r\n")
  })

  it("头部只有 source 没有 savedAt 时 savedAt 留空（不伪造时间）", async () => {
    useInMemoryDisk({
      [`E:/Novel/${CONFIRMED_PLAN_DIR}/chapter-16.md`]: "---\nsource: user\n---\n正文\n",
    })
    const record = await loadConfirmedPlanRecord("E:/Novel", 16)
    expect(record?.source).toBe("user")
    expect(record?.savedAt).toBe("")
    expect(record?.plan).toBe("正文\n")
  })

  it("头部 source 值不认识时降级为 model（单向降级，不升格）", async () => {
    useInMemoryDisk({
      [`E:/Novel/${CONFIRMED_PLAN_DIR}/chapter-4.md`]: "---\nsource: trusted\nsavedAt: 2026-01-01T00:00:00.000Z\n---\n正文\n",
    })
    const record = await loadConfirmedPlanRecord("E:/Novel", 4)
    expect(record?.source).toBe("model")
    expect(record?.plan).toBe("正文\n")
  })

  it("文件不存在返回 undefined（且不记 warn：未生成过不是错误）", async () => {
    useInMemoryDisk()
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(loadConfirmedPlanRecord("E:/Novel", 9)).resolves.toBeUndefined()
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
      await expect(loadConfirmedPlanRecord("E:/Novel", 2)).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("fileExists 自身失败也降级为 undefined（不抛）", async () => {
    fsMocks.fileExists.mockRejectedValue(new Error("file_exists 不可用"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(loadConfirmedPlanRecord("E:/Novel", 2)).resolves.toBeUndefined()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("正文为空白按「无计划」降级（不返回空串充当计划）", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue("---\nsource: model\nsavedAt: 2026-01-01T00:00:00.000Z\n---\n  \n\t ")
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(loadConfirmedPlanRecord("E:/Novel", 2)).resolves.toBeUndefined()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("非法 chapterNumber 不读盘，直接 undefined", async () => {
    await expect(loadConfirmedPlanRecord("E:/Novel", 0)).resolves.toBeUndefined()
    await expect(loadConfirmedPlanRecord("E:/Novel", -2)).resolves.toBeUndefined()
    await expect(loadConfirmedPlanRecord("E:/Novel", 2.5)).resolves.toBeUndefined()
    expect(fsMocks.fileExists).not.toHaveBeenCalled()
    expect(fsMocks.readFile).not.toHaveBeenCalled()
  })
})

describe("loadConfirmedPlan（兼容入口：只要文本）", () => {
  it("正常读写往返：写进去什么读回来什么", async () => {
    useInMemoryDisk()
    await saveConfirmedPlan("E:/Novel", 5, "# 第5章计划\n\n1. 起\n2. 承")
    await expect(loadConfirmedPlan("E:/Novel", 5)).resolves.toBe("# 第5章计划\n\n1. 起\n2. 承")
  })

  it("旧文件同样能读（正文不含新加的头部）", async () => {
    useInMemoryDisk({ [`E:/Novel/${CONFIRMED_PLAN_DIR}/chapter-6.md`]: "旧计划原文" })
    await expect(loadConfirmedPlan("E:/Novel", 6)).resolves.toBe("旧计划原文")
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
    expect(splitFrontmatter(disk.get(path)!).body).toBe("新计划：主角连夜出城")
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
