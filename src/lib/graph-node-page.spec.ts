import { describe, expect, it } from "vitest"
import { buildEditableGraphNodePage } from "./graph-node-page"
import type { GraphNode } from "./wiki-graph"

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "node-1",
    label: "林晚",
    type: "character",
    path: "",
    linkCount: 3,
    community: 0,
    ...overrides,
  }
}

describe("buildEditableGraphNodePage", () => {
  it("builds a page with frontmatter and content from the node", () => {
    const page = buildEditableGraphNodePage("C:/novel", makeNode())
    expect(page.title).toBe("林晚")
    expect(page.path).toBe("C:/novel/wiki/entities/林晚.md")
    expect(page.pageId).toBe("林晚")
    expect(page.content).toContain("title: 林晚")
    expect(page.content).toContain("tags: [character]")
    expect(page.content).toContain("updated: ")
    expect(page.content).toContain("# 林晚")
    expect(page.content).toContain("关联数量：3")
    expect(page.content).toContain("## 基础信息")
  })

  it("uses the node's own path when present and derives the page id from it", () => {
    const node = makeNode({ path: "D:/works/wiki/entities/wulin.md" })
    const page = buildEditableGraphNodePage("C:/novel", node)
    expect(page.path).toBe("D:/works/wiki/entities/wulin.md")
    expect(page.pageId).toBe("wulin")
  })

  it("normalizes the project path (backslashes → forward slashes)", () => {
    const page = buildEditableGraphNodePage("E:\\Novel", makeNode())
    expect(page.path).toBe("E:/Novel/wiki/entities/林晚.md")
  })

  it("maps novel graph types to their content tags", () => {
    for (const [type, tag] of [
      ["character", "character"],
      ["location", "location"],
      ["organization", "organization"],
      ["item", "item"],
      ["event", "event"],
      ["chapter", "chapter"],
      ["outline", "outline"],
      ["foreshadowing", "foreshadowing"],
      ["secret", "secret"],
      ["conflict", "conflict"],
      ["timeline-point", "timeline"],
      ["canon-rule", "canon"],
    ] as const) {
      const page = buildEditableGraphNodePage("C:/novel", makeNode({ type, path: "" }))
      expect(page.content).toContain(`tags: [${tag}]`)
    }
  })

  it("falls back to the raw type then to entity for unknown or missing types", () => {
    const page = buildEditableGraphNodePage("C:/novel", makeNode({ type: "mystery" }))
    expect(page.content).toContain("tags: [mystery]")

    const noType = buildEditableGraphNodePage("C:/novel", makeNode({ type: "" }))
    expect(noType.content).toContain("tags: [entity]")
  })

  it("sanitizes illegal filename characters from labels", () => {
    const node = makeNode({ label: 'a/b\\c:d*e?f"g<h>i|j' })
    const page = buildEditableGraphNodePage("C:/novel", node)
    expect(page.path).toBe("C:/novel/wiki/entities/a-b-c-d-e-f-g-h-i-j.md")
    expect(page.pageId).toBe("a-b-c-d-e-f-g-h-i-j")
  })

  it("uses a fallback filename for whitespace-only labels", () => {
    const page = buildEditableGraphNodePage("C:/novel", makeNode({ label: "   " }))
    expect(page.path).toBe("C:/novel/wiki/entities/未命名节点.md")
    expect(page.pageId).toBe("未命名节点")
  })

  it("falls back to the sanitized label when the path has no file name", () => {
    const page = buildEditableGraphNodePage("C:/novel", makeNode({ path: "C:/novel/wiki/" }))
    expect(page.pageId).toBe("林晚")
  })

  it("handles uppercase .MD extensions in page ids", () => {
    const page = buildEditableGraphNodePage("C:/novel", makeNode({ path: "C:/novel/x.MD" }))
    expect(page.pageId).toBe("x")
  })
})
