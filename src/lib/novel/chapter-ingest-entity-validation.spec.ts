import { describe, expect, it, vi } from "vitest"

// loadEntityLinkIndex 的外层 catch（ISS-20260709-025 PAT-IM2）：实体文件枚举失败时
// 必须降级为空索引 + 记诊断，控制流不变。注意 readFile 的失败在更内层逐项吞掉
// （L29-32），所以要命中外层 catch 必须让 listEntityFiles 本身 reject。
const listEntityFilesStub = vi.hoisted(() => vi.fn())
const warnStub = vi.hoisted(() => vi.fn())

vi.mock("./entity-subdir-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./entity-subdir-resolver")>()
  return { ...actual, listEntityFiles: listEntityFilesStub }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: vi.fn(), fileExists: vi.fn() }
})

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return { ...actual, logger: { ...actual.logger, warn: warnStub } }
})

import { loadEntityLinkIndex, validateCanonConflicts } from "./chapter-ingest-entity-validation"

describe("loadEntityLinkIndex 非致命降级", () => {
  it("实体文件枚举失败时降级为空索引并记 warn，不向上抛", async () => {
    warnStub.mockClear()
    listEntityFilesStub.mockRejectedValueOnce(new Error("enumerate boom"))

    const index = await loadEntityLinkIndex("proj-1")

    // 降级产物仍可用（空索引），调用方无需判空
    expect(index).toBeDefined()
    expect(warnStub).toHaveBeenCalledWith(
      "Chapter Ingest",
      "load entity link index failed, degrade to empty (non-fatal)",
      expect.objectContaining({ error: "enumerate boom" }),
    )
  })
})

describe("validateCanonConflicts 外层降级", () => {
  it("快照 events 非可迭代 → 外层 catch 记 warn、返回已有告警，不向上抛", async () => {
    warnStub.mockClear()
    const warnings = await validateCanonConflicts("/proj", { events: undefined } as never)
    expect(warnings).toEqual([])
    expect(warnStub).toHaveBeenCalled()
  })
})
