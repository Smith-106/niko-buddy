import { describe, expect, it } from "vitest"
import type { FileNode } from "@/types/wiki"
import { collectAllFilesIncludingDot, decideDeleteClick } from "./sources-tree-delete"

function file(path: string): FileNode {
  return { path, name: path.split("/").pop() ?? path, is_dir: false } as FileNode
}

function dir(path: string, children: FileNode[] = []): FileNode {
  return { path, name: path.split("/").pop() ?? path, is_dir: true, children } as FileNode
}

describe("collectAllFilesIncludingDot", () => {
  it("returns the file itself for a plain file node", () => {
    const node = file("/src/a.md")
    expect(collectAllFilesIncludingDot(node)).toEqual([node])
  })

  it("collects every leaf file under a folder, recursively", () => {
    const tree = dir("/src", [
      file("/src/a.md"),
      dir("/src/sub", [file("/src/sub/b.md"), file("/src/sub/c.txt")]),
      file("/src/.dotfile"),
    ])
    const result = collectAllFilesIncludingDot(tree)
    expect(result.map((n) => n.path)).toEqual([
      "/src/a.md",
      "/src/sub/b.md",
      "/src/sub/c.txt",
      "/src/.dotfile",
    ])
  })

  it("returns no entries for an empty folder", () => {
    expect(collectAllFilesIncludingDot(dir("/empty"))).toEqual([])
  })

  it("handles a directory node without a children key", () => {
    const bare = { path: "/bare", name: "bare", is_dir: true } as FileNode
    expect(collectAllFilesIncludingDot(bare)).toEqual([])
  })

  it("skips empty subfolders but keeps files in populated ones", () => {
    const tree = dir("/root", [
      dir("/root/empty", []),
      dir("/root/pop", [file("/root/pop/only.md")]),
    ])
    expect(collectAllFilesIncludingDot(tree).map((n) => n.path)).toEqual([
      "/root/pop/only.md",
    ])
  })
})

describe("decideDeleteClick", () => {
  it("arms on the first click of a file node", () => {
    const node = file("/a.md")
    expect(decideDeleteClick(null, node)).toEqual({ kind: "arm", path: "/a.md" })
  })

  it("arms when a different node is pending", () => {
    const node = file("/b.md")
    expect(decideDeleteClick("/a.md", node)).toEqual({ kind: "arm", path: "/b.md" })
  })

  it("fires a file delete on the second click of the same file", () => {
    const node = file("/a.md")
    expect(decideDeleteClick("/a.md", node)).toEqual({ kind: "fire-file", node })
  })

  it("fires a folder delete on the second click of the same folder", () => {
    const node = dir("/src")
    expect(decideDeleteClick("/src", node)).toEqual({ kind: "fire-folder", node })
  })

  it("arms a folder on its first click", () => {
    const node = dir("/src")
    expect(decideDeleteClick(null, node)).toEqual({ kind: "arm", path: "/src" })
  })
})
