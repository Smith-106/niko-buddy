import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  FsError,
  copyDirectory,
  copyFile,
  createDirectory,
  createProject,
  deleteFile,
  fileExists,
  findRelatedWikiPages,
  getExecutableDir,
  getFileMd5,
  getFileModifiedTime,
  getFileSize,
  getResourceDir,
  listDirectory,
  openFileLocation,
  openProject,
  openProjectFolder,
  pathIsDirectory,
  preprocessFile,
  readFile,
  readFileAsBase64,
  toFsError,
  writeFile,
  writeFileAtomic,
  writeFilesAtomic,
} from "./fs"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  transformCallback: vi.fn(),
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  transformCallback: mocks.transformCallback,
}))

vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: mocks.ensureProjectId,
  upsertProjectInfo: mocks.upsertProjectInfo,
}))

/** 简单 invoke 包装用例：(函数, 调用参数, invoke 期望参数, mock 返回值)。 */
type SimpleCase = {
  name: string
  run: () => Promise<unknown>
  invokeArgs: unknown[]
  resolved: unknown
}

const simpleCases: SimpleCase[] = [
  { name: "readFile", run: () => readFile("/p/a.md"), invokeArgs: ["read_file", { path: "/p/a.md" }], resolved: "text" },
  { name: "writeFile", run: () => writeFile("/p/a.md", "x"), invokeArgs: ["write_file", { path: "/p/a.md", contents: "x" }], resolved: undefined },
  { name: "writeFileAtomic", run: () => writeFileAtomic("/p/a.md", "x"), invokeArgs: ["write_file_atomic", { path: "/p/a.md", contents: "x" }], resolved: undefined },
  { name: "listDirectory", run: () => listDirectory("/p"), invokeArgs: ["list_directory", { path: "/p" }], resolved: [{ id: "1" }] },
  { name: "copyFile", run: () => copyFile("/a", "/b"), invokeArgs: ["copy_file", { source: "/a", destination: "/b" }], resolved: undefined },
  { name: "copyDirectory", run: () => copyDirectory("/a", "/b"), invokeArgs: ["copy_directory", { source: "/a", destination: "/b" }], resolved: ["/b/x"] },
  { name: "preprocessFile", run: () => preprocessFile("/p"), invokeArgs: ["preprocess_file", { path: "/p" }], resolved: "pre" },
  { name: "deleteFile", run: () => deleteFile("/p"), invokeArgs: ["delete_file", { path: "/p" }], resolved: undefined },
  { name: "findRelatedWikiPages", run: () => findRelatedWikiPages("/p", "s"), invokeArgs: ["find_related_wiki_pages", { projectPath: "/p", sourceName: "s" }], resolved: ["a"] },
  { name: "createDirectory", run: () => createDirectory("/p"), invokeArgs: ["create_directory", { path: "/p" }], resolved: undefined },
  { name: "fileExists", run: () => fileExists("/p"), invokeArgs: ["file_exists", { path: "/p" }], resolved: true },
  { name: "pathIsDirectory", run: () => pathIsDirectory("/p"), invokeArgs: ["path_is_directory", { path: "/p" }], resolved: true },
  { name: "getFileModifiedTime", run: () => getFileModifiedTime("/p"), invokeArgs: ["get_file_modified_time", { path: "/p" }], resolved: 123 },
  { name: "getFileSize", run: () => getFileSize("/p"), invokeArgs: ["get_file_size", { path: "/p" }], resolved: 42 },
  { name: "getFileMd5", run: () => getFileMd5("/p"), invokeArgs: ["get_file_md5", { path: "/p" }], resolved: "abc" },
  { name: "readFileAsBase64", run: () => readFileAsBase64("/p"), invokeArgs: ["read_file_as_base64", { path: "/p" }], resolved: { base64: "b", mimeType: "text/plain" } },
  { name: "openProjectFolder", run: () => openProjectFolder("/p"), invokeArgs: ["open_project_folder", { path: "/p" }], resolved: undefined },
  { name: "openFileLocation", run: () => openFileLocation("/p"), invokeArgs: ["open_file_location", { path: "/p" }], resolved: undefined },
  { name: "getExecutableDir", run: () => getExecutableDir(), invokeArgs: ["get_executable_dir"], resolved: "/bin" },
  { name: "getResourceDir", run: () => getResourceDir(), invokeArgs: ["get_resource_dir"], resolved: "/res" },
  { name: "writeFilesAtomic", run: () => writeFilesAtomic([["/p/a.md", "x"], ["/p/b.md", "y"]]), invokeArgs: ["write_files_atomic", { files: [["/p/a.md", "x"], ["/p/b.md", "y"]] }], resolved: undefined },
]


