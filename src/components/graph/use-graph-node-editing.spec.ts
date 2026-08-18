// @vitest-environment jsdom
/**
 * useGraphNodeEditing — 节点内联编辑/打开档案页/保存/取消全分支覆盖。
 * store 与外部依赖全部 vi.mock（vi.hoisted 可写 state 模式，参照 src/App.spec.tsx）。
 */
import { renderHook, act } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useGraphNodeEditing } from "./use-graph-node-editing"
import type { GraphNode } from "@/lib/wiki-graph"
import type { EmbeddingConfig } from "@/stores/wiki-store"

interface WikiLike {
  project: { id: string; name: string; path: string } | null
  setSelectedFile: ReturnType<typeof vi.fn>
  setFileContent: ReturnType<typeof vi.fn>
  bumpDataVersion: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  const wiki: WikiLike = {
    project: { id: "p1", name: "MyBook", path: "/p" },
    setSelectedFile: vi.fn(),
    setFileContent: vi.fn(),
    bumpDataVersion: vi.fn(),
  }
  return {
    wiki,
    t: vi.fn((key: string) => key),
    readFile: vi.fn(),
    writeFileAtomic: vi.fn(),
    createDirectory: vi.fn(),
    fileExists: vi.fn(),
    buildEditableGraphNodePage: vi.fn(
      (_projectPath: string, node: { label: string }) => ({
        path: `/p/wiki/entities/${node.label}.md`,
        pageId: node.label,
        title: node.label,
        content: `# ${node.label}`,
      }),
    ),
    embedPage: vi.fn(),
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: unknown) => unknown) => selector(mocks.wiki),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFileAtomic: mocks.writeFileAtomic,
  createDirectory: mocks.createDirectory,
  fileExists: mocks.fileExists,
}))

vi.mock("@/lib/graph-node-page", () => ({
  buildEditableGraphNodePage: mocks.buildEditableGraphNodePage,
}))

vi.mock("@/lib/embedding", () => ({
  embedPage: mocks.embedPage,
}))

const node: GraphNode = {
  id: "n1",
  label: "林烬",
  type: "character",
  path: "",
  linkCount: 3,
  community: 1,
}

const embeddingEnabled: EmbeddingConfig = {
  enabled: true,
  endpoint: "http://127.0.0.1:1234/v1/embeddings",
  apiKey: "k",
  model: "text-embedding-qwen3-embedding-0.6b",
}

function renderEditingHook() {
  return renderHook(() => useGraphNodeEditing())
}

