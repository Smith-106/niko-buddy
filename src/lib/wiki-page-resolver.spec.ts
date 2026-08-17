import { describe, expect, it } from "vitest"
import type { FileNode } from "@/types/wiki"
import {
  findInTreeByName,
  resolveRelatedSlug,
  resolveSourceName,
  unwrapWikilink,
} from "./wiki-page-resolver"

function file(name: string, path: string): FileNode {
  return { name, path, is_dir: false }
}

function dir(name: string, path: string, children: FileNode[]): FileNode {
  return { name, path, is_dir: true, children }
}

describe("unwrapWikilink", () => {
  it("returns identity for non-wikilink input", () => {
    expect(unwrapWikilink("plain-slug")).toEqual({ slug: "plain-slug", label: "plain-slug" })
    expect(unwrapWikilink("[bracketed]")).toEqual({ slug: "[bracketed]", label: "[bracketed]" })
    expect(unwrapWikilink("")).toEqual({ slug: "", label: "" })
  })

  it("parses [[target]] with the target as label", () => {
    expect(unwrapWikilink("[[dpao]]")).toEqual({ slug: "dpao", label: "dpao" })
  })

  it("parses [[target|alias]] preferring the alias", () => {
    expect(unwrapWikilink("[[dpao|DPAO protocol]]")).toEqual({
      slug: "dpao",
      label: "DPAO protocol",
    })
  })

  it("falls back to the target when the alias is blank", () => {
    expect(unwrapWikilink("[[dpao|]]")).toEqual({ slug: "dpao", label: "dpao" })
    expect(unwrapWikilink("[[dpao|   ]]")).toEqual({ slug: "dpao", label: "dpao" })
  })

  it("trims target and alias whitespace", () => {
    expect(unwrapWikilink("[[  dpao  |  DPAO  ]]")).toEqual({ slug: "dpao", label: "DPAO" })
  })

  it("keeps pipe characters inside the alias", () => {
    expect(unwrapWikilink("[[dpao|a|b]]")).toEqual({ slug: "dpao", label: "a|b" })
  })
})

describe("findInTreeByName", () => {
  const tree: FileNode[] = [
    dir("wiki", "/P/wiki", [
      dir("entities", "/P/wiki/entities", [
        file("dpao.md", "/P/wiki/entities/dpao.md"),
        dir("empty", "/P/wiki/entities/empty", []),
        // a directory without a children property at all
        { name: "bare", path: "/P/wiki/entities/bare", is_dir: true },
      ]),
      file("index.md", "/P/wiki/index.md"),
      file("notes.txt", "/P/wiki/notes.txt"),
    ]),
  ]

  it("finds the first file whose name matches and path contains the marker", () => {
    expect(findInTreeByName(tree, "dpao.md", "/P/wiki/")).toBe("/P/wiki/entities/dpao.md")
  })

  it("skips matches whose path does not contain the marker", () => {
    const withRaw = [...tree, file("dpao.md", "/P/raw/sources/dpao.md")]
    expect(findInTreeByName(withRaw, "dpao.md", "/P/wiki/")).toBe("/P/wiki/entities/dpao.md")
  })

  it("returns null when the marker excludes every match", () => {
    expect(findInTreeByName(tree, "dpao.md", "/P/raw/")).toBeNull()
  })

  it("returns null when the name is missing entirely", () => {
    expect(findInTreeByName(tree, "ghost.md", "/P/wiki/")).toBeNull()
  })

  it("returns null for an empty tree", () => {
    expect(findInTreeByName([], "x.md", "/")).toBeNull()
  })

  it("matches a file directly at the root", () => {
    expect(findInTreeByName([file("index.md", "/P/wiki/index.md")], "index.md", "/P/wiki/")).toBe(
      "/P/wiki/index.md",
    )
  })
})