describe("fs command wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invoke.mockResolvedValue(undefined)
    mocks.ensureProjectId.mockResolvedValue("id-1")
    mocks.upsertProjectInfo.mockResolvedValue(undefined)
  })

  it.each(simpleCases)("$name forwards 参数并透传 invoke 返回值", async ({ run, invokeArgs, resolved }) => {
    mocks.invoke.mockResolvedValue(resolved)
    await expect(run()).resolves.toBe(resolved)
    expect(mocks.invoke).toHaveBeenCalledWith(...(invokeArgs as [unknown, ...unknown[]]))
  })

  it("createProject 调用 create_project 并注册项目身份", async () => {
    mocks.invoke.mockResolvedValue({ name: "Book", path: "/p/book" })
    mocks.ensureProjectId.mockResolvedValue("pid")

    await expect(createProject("Book", "/p/book")).resolves.toEqual({
      id: "pid",
      name: "Book",
      path: "/p/book",
    })
    expect(mocks.invoke).toHaveBeenCalledWith("create_project", { name: "Book", path: "/p/book" })
    expect(mocks.ensureProjectId).toHaveBeenCalledWith("/p/book")
    expect(mocks.upsertProjectInfo).toHaveBeenCalledWith("pid", "/p/book", "Book")
  })

  it("openProject 调用 open_project 并注册项目身份", async () => {
    mocks.invoke.mockResolvedValue({ name: "Opened", path: "/p/opened" })
    mocks.ensureProjectId.mockResolvedValue("oid")

    await expect(openProject("/p/opened")).resolves.toEqual({
      id: "oid",
      name: "Opened",
      path: "/p/opened",
    })
    expect(mocks.invoke).toHaveBeenCalledWith("open_project", { path: "/p/opened" })
    expect(mocks.ensureProjectId).toHaveBeenCalledWith("/p/opened")
    expect(mocks.upsertProjectInfo).toHaveBeenCalledWith("oid", "/p/opened", "Opened")
  })

  it("invoke 拒绝时包装为 FsError 信封（readFile，Error 输入）", async () => {
    const err = new Error("invoke failed")
    mocks.invoke.mockRejectedValue(err)
    const caught = await readFile("/p/a.md").catch((e) => e)
    expect(caught).toBeInstanceOf(FsError)
    expect(caught.command).toBe("read_file")
    expect(caught.code).toBe("fs/read_file")
    expect(caught.message).toBe("invoke failed")
    expect(caught.details).toBe(err)
  })

  it("invoke 拒绝字符串时 message 原样保留（Tauri 后端常直接拒绝字符串）", async () => {
    mocks.invoke.mockRejectedValue("path not found")
    const caught = await readFile("/p/a.md").catch((e) => e)
    expect(caught).toBeInstanceOf(FsError)
    expect(caught.message).toBe("path not found")
    expect(caught.details).toBe("path not found")
  })

  it("createProject 的 invoke 失败同样进信封", async () => {
    mocks.invoke.mockRejectedValue(new Error("backend panic"))
    const caught = await createProject("Book", "/p/book").catch((e) => e)
    expect(caught).toBeInstanceOf(FsError)
    expect(caught.command).toBe("create_project")
  })

  it("toFsError：FsError 直接透传；对象拒绝值 JSON 化进 message", () => {
    const inner = new FsError("read_file", "m", { raw: 1 })
    expect(toFsError("read_file", inner)).toBe(inner)
    const fromObj = toFsError("list_directory", { code: 500 })
    expect(fromObj).toBeInstanceOf(FsError)
    expect(fromObj.message).toBe(JSON.stringify({ code: 500 }))
    expect(fromObj.details).toEqual({ code: 500 })
  })

  it("createProject 在 ensureProjectId 失败时异常传播", async () => {
    mocks.invoke.mockResolvedValue({ name: "Book", path: "/p/book" })
    const err = new Error("identity failed")
    mocks.ensureProjectId.mockRejectedValue(err)
    await expect(createProject("Book", "/p/book")).rejects.toBe(err)
    expect(mocks.upsertProjectInfo).not.toHaveBeenCalled()
  })

  it("openProject 在 upsertProjectInfo 失败时异常传播", async () => {
    mocks.invoke.mockResolvedValue({ name: "Opened", path: "/p/opened" })
    mocks.ensureProjectId.mockResolvedValue("oid")
    const err = new Error("upsert failed")
    mocks.upsertProjectInfo.mockRejectedValue(err)
    await expect(openProject("/p/opened")).rejects.toBe(err)
  })
})
