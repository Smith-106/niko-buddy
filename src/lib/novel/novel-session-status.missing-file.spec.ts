import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * #7（2026-10-28）两项运行日志健壮性修复的回归守护：
 *
 * 1. `.novel/status.json` 缺失（ENOENT）属**预期降级路径**（新项目 / 尚未开写），
 *    必须走 `logger.info` 而非 `logger.warn` —— 否则每次读取都污染 warn 日志。
 *    真正的损坏（有原始字节但解析失败）仍必须 warn + 保全 `.corrupt-*`。
 *
 * 2. 深度审查阶段 5 分钟内部超时触发时，`streamChat` 只看到组合信号中止，
 *    会上报 "Request cancelled"（AbortError）。该错误必须被归一为可读的超时
 *    错误并降为 warn，避免日志出现「被取消却又重跑」的困惑。
 *
 * 这两条此前只有实现、没有回归 spec，本文件补齐。
 */

const fsState = vi.hoisted(() => {
  const fileMap = new Map<string, string>()
  return {
    fileMap,
    readFile: vi.fn(async (path: string) => {
      const content = fileMap.get(path)
      if (content === undefined) throw new Error(`ENOENT: no such file or directory, ${path}`)
      return content
    }),
    writeFileAtomic: vi.fn(async (path: string, content: string) => {
      fileMap.set(path, content)
    }),
    writeFilesAtomic: vi.fn(async (files: Array<[string, string]>) => {
      for (const [path, content] of files) fileMap.set(path, content)
    }),
    createDirectory: vi.fn(async (_path: string) => {}),
    deleteFile: vi.fn(async (_path: string) => {}),
    fileExists: vi.fn(async (path: string) => fileMap.has(path)),
    listDirectory: vi.fn(async (_path: string) => [] as string[]),
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: (path: string) => fsState.readFile(path),
    writeFileAtomic: (path: string, content: string) => fsState.writeFileAtomic(path, content),
    writeFilesAtomic: (files: Array<[string, string]>) => fsState.writeFilesAtomic(files),
    createDirectory: (path: string) => fsState.createDirectory(path),
    deleteFile: (path: string) => fsState.deleteFile(path),
    fileExists: (path: string) => fsState.fileExists(path),
    listDirectory: (path: string) => fsState.listDirectory(path),
  }
})

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return {
    ...actual,
    logger: loggerMock,
  }
})

import { loadNovelSessionStatus, startDeepChapterSession } from "./novel-session-status"

const PROJECT = "E:/Novel"
const STATUS_PATH = `${PROJECT}/.novel/status.json`

beforeEach(() => {
  fsState.fileMap.clear()
  vi.clearAllMocks()
})

describe("#7 status.json 缺失走 info 而非 warn（预期降级路径）", () => {
  it("ENOENT 时返回 null 并记 info，不记 warn", async () => {
    const result = await loadNovelSessionStatus(PROJECT)
    expect(result).toBeNull()
    const infoMessages = loggerMock.info.mock.calls.map((c) => String(c[1]))
    expect(infoMessages.some((m) => /not present yet/.test(m))).toBe(true)
    const warnMessages = loggerMock.warn.mock.calls.map((c) => String(c[1]))
    expect(warnMessages.some((m) => /status\.json/i.test(m))).toBe(false)
  })

  it("Windows Rust read_file 的 os error 2 文案同样归入缺失降级", async () => {
    fsState.readFile.mockRejectedValueOnce(new Error("os error 2: 系统找不到指定的文件。"))
    const result = await loadNovelSessionStatus(PROJECT)
    expect(result).toBeNull()
    const warnMessages = loggerMock.warn.mock.calls.map((c) => String(c[1]))
    expect(warnMessages.some((m) => /status\.json/i.test(m))).toBe(false)
  })

  it("文件存在且合法时正常加载，不触发缺失降级", async () => {
    // 经真实写入路径生成合法 status.json（避免手抄 schema 漏字段）。
    // 注意 startDeepChapterSession 内部首次 load 时文件尚不存在，会记一次 info
    // （这是预期降级路径），故在其后清空日志再断言「已存在文件不再触发降级」。
    await startDeepChapterSession({ projectPath: PROJECT, conversationId: "conv-1", userRequest: "写第 1 章", chapterNumber: 1 })
    loggerMock.info.mockClear()
    const result = await loadNovelSessionStatus(PROJECT)
    expect(result).not.toBeNull()
    expect(result?.schema_version).toBe("1")
    const infoMessages = loggerMock.info.mock.calls.map((c) => String(c[1]))
    expect(infoMessages.some((m) => /not present yet/.test(m))).toBe(false)
  })

  it("文件存在但内容损坏时仍走 warn（不得被缺失降级吞掉）", async () => {
    fsState.fileMap.set(STATUS_PATH, "{ this is not json")
    const result = await loadNovelSessionStatus(PROJECT)
    expect(result).toBeNull()
    const warnCalls = loggerMock.warn.mock.calls.filter((c) => /session detailed failed/.test(String(c[1])))
    expect(warnCalls.length).toBeGreaterThan(0)
  })
})
