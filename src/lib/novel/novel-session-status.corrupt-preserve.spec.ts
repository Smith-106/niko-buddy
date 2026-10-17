import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * CORR-A (corrupt-preserve): loadNovelSessionStatus 损坏回读保全回归。
 *
 * 问题（已核实）: 回读失败分支原为 `catch { return null }`，
 * startDeepChapterSession 拿到 null 后重建 base status 覆盖原文件 —— 损坏
 * status.json 被静默覆盖、无保全。对照正确模式: projection-status-ledger.ts
 * 的 preserveCorruptLedger（先把原始字节保全到 `.corrupt-<时间戳>` 兄弟文件，
 * 再降级返回，绝不静默丢数据）。
 *
 * 本 spec 锁定:
 * 1. 非法 JSON → load 返回 null，原始字节原样保全到同目录
 *    `status.corrupt-<时间戳>.json` 兄弟文件，且原 status.json 字节未被改动
 *    （fail-loud：console.error 诊断，不静默）。
 * 2. 合法 JSON 但 schema/枚举校验失败 → 同样先保全再降级。
 * 3. 文件缺失/空文件 → 无字节可保全，不产生 `.corrupt-*` 兄弟文件。
 * 4. startDeepChapterSession: 保全成功 → 重建不静默丢数据（损坏字节留存兄弟
 *    文件）；保全失败 → 损坏保全标记联锁，拒绝覆盖已有文件（fail-loud），
 *    原文件字节不动。
 */

const fsState = vi.hoisted(() => {
  const fileMap = new Map<string, string>()
  const createdDirs = new Set<string>()
  return {
    fileMap,
    createdDirs,
    createDirectory: vi.fn<typeof import("@/commands/fs").createDirectory>(async (path) => {
      createdDirs.add(path)
    }),
    readFile: vi.fn<typeof import("@/commands/fs").readFile>(async (path) => {
      const content = fileMap.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    }),
    writeFileAtomic: vi.fn<typeof import("@/commands/fs").writeFileAtomic>(async (path, content) => {
      fileMap.set(path, content)
    }),
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    createDirectory: fsState.createDirectory,
    readFile: fsState.readFile,
    writeFileAtomic: fsState.writeFileAtomic,
  }
})

import {
  loadNovelSessionStatus,
  novelSessionStatusPath,
  startDeepChapterSession,
} from "./novel-session-status"

const projectPath = "E:\\Novel"
// normalizePath("E:\\Novel") → "E:/Novel"（与相邻 spec 的既有断言一致）。
const normalizedProjectPath = "E:/Novel"
const statusPath = novelSessionStatusPath(projectPath)

/** 磁盘上所有 `.corrupt-*` 兄弟文件（同目录、同基名 + .corrupt-<时间戳> 后缀）。 */
function corruptSiblingPaths(): string[] {
  return [...fsState.fileMap.keys()].filter((p) => /\/status\.corrupt-[^/]*\.json$/.test(p))
}

const CORRUPT_SIBLING_RE = /^E:\/Novel\/\.novel\/status\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/

