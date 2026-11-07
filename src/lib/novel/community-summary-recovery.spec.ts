/** community-summary-recovery.spec.ts — 备份/恢复只处理目标后缀，目录项与异类文件一律跳过。 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsState = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    listDirectory: fsState.listDirectory,
    readFile: fsState.readFile,
    writeFileAtomic: fsState.writeFileAtomic,
  }
})

import {
  backupCommunitySummariesLastGood,
  restoreCommunitySummariesLastGood,
} from "./community-summary-recovery"

const DIR = "/P/.novel/community-summaries"

beforeEach(() => {
  fsState.listDirectory.mockReset()
  fsState.readFile.mockReset()
  fsState.writeFileAtomic.mockReset()
})

describe("backupCommunitySummariesLastGood", () => {
  it("目录项与异类文件跳过，只备份 .json", async () => {
    fsState.listDirectory.mockResolvedValue([
      { name: "sub", path: `${DIR}/sub`, is_dir: true },
      { name: "notes.txt", path: `${DIR}/notes.txt`, is_dir: false },
      { name: "c1.json", path: `${DIR}/c1.json`, is_dir: false },
    ])
    fsState.readFile.mockResolvedValue("{}")
    fsState.writeFileAtomic.mockResolvedValue(undefined)

    await backupCommunitySummariesLastGood("/P")

    expect(fsState.readFile).toHaveBeenCalledTimes(1)
    expect(fsState.writeFileAtomic).toHaveBeenCalledWith(`${DIR}/c1.json.last-good`, "{}")
  })
})

describe("restoreCommunitySummariesLastGood", () => {
  it("只回填 .json.last-good，且去掉后缀写回原名", async () => {
    fsState.listDirectory.mockResolvedValue([
      { name: "sub", path: `${DIR}/sub`, is_dir: true },
      { name: "c1.json", path: `${DIR}/c1.json`, is_dir: false },
      { name: "c2.json.last-good", path: `${DIR}/c2.json.last-good`, is_dir: false },
    ])
    fsState.readFile.mockResolvedValue("good")
    fsState.writeFileAtomic.mockResolvedValue(undefined)

    await restoreCommunitySummariesLastGood("/P")

    expect(fsState.readFile).toHaveBeenCalledTimes(1)
    expect(fsState.writeFileAtomic).toHaveBeenCalledWith(`${DIR}/c2.json`, "good")
  })
})

describe("目录不可读时静默返回", () => {
  it("备份：listDirectory 失败 → 直接返回，不读不写", async () => {
    fsState.listDirectory.mockRejectedValue(new Error("ENOENT"))
    await expect(backupCommunitySummariesLastGood("/P")).resolves.toBeUndefined()
    expect(fsState.readFile).not.toHaveBeenCalled()
    expect(fsState.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("恢复：listDirectory 失败 → 直接返回，不读不写", async () => {
    fsState.listDirectory.mockRejectedValue(new Error("ENOENT"))
    await expect(restoreCommunitySummariesLastGood("/P")).resolves.toBeUndefined()
    expect(fsState.writeFileAtomic).not.toHaveBeenCalled()
  })
})
