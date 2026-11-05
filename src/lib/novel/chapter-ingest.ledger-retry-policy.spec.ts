/**
 * chapter-ingest.ts 账本落盘「重试策略」守卫（saveProjectionLedgerWithSingleRetry）。
 *
 * 分母说明：`LEDGER_SAVE_MAX_RETRIES` 恒为 1，所以真实策略下 shouldRetryLedgerSave(0)
 * 恒为 true —— 「策略拒绝重试 → 不再二次落盘，直接报 false」这条守卫在当前常量下
 * 不可达。它存在的意义是：策略一旦下调为 0 次重试，函数必须只试一次并如实返回
 * false，而不是继续按旧假设写第二遍（那会变成不受常量约束的隐式重试）。
 *
 * 本 spec 用一次性策略桩把 shouldRetryLedgerSave 固定为 false 来验证该契约。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  writeFilesAtomic: vi.fn(),
  listDirectory: vi.fn(),
  fileExists: vi.fn(),
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: (...args: unknown[]) => fsMocks.readFile(...args),
    writeFileAtomic: (...args: unknown[]) => fsMocks.writeFileAtomic(...args),
    writeFilesAtomic: (...args: unknown[]) => fsMocks.writeFilesAtomic(...args),
    listDirectory: (...args: unknown[]) => fsMocks.listDirectory(...args),
    fileExists: (...args: unknown[]) => fsMocks.fileExists(...args),
    createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
    deleteFile: (...args: unknown[]) => fsMocks.deleteFile(...args),
  }
})

vi.mock("./projection-status-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./projection-status-ledger")>()
  return {
    ...actual,
    // 策略桩：0 次重试预算（生产常量当前是 1，见文件头注释）。
    shouldRetryLedgerSave: () => false,
  }
})

import { saveProjectionLedgerWithSingleRetry } from "./chapter-ingest"
import { emptyLedger } from "./projection-status-ledger"

const PROJECT = "E:/Novel"
const LEDGER_PATH = `${PROJECT}/.novel/projection-status.json`

beforeEach(() => {
  vi.clearAllMocks()
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.readFile.mockRejectedValue(new Error("ENOENT: no such file or directory"))
})

describe("saveProjectionLedgerWithSingleRetry — 策略禁止重试时", () => {
  it("首次落盘失败后不再重试：恰写 1 次并返回 false", async () => {
    fsMocks.writeFileAtomic.mockRejectedValue(new Error("No space left on device"))

    const ok = await saveProjectionLedgerWithSingleRetry(PROJECT, emptyLedger())

    expect(ok).toBe(false)
    // 策略说没有重试预算 → 只有首次那 1 次写盘尝试。
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(fsMocks.writeFileAtomic.mock.calls[0]![0]).toBe(LEDGER_PATH)
  })

  it("首次落盘成功时照常返回 true（策略只影响失败后的重试）", async () => {
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const ok = await saveProjectionLedgerWithSingleRetry(PROJECT, emptyLedger())

    expect(ok).toBe(true)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fsMocks.writeFileAtomic.mock.calls[0]![1])).schemaVersion).toBe("2")
  })
})
