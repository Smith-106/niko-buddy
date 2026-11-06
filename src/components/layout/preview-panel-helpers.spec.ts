import { describe, expect, it } from "vitest"

import type { FileNode } from "@/types/wiki"
import { collectRecentChapterFiles } from "./preview-panel-helpers"

function node(overrides: Partial<FileNode> & { name: string; path: string }): FileNode {
  return { is_dir: false, ...overrides }
}

describe("collectRecentChapterFiles 过滤", () => {
  it("跳过非 .md 文件与非章节路径的 .md，递归目录，只收章节", () => {
    const nodes: FileNode[] = [
      node({ name: "cover.png", path: "/p/wiki/chapters/cover.png" }),
      // .md 但不是章节路径 → 命中 isChapterPath 守卫
      node({ name: "notes.md", path: "/p/wiki/notes.md" }),
      node({ name: "003.md", path: "/p/wiki/chapters/003.md" }),
      node({
        name: "sub",
        path: "/p/wiki/chapters/sub",
        is_dir: true,
        children: [node({ name: "004.md", path: "/p/wiki/chapters/004.md" })],
      }),
    ]

    const out = collectRecentChapterFiles(nodes)

    // 目录被递归展开，非章节与非 md 均被过滤；按章号降序
    expect(out.map((item) => item.path)).toEqual([
      "/p/wiki/chapters/004.md",
      "/p/wiki/chapters/003.md",
    ])
  })
})
