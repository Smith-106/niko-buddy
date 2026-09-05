import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  hasPersistedDirectorState,
  loadDirectorPersisted,
  saveDirectorPersisted,
  saveDirectorIdeaInput,
  EMPTY_IDEA_INPUT,
  type DirectorPersistedFile,
} from "./director-pipeline-store"
import { createDirectorPipeline } from "./director-pipeline"

const mocks = vi.hoisted(() => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  fileExists: mocks.fileExists,
  readFile: mocks.readFile,
  writeFileAtomic: mocks.writeFileAtomic,
  createDirectory: mocks.createDirectory,
}))

describe("director-pipeline-store（60 号设计 D3/D4 持久化补件）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockRejectedValue(new Error("ENOENT: no such file"))
  })

  it("hasPersistedDirectorState 缺文件 → false（显式启动门）", async () => {
    expect(await hasPersistedDirectorState("/proj")).toBe(false)
    expect(mocks.fileExists).toHaveBeenCalledWith("/proj/.novel/director-pipeline.json")
  })

  it("hasPersistedDirectorState 文件存在 → true", async () => {
    mocks.fileExists.mockResolvedValue(true)
    expect(await hasPersistedDirectorState("/proj")).toBe(true)
  })

  it("loadDirectorPersisted 缺文件 → 新管线 + 空立意", async () => {
    const file = await loadDirectorPersisted("/proj")
    expect(file.state.statuses.idea).toBe("running")
    expect(file.ideaInput).toEqual(EMPTY_IDEA_INPUT)
  })

  it("saveDirectorPersisted 原子落盘 .novel/director-pipeline.json", async () => {
    mocks.readFile.mockRejectedValue(new Error("ENOENT: no such file"))
    const file: DirectorPersistedFile = {
      fileVersion: 1,
      state: createDirectorPipeline(),
      ideaInput: { title: "雾都", genre: "悬疑", coreConflict: "连环失踪" },
    }
    await saveDirectorPersisted("/proj", file)
    expect(mocks.createDirectory).toHaveBeenCalledWith("/proj/.novel")
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/proj/.novel/director-pipeline.json",
      expect.stringContaining('"title": "雾都"'),
    )
  })

  it("saveDirectorIdeaInput 只改立意不动管线状态", async () => {
    const existing: DirectorPersistedFile = {
      fileVersion: 1,
      state: createDirectorPipeline(),
      ideaInput: { title: "旧", genre: "", coreConflict: "" },
    }
    mocks.readFile.mockResolvedValue(JSON.stringify(existing))
    await saveDirectorIdeaInput("/proj", { title: "新", genre: "悬疑", coreConflict: "冲突" })
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/proj/.novel/director-pipeline.json",
      expect.stringContaining('"title": "新"'),
    )
    // 改进 1（R-glm）：断管线状态在写盘 JSON 中原样保留
    const written = mocks.writeFileAtomic.mock.calls[0][1] as string
    const parsed = JSON.parse(written)
    expect(parsed.state).toEqual(existing.state)
    expect(parsed.ideaInput.title).toBe("新")
  })

  it("Windows 缺文件错误文案（os error 2）→ 降级新管线（P1-B 回归）", async () => {
    // 改进 2（R-glm）：Windows Rust read_file 缺文件文案必须触发 isMissingError
    mocks.readFile.mockRejectedValue(
      new Error("Failed to read text file '/x/.novel/director-pipeline.json': The system cannot find the file specified. (os error 2)"),
    )
    const file = await loadDirectorPersisted("/x")
    expect(file.state.statuses.idea).toBe("running")
    expect(file.ideaInput).toEqual(EMPTY_IDEA_INPUT)
  })

  it("结构损坏（合法 JSON 缺 state）→ 降级 emptyFile（P3）", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ fileVersion: 1, ideaInput: { title: "x" } }))
    const file = await loadDirectorPersisted("/proj")
    expect(file.state.statuses.idea).toBe("running")
    expect(file.ideaInput).toEqual(EMPTY_IDEA_INPUT)
  })
})
