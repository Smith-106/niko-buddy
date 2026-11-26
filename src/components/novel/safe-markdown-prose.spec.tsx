// @vitest-environment jsdom
// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen } from "@/test-helpers/component-test-utils"

const mocks = vi.hoisted(() => ({
  forceThrow: false,
}))

vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>()
  const RealMarkdown = actual.default
  return {
    ...actual,
    default: function MockableReactMarkdown(props: Parameters<typeof RealMarkdown>[0]) {
      if (mocks.forceThrow) {
        throw new Error("Simulated markdown render crash")
      }
      return <RealMarkdown {...props} />
    },
  }
})

import { SafeMarkdownProse, sanitizeMarkdownUrl } from "./safe-markdown-prose"

describe("sanitizeMarkdownUrl", () => {
  it("allows http, https, mailto, hash fragments, and relative URLs", () => {
    expect(sanitizeMarkdownUrl("https://example.com/docs")).toBe("https://example.com/docs")
    expect(sanitizeMarkdownUrl("http://127.0.0.1:45871/mcp")).toBe("http://127.0.0.1:45871/mcp")
    expect(sanitizeMarkdownUrl("mailto:author@example.com")).toBe("mailto:author@example.com")
    expect(sanitizeMarkdownUrl("#chapter-3")).toBe("#chapter-3")
    expect(sanitizeMarkdownUrl("/wiki/chapters/ch01.md")).toBe("/wiki/chapters/ch01.md")
    expect(sanitizeMarkdownUrl("./ch02.md")).toBe("./ch02.md")
    expect(sanitizeMarkdownUrl("../outline.md")).toBe("../outline.md")
    expect(sanitizeMarkdownUrl("chapters/ch03.md")).toBe("chapters/ch03.md")
  })

  it("blocks javascript:, vbscript:, data:, protocol-relative (including backslash variants), mailto on images, and obfuscated schemes", () => {
    expect(sanitizeMarkdownUrl("javascript:alert(1)")).toBe("")
    expect(sanitizeMarkdownUrl("JaVaScRiPt:alert(1)")).toBe("")
    expect(sanitizeMarkdownUrl("java\tscript:alert(1)")).toBe("")
    expect(sanitizeMarkdownUrl("  java\nscript:alert(1)")).toBe("")
    expect(sanitizeMarkdownUrl("vbscript:msgbox(1)")).toBe("")
    expect(sanitizeMarkdownUrl("data:text/html,<script>alert(1)</script>")).toBe("")
    expect(sanitizeMarkdownUrl("DATA:image/svg+xml;base64,PHN2Zz4=")).toBe("")
    expect(sanitizeMarkdownUrl("file:///etc/passwd")).toBe("")
    expect(sanitizeMarkdownUrl("//evil.example/payload")).toBe("")
    expect(sanitizeMarkdownUrl("/\\evil.example/payload")).toBe("")
    expect(sanitizeMarkdownUrl("\\/evil.example/payload")).toBe("")
    expect(sanitizeMarkdownUrl("\\\\evil.example/payload")).toBe("")
    expect(sanitizeMarkdownUrl("\\evil.example/payload")).toBe("")
    expect(sanitizeMarkdownUrl("/%5Cevil.example/payload")).toBe("")
    expect(sanitizeMarkdownUrl("%5C/evil.example/payload")).toBe("")
    expect(sanitizeMarkdownUrl("%5C%5Cevil.example/payload")).toBe("")
    expect(sanitizeMarkdownUrl("mailto:author@example.com", true)).toBe("mailto:author@example.com")
    expect(sanitizeMarkdownUrl("mailto:author@example.com", false)).toBe("")
    expect(sanitizeMarkdownUrl("")).toBe("")
    expect(sanitizeMarkdownUrl(null)).toBe("")
  })
})

