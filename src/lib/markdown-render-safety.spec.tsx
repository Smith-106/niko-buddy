// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest"
import { cleanup, render } from "@testing-library/react"
import ReactMarkdown from "react-markdown"
import { sharedRehypePlugins, sharedRemarkPlugins } from "@/lib/markdown-image-resolver"
import { transformWikilinks } from "@/lib/wikilink-transform"

// CWE-915 lockdown: wiki markdown render chain (FilePreview TextPreview,
// WikiReader, chat MarkdownContent) shares `sharedRemarkPlugins` /
// `sharedRehypePlugins` with NO rehype-raw, plus react-markdown's
// defaultUrlTransform (allowlist: http/https/irc/mailto/xmpp). These tests
// prove LLM-merged markdown hitting disk is inert at render time:
// raw HTML is escaped as text and javascript: URLs are stripped.
// If this file starts failing, the render chain changed — do NOT paper
// over it in ingest; stop and reassess (fail-closed).

function renderShared(md: string): HTMLElement {
  cleanup()
  const { container } = render(
    <ReactMarkdown remarkPlugins={sharedRemarkPlugins} rehypePlugins={sharedRehypePlugins}>
      {md}
    </ReactMarkdown>,
  )
  return container
}

afterEach(() => {
  cleanup()
})

describe("markdown render safety — CWE-915", () => {
  it("escapes <script> instead of creating a script element", () => {
    const container = renderShared(`<script>alert(1)</script>`)
    expect(container.querySelector("script")).toBeNull()
    expect(container.innerHTML).not.toContain("<script")
    expect(container.innerHTML).toContain("&lt;script")
  })

  it("escapes <img onerror=> instead of creating an image with a handler", () => {
    const container = renderShared(`<img src="x" onerror="alert(1)">`)
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("[onerror]")).toBeNull()
    expect(container.innerHTML).not.toContain("<img")
  })

  it("strips a javascript: link href (no executable URL)", () => {
    const container = renderShared(`[click](javascript:alert(1))`)
    expect(container.querySelector('a[href*="javascript"]')).toBeNull()
    expect(container.innerHTML).not.toContain("javascript:")
    const anchor = container.querySelector("a")
    expect(anchor).not.toBeNull()
    // defaultUrlTransform blanks disallowed protocols.
    expect(anchor?.getAttribute("href")).toBe("")
  })

  it("strips a mixed-case javascript: link href", () => {
    const container = renderShared(`[click](JaVaScRiPt:alert(1))`)
    expect(container.querySelector('a[href*="javascript"]')).toBeNull()
    expect(container.innerHTML.toLowerCase()).not.toContain("javascript:")
  })

  it("keeps a normal https link working (no over-sanitization)", () => {
    const container = renderShared(`[docs](https://example.com)`)
    const anchor = container.querySelector("a")
    expect(anchor?.getAttribute("href")).toBe("https://example.com")
    expect(anchor?.textContent).toBe("docs")
  })

  it("neutralizes a wikilink breakout: trailing ]] stays text, no javascript: href", () => {
    const transformed = transformWikilinks(`[[a]] ]] [[b]]`)
    const container = renderShared(transformed)
    expect(container.querySelector('a[href*="javascript"]')).toBeNull()
    expect(container.innerHTML).not.toContain("javascript:")
    // Both wikilinks still render as safe fragment links.
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    expect(hrefs).toContain("#a")
    expect(hrefs).toContain("#b")
    expect(container.textContent).toContain("]]")
  })

  it("neutralizes a wikilink label smuggling a javascript: URL", () => {
    const transformed = transformWikilinks(`[[foo|bar]](javascript:alert(1))`)
    const container = renderShared(transformed)
    expect(container.querySelector('a[href*="javascript"]')).toBeNull()
    // The smuggled payload degrades to trailing *text* — it must not
    // become a link href. Checking href attributes only: text content
    // containing the literal string is inert.
    expect(container.innerHTML).not.toContain('href="javascript')
    expect(container.innerHTML.toLowerCase()).not.toContain("href=\"javascript")
    // The wikilink itself survives as a fragment link; the smuggled
    // payload degrades to trailing text.
    expect(container.querySelector('a[href="#foo"]')?.textContent).toBe("bar")
  })
})