describe("resolveRelatedSlug", () => {
  const tree: FileNode[] = [
    dir("wiki", "/P/wiki", [
      dir("entities", "/P/wiki/entities", [file("dpao.md", "/P/wiki/entities/dpao.md")]),
      dir("sources", "/P/wiki/sources", [file("dpao.md", "/P/wiki/sources/dpao.md")]),
    ]),
    dir("raw", "/P/raw", [
      dir("sources", "/P/raw/sources", [file("dpao.md", "/P/raw/sources/dpao.md")]),
    ]),
  ]

  it("resolves a project-relative path within wiki/", () => {
    expect(resolveRelatedSlug(tree, "wiki/entities/dpao.md", "/P/wiki")).toBe(
      "/P/wiki/entities/dpao.md",
    )
  })

  it("returns null for a path-like ref that resolves outside wiki/", () => {
    expect(resolveRelatedSlug(tree, "raw/sources/dpao.md", "/P/wiki")).toBeNull()
  })

  it("returns null when a path-like ref does not exist", () => {
    expect(resolveRelatedSlug(tree, "wiki/entities/ghost.md", "/P/wiki")).toBeNull()
  })

  it("resolves a bare filename with .md", () => {
    expect(resolveRelatedSlug(tree, "dpao.md", "/P/wiki")).toBe("/P/wiki/entities/dpao.md")
  })

  it("resolves a bare slug by appending .md", () => {
    expect(resolveRelatedSlug(tree, "dpao", "/P/wiki")).toBe("/P/wiki/entities/dpao.md")
  })

  it("returns null when no wiki/ file matches the bare slug", () => {
    expect(resolveRelatedSlug(tree, "ghost", "/P/wiki")).toBeNull()
  })
})

describe("resolveSourceName", () => {
  const tree: FileNode[] = [
    dir("wiki", "/P/wiki", [
      dir("sources", "/P/wiki/sources", [file("foo.md", "/P/wiki/sources/foo.md")]),
    ]),
    dir("raw", "/P/raw", [
      dir("sources", "/P/raw/sources", [
        file("foo.md", "/P/raw/sources/foo.md"),
        dir("year-2025", "/P/raw/sources/year-2025", [
          file("q1.pdf", "/P/raw/sources/year-2025/q1.pdf"),
        ]),
      ]),
    ]),
  ]
  const sourcesRoot = "/P/raw/sources"

  it("resolves a project-relative path directly", () => {
    expect(resolveSourceName(tree, "raw/sources/year-2025/q1.pdf", sourcesRoot)).toBe(
      "/P/raw/sources/year-2025/q1.pdf",
    )
    expect(resolveSourceName(tree, "wiki/sources/foo.md", sourcesRoot)).toBe(
      "/P/wiki/sources/foo.md",
    )
  })

  it("returns null for a path-like ref that does not exist", () => {
    expect(resolveSourceName(tree, "raw/sources/ghost.pdf", sourcesRoot)).toBeNull()
  })

  it("prefers wiki/sources/ for a bare .md filename, then falls back to raw/sources/", () => {
    expect(resolveSourceName(tree, "foo.md", sourcesRoot)).toBe("/P/wiki/sources/foo.md")
  })

  it("falls back to raw/sources/ when the bare .md is not in wiki/sources", () => {
    const onlyRaw = [dir("raw", "/P/raw", [dir("sources", "/P/raw/sources", [file("bar.md", "/P/raw/sources/bar.md")])])]
    expect(resolveSourceName(onlyRaw, "bar.md", sourcesRoot)).toBe("/P/raw/sources/bar.md")
  })

  it("searches raw/sources/ for a bare non-md filename", () => {
    expect(resolveSourceName(tree, "q1.pdf", sourcesRoot)).toBe(
      "/P/raw/sources/year-2025/q1.pdf",
    )
  })

  it("returns null when nothing matches", () => {
    expect(resolveSourceName(tree, "ghost.pdf", sourcesRoot)).toBeNull()
  })
})