describe("SafeMarkdownProse", () => {
  beforeEach(() => {
    mocks.forceThrow = false
  })

  afterEach(() => {
    mocks.forceThrow = false
    cleanup()
  })

  it("renders headings, lists, blockquotes, tables, code blocks, and hr with Tailwind styling", () => {
    const markdown = [
      "# 第一章 风起",
      "## 场次一",
      "### 细节提示",
      "#### 附注",
      "",
      "正文段落包含 `inlineCode` 标记。",
      "",
      "- 要点甲",
      "- 要点乙",
      "",
      "1. 第一步",
      "2. 第二步",
      "",
      "> 门控优先级：Consistency > Anti-AI > Quality",
      "",
      "---",
      "",
      "```ts",
      "const chapter = 3",
      "```",
      "",
      "| 角色 | 状态 |",
      "| --- | --- |",
      "| 林川 | 潜行中 |",
    ].join("\n")

    const { container } = render(<SafeMarkdownProse content={markdown} />)

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("第一章 风起")
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("场次一")
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("细节提示")
    expect(screen.getByRole("heading", { level: 4 })).toHaveTextContent("附注")
    expect(container.querySelector("ul li")).toHaveTextContent("要点甲")
    expect(container.querySelector("ol li")).toHaveTextContent("第一步")
    expect(container.querySelector("blockquote")).toHaveTextContent("Consistency > Anti-AI > Quality")
    expect(container.querySelector("hr")).not.toBeNull()
    expect(container.querySelector("pre code")).toHaveTextContent("const chapter = 3")
    expect(container.querySelector("table th")).toHaveTextContent("角色")
    expect(container.querySelector("table td")).toHaveTextContent("林川")
  })

  it("escapes raw HTML without injecting script, img onerror, or iframe nodes", () => {
    const payload = [
      '<script>alert("xss")</script>',
      '<img src="x" onerror="alert(2)">',
      '<iframe src="https://evil.example"></iframe>',
    ].join("\n\n")

    const { container } = render(<SafeMarkdownProse content={payload} />)

    expect(container.querySelector("script")).toBeNull()
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("iframe")).toBeNull()
    expect(container.querySelector("[onerror]")).toBeNull()
    expect(container.textContent).toContain('<script>alert("xss")</script>')
  })

  it("blocks javascript:, vbscript:, and data: links while keeping safe https/mailto/hash links", () => {
    const markdown = [
      "[bad-js](javascript:alert(1))",
      "[bad-vb](vbscript:msgbox(1))",
      "[bad-data](data:text/html,<script>alert(1)</script>)",
      "[good-https](https://example.com/guide)",
      "[good-mail](mailto:writer@example.com)",
      "[good-hash](#section-2)",
    ].join(" ")

    const { container } = render(<SafeMarkdownProse content={markdown} />)

    expect(container.querySelector('a[href*="javascript"]')).toBeNull()
    expect(container.querySelector('a[href*="vbscript"]')).toBeNull()
    expect(container.querySelector('a[href*="data:"]')).toBeNull()

    const blockedSpans = container.querySelectorAll('[data-unsafe-href="blocked"]')
    expect(blockedSpans).toHaveLength(3)
    expect(blockedSpans[0]).toHaveTextContent("bad-js")
    expect(blockedSpans[1]).toHaveTextContent("bad-vb")
    expect(blockedSpans[2]).toHaveTextContent("bad-data")

    const httpsLink = screen.getByRole("link", { name: "good-https" })
    expect(httpsLink).toHaveAttribute("href", "https://example.com/guide")
    expect(httpsLink).toHaveAttribute("target", "_blank")
    expect(httpsLink).toHaveAttribute("rel", "noopener noreferrer")

    expect(screen.getByRole("link", { name: "good-mail" })).toHaveAttribute(
      "href",
      "mailto:writer@example.com",
    )
    expect(screen.getByRole("link", { name: "good-hash" })).toHaveAttribute("href", "#section-2")
  })

  it("blocks backslash protocol-relative links/images and mailto: images in rendered Markdown", () => {
    const markdown = [
      String.raw`[bs-slash](/\evil.example)`,
      String.raw`[slash-bs](\\/evil.example)`,
      String.raw`[double-bs](\\\\evil.example)`,
      String.raw`![img-bs-slash](/\evil.example/a.png)`,
      String.raw`![img-slash-bs](\\/evil.example/b.png)`,
      String.raw`![img-double-bs](\\\\evil.example/c.png)`,
      "![img-mailto](mailto:writer@example.com)",
    ].join("\n\n")

    const { container } = render(<SafeMarkdownProse content={markdown} />)

    expect(container.querySelectorAll("a")).toHaveLength(0)
    expect(container.querySelectorAll("img")).toHaveLength(0)
    expect(container.querySelectorAll('[data-unsafe-href="blocked"]')).toHaveLength(3)
    expect(container.querySelectorAll('[data-unsafe-src="blocked"]')).toHaveLength(4)
  })

  it("falls back cleanly to whitespace-pre-wrap plain text via ErrorBoundary on render error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.forceThrow = true

    const { rerender } = render(<SafeMarkdownProse content={"Line 1\nLine 2 fallback"} />)
    const fallback = screen.getByTestId("safe-markdown-fallback")
    expect(fallback).toHaveClass("whitespace-pre-wrap")
    expect(fallback.textContent).toBe("Line 1\nLine 2 fallback")

    // When content changes and renderer succeeds again, ErrorBoundary recovers cleanly.
    mocks.forceThrow = false
    rerender(<SafeMarkdownProse content="# Recovered Heading" />)
    expect(screen.queryByTestId("safe-markdown-fallback")).toBeNull()
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Recovered Heading")

    errorSpy.mockRestore()
  })
})