/** 手动校验可过的完整 status 形状（供「合法 JSON 但枚举越界」用例）。 */
function validStatusObject(): Record<string, unknown> {
  return {
    schema_version: "1",
    session_id: "sess-corrupt-preserve",
    source: "deep_chapter_generation",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    status: "running",
    active_step_index: 1,
    current_task: {
      task_id: "t",
      conversation_id: "conv-corrupt-preserve",
      user_request: "generate chapter 3",
      chapter_number: 3,
      checkpoint_stage: "started",
      status: "running",
    },
    draft: {
      draft_id: "conv-corrupt-preserve",
      file_path: `${normalizedProjectPath}/.novel/drafts/conv-corrupt-preserve.json`,
      draft_status: "pending",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    evidence_refs: [],
  }
}

describe("CORR-A: loadNovelSessionStatus 损坏回读保全（corrupt-preserve）", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    fsState.fileMap.clear()
    fsState.createdDirs.clear()
    fsState.readFile.mockImplementation(async (path: string) => {
      const content = fsState.fileMap.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    })
    fsState.writeFileAtomic.mockImplementation(async (path: string, content: string) => {
      fsState.fileMap.set(path, content)
    })
  })

  it("非法 JSON → 返回 null + 原始字节保全到 `.corrupt-<时间戳>` 兄弟文件 + 原文件字节未改动", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const corruptRaw = "{not-valid-json"
    fsState.fileMap.set(statusPath, corruptRaw)

    await expect(loadNovelSessionStatus(projectPath)).resolves.toBeNull()

    // 原文件字节未被改动（禁止在未保全的情况下覆盖/改写原文件）。
    expect(fsState.fileMap.get(statusPath)).toBe(corruptRaw)

    // 同目录、同基名 + `.corrupt-<时间戳>` 后缀（与 preserveCorruptLedger 同模式）。
    const siblings = corruptSiblingPaths()
    expect(siblings).toHaveLength(1)
    expect(siblings[0]).toMatch(CORRUPT_SIBLING_RE)
    // 原始坏内容原样保全（一字不差）。
    expect(fsState.fileMap.get(siblings[0])).toBe(corruptRaw)

    // fail-loud：损坏诊断写入日志，不静默。
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("corrupted status.json"))
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(siblings[0]))
  })

  it("合法 JSON 但 schema/枚举校验失败 → 同样先保全再降级（不得静默覆盖）", async () => {
    const projectPath2 = "E:\\Novel2"
    const statusPath2 = novelSessionStatusPath(projectPath2)
    const rawSchema = JSON.stringify({ schema_version: "2", session_id: 1 })
    const rawEnum = JSON.stringify({ ...validStatusObject(), status: "foo" })
    fsState.fileMap.set(statusPath, rawSchema)
    fsState.fileMap.set(statusPath2, rawEnum)

    await expect(loadNovelSessionStatus(projectPath)).resolves.toBeNull()
    await expect(loadNovelSessionStatus(projectPath2)).resolves.toBeNull()

    // 两份损坏文件各自保全；原文件字节均未改动。
    expect(fsState.fileMap.get(statusPath)).toBe(rawSchema)
    expect(fsState.fileMap.get(statusPath2)).toBe(rawEnum)
    const siblings = corruptSiblingPaths()
    expect(siblings).toHaveLength(2)
    const sibling1 = siblings.find((p) => p.startsWith(`${normalizedProjectPath}/.novel/`))!
    expect(sibling1).toMatch(CORRUPT_SIBLING_RE)
    expect(fsState.fileMap.get(sibling1)).toBe(rawSchema)
    const sibling2 = siblings.find((p) => p.startsWith("E:/Novel2/.novel/"))!
    expect(sibling2).toMatch(/^E:\/Novel2\/\.novel\/status\.corrupt-[^/]*\.json$/)
    expect(fsState.fileMap.get(sibling2)).toBe(rawEnum)
  })

  it("文件缺失/空文件 → 无字节可保全，不产生 `.corrupt-*` 兄弟文件", async () => {
    await expect(loadNovelSessionStatus(projectPath)).resolves.toBeNull()
    expect(corruptSiblingPaths()).toHaveLength(0)

    fsState.fileMap.set(statusPath, "")
    await expect(loadNovelSessionStatus(projectPath)).resolves.toBeNull()
    expect(corruptSiblingPaths()).toHaveLength(0)

    // 保全写路径未被触发（无兄弟文件、也无 status.json 改写）。
    expect(fsState.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsState.fileMap.get(statusPath)).toBe("")
  })

  it("startDeepChapterSession: 损坏文件保全成功后被重建 → 损坏字节留存兄弟文件（非静默覆盖）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const corruptRaw = "{not-valid-json"
    fsState.fileMap.set(statusPath, corruptRaw)

    const status = await startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })
    expect(status.status).toBe("running")

    // 重建覆盖发生，但损坏字节先被保全：兄弟文件仍在，内容为原始坏字节。
    const siblings = corruptSiblingPaths()
    expect(siblings).toHaveLength(1)
    expect(fsState.fileMap.get(siblings[0])).toBe(corruptRaw)

    // status.json 已是新的合法重建结果（自愈且不丢数据）。
    const rebuilt = JSON.parse(fsState.fileMap.get(statusPath)!) as { session_id: string }
    expect(rebuilt.session_id).toBe(status.session_id)
  })

  it("startDeepChapterSession: 保全失败 → 拒绝覆盖已有文件 fail-loud，原字节与写次数不动", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const corruptRaw = "{not-valid-json"
    fsState.fileMap.set(statusPath, corruptRaw)
    // 首次 writeFileAtomic（保全兄弟文件）失败 → 损坏保全标记 = 未保全。
    fsState.writeFileAtomic.mockImplementationOnce(async () => {
      throw new Error("disk full")
    })

    await expect(startDeepChapterSession({
      projectPath,
      conversationId: "conv-1",
      userRequest: "generate chapter 3",
      chapterNumber: 3,
    })).rejects.toThrow(/拒绝覆盖未保全的损坏 status\.json/)

    // 未发生任何覆盖：原文件字节不动，无兄弟文件，仅 1 次失败的保全写尝试。
    expect(fsState.fileMap.get(statusPath)).toBe(corruptRaw)
    expect(corruptSiblingPaths()).toHaveLength(0)
    expect(fsState.writeFileAtomic).toHaveBeenCalledTimes(1)
  })
})