describe("useGraphNodeEditing", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.wiki.project = { id: "p1", name: "MyBook", path: "/p" }
    mocks.readFile.mockResolvedValue("已有档案内容")
    mocks.writeFileAtomic.mockResolvedValue(undefined)
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.fileExists.mockResolvedValue(true)
    mocks.embedPage.mockResolvedValue(undefined)
  })

  // ── handleEditNode ─────────────────────────────────────────────────────────────

  it("handleEditNode：无项目直接返回 undefined", async () => {
    mocks.wiki.project = null
    const { result } = renderEditingHook()
    await act(async () => {
      await expect(result.current.handleEditNode(node)).resolves.toBeUndefined()
    })
    expect(mocks.buildEditableGraphNodePage).not.toHaveBeenCalled()
  })

  it("handleEditNode：文件存在时读取已有内容", async () => {
    const { result } = renderEditingHook()
    let value: { path: string; content: string; title: string } | undefined
    await act(async () => {
      value = await result.current.handleEditNode(node)
    })
    expect(mocks.fileExists).toHaveBeenCalledWith("/p/wiki/entities/林烬.md")
    expect(mocks.readFile).toHaveBeenCalledWith("/p/wiki/entities/林烬.md")
    expect(value).toEqual({ path: "/p/wiki/entities/林烬.md", content: "已有档案内容", title: "林烬" })
  })

  it("handleEditNode：文件不存在时使用模板内容", async () => {
    mocks.fileExists.mockResolvedValue(false)
    const { result } = renderEditingHook()
    let value: { path: string; content: string; title: string } | undefined
    await act(async () => {
      value = await result.current.handleEditNode(node)
    })
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(value?.content).toBe("# 林烬")
  })

  it("handleEditNode：fileExists/readFile 抛错时回退模板内容", async () => {
    mocks.fileExists.mockRejectedValue(new Error("fs-boom"))
    const { result } = renderEditingHook()
    let value: { path: string; content: string; title: string } | undefined
    await act(async () => {
      value = await result.current.handleEditNode(node)
    })
    expect(value?.content).toBe("# 林烬")
  })

  // ── handleOpenNodeProfilePage ──────────────────────────────────────────────────

  it("handleOpenNodeProfilePage：无项目直接返回", async () => {
    mocks.wiki.project = null
    const { result } = renderEditingHook()
    await act(async () => {
      await expect(result.current.handleOpenNodeProfilePage(node)).resolves.toBeUndefined()
    })
  })

  it("handleOpenNodeProfilePage：文件存在 → 读取并选中，不 bump 版本", async () => {
    const { result } = renderEditingHook()
    await act(async () => {
      await result.current.handleOpenNodeProfilePage(node)
    })
    expect(mocks.readFile).toHaveBeenCalledWith("/p/wiki/entities/林烬.md")
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(mocks.wiki.setSelectedFile).toHaveBeenCalledWith("/p/wiki/entities/林烬.md")
    expect(mocks.wiki.setFileContent).toHaveBeenCalledWith("已有档案内容")
    expect(mocks.wiki.bumpDataVersion).not.toHaveBeenCalled()
  })

  it("handleOpenNodeProfilePage：文件不存在 → 建目录写文件并 bump 版本", async () => {
    mocks.fileExists.mockResolvedValue(false)
    const { result } = renderEditingHook()
    await act(async () => {
      await result.current.handleOpenNodeProfilePage(node)
    })
    expect(mocks.createDirectory).toHaveBeenCalledWith("/p/wiki/entities")
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith("/p/wiki/entities/林烬.md", "# 林烬")
    expect(mocks.wiki.setSelectedFile).toHaveBeenCalledWith("/p/wiki/entities/林烬.md")
    expect(mocks.wiki.bumpDataVersion).toHaveBeenCalledTimes(1)
  })

  it("handleOpenNodeProfilePage：路径无目录段时跳过 createDirectory", async () => {
    mocks.fileExists.mockResolvedValue(false)
    mocks.buildEditableGraphNodePage.mockReturnValueOnce({
      path: "plain-file.md",
      pageId: "plain-file",
      title: "林烬",
      content: "# 林烬",
    })
    const { result } = renderEditingHook()
    await act(async () => {
      await result.current.handleOpenNodeProfilePage(node)
    })
    expect(mocks.createDirectory).not.toHaveBeenCalled()
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith("plain-file.md", "# 林烬")
    expect(mocks.wiki.bumpDataVersion).toHaveBeenCalledTimes(1)
  })

  it("handleOpenNodeProfilePage：写文件失败时吞掉并打印错误", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.fileExists.mockResolvedValue(false)
    mocks.writeFileAtomic.mockRejectedValue(new Error("write-boom"))
    const { result } = renderEditingHook()
    await act(async () => {
      await result.current.handleOpenNodeProfilePage(node)
    })
    expect(errorSpy).toHaveBeenCalledWith("Failed to open graph node profile page:", expect.any(Error))
    expect(mocks.wiki.setSelectedFile).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  // ── handleSaveNodeEdit ─────────────────────────────────────────────────────────

  it("handleSaveNodeEdit：无项目返回失败", async () => {
    mocks.wiki.project = null
    const { result } = renderEditingHook()
    await act(async () => {
      await expect(
        result.current.handleSaveNodeEdit({ editingPath: "/p/x.md", editingContent: "c", editingNode: node }),
      ).resolves.toEqual({ success: false })
    })
  })

  it("handleSaveNodeEdit：无节点返回失败", async () => {
    const { result } = renderEditingHook()
    await act(async () => {
      await expect(
        result.current.handleSaveNodeEdit({ editingPath: "/p/x.md", editingContent: "c", editingNode: null }),
      ).resolves.toEqual({ success: false })
    })
  })

  it("handleSaveNodeEdit：无路径返回失败", async () => {
    const { result } = renderEditingHook()
    await act(async () => {
      await expect(
        result.current.handleSaveNodeEdit({ editingPath: "", editingContent: "c", editingNode: node }),
      ).resolves.toEqual({ success: false })
    })
  })

  it("handleSaveNodeEdit：保存成功（无 embedding）返回 savedRealProfile", async () => {
    const { result } = renderEditingHook()
    let value: { success: boolean; msg?: string } | undefined
    await act(async () => {
      value = await result.current.handleSaveNodeEdit({
        editingPath: "/p/wiki/entities/林烬.md",
        editingContent: "新内容",
        editingNode: node,
      })
    })
    expect(mocks.createDirectory).toHaveBeenCalledWith("/p/wiki/entities")
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith("/p/wiki/entities/林烬.md", "新内容")
    expect(mocks.embedPage).not.toHaveBeenCalled()
    expect(value).toEqual({ success: true, msg: "graph.savedRealProfile" })
  })

  it("handleSaveNodeEdit：无目录段时跳过 createDirectory", async () => {
    const { result } = renderEditingHook()
    await act(async () => {
      await result.current.handleSaveNodeEdit({
        editingPath: "file.md",
        editingContent: "c",
        editingNode: node,
      })
    })
    expect(mocks.createDirectory).not.toHaveBeenCalled()
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith("file.md", "c")
  })

  it("handleSaveNodeEdit：embedding 启用且有模型 → 重索引并返回带 embedding 文案", async () => {
    const { result } = renderEditingHook()
    let value: { success: boolean; msg?: string } | undefined
    await act(async () => {
      value = await result.current.handleSaveNodeEdit({
        editingPath: "/p/wiki/entities/林烬.md",
        editingContent: "新内容",
        editingNode: node,
        embeddingConfig: embeddingEnabled,
      })
    })
    expect(mocks.embedPage).toHaveBeenCalledWith(
      "/p",
      "林烬",
      "林烬",
      "新内容",
      embeddingEnabled,
    )
    expect(value).toEqual({ success: true, msg: "graph.savedRealProfileWithEmbedding" })
  })

  it("handleSaveNodeEdit：embedding 启用但无模型 → 不重索引", async () => {
    const { result } = renderEditingHook()
    await act(async () => {
      await result.current.handleSaveNodeEdit({
        editingPath: "/p/x.md",
        editingContent: "c",
        editingNode: node,
        embeddingConfig: { ...embeddingEnabled, model: "" },
      })
    })
    expect(mocks.embedPage).not.toHaveBeenCalled()
  })

  it("handleSaveNodeEdit：embedding 关闭 → 不重索引", async () => {
    const { result } = renderEditingHook()
    await act(async () => {
      await result.current.handleSaveNodeEdit({
        editingPath: "/p/x.md",
        editingContent: "c",
        editingNode: node,
        embeddingConfig: { ...embeddingEnabled, enabled: false },
      })
    })
    expect(mocks.embedPage).not.toHaveBeenCalled()
  })

  it("handleSaveNodeEdit：写入失败（Error）返回失败 message", async () => {
    mocks.writeFileAtomic.mockRejectedValue(new Error("disk-full"))
    const { result } = renderEditingHook()
    let value: { success: boolean; msg?: string } | undefined
    await act(async () => {
      value = await result.current.handleSaveNodeEdit({
        editingPath: "/p/x.md",
        editingContent: "c",
        editingNode: node,
      })
    })
    expect(value).toEqual({ success: false, msg: "disk-full" })
  })

  it("handleSaveNodeEdit：写入失败（非 Error）回退 t(saveNodeFailed)", async () => {
    mocks.writeFileAtomic.mockRejectedValue("raw-fail")
    const { result } = renderEditingHook()
    let value: { success: boolean; msg?: string } | undefined
    await act(async () => {
      value = await result.current.handleSaveNodeEdit({
        editingPath: "/p/x.md",
        editingContent: "c",
        editingNode: node,
      })
    })
    expect(value).toEqual({ success: false, msg: "graph.saveNodeFailed" })
  })

  // ── handleCancelNodeEdit / bumpDataVersion ────────────────────────────────────

  it("handleCancelNodeEdit：返回重置对象", () => {
    const { result } = renderEditingHook()
    expect(result.current.handleCancelNodeEdit()).toEqual({
      editingNode: null,
      editingPath: "",
      editingContent: "",
      editStatus: null,
    })
  })

  it("返回的 bumpDataVersion 透传 store 实现", () => {
    const { result } = renderEditingHook()
    expect(result.current.bumpDataVersion).toBe(mocks.wiki.bumpDataVersion)
    act(() => result.current.bumpDataVersion())
    expect(mocks.wiki.bumpDataVersion).toHaveBeenCalledTimes(1)
  })
})
