// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import { act, render, waitFor } from "@testing-library/react"
import { Editor, EditorStatus, defaultValueCtx, editorViewCtx, schemaCtx, serializerCtx } from "@milkdown/kit/core"
import { listenerCtx } from "@milkdown/kit/plugin/listener"
import { DOMSerializer } from "@milkdown/kit/prose/model"
import { replaceAll } from "@milkdown/kit/utils"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  convertFileSrc: vi.fn((p: string) => `asset://${p}`),
  invoke: vi.fn(async (command: string) => { throw new Error(`native fixture boundary: ${command}`) }),
  editor: undefined as Editor | undefined,
  markdownEmits: [] as string[],
}))

vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>()
  return {
    ...actual,
      isTauri: mocks.isTauri,
    
  }
})

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mocks.convertFileSrc,
  invoke: mocks.invoke,
  isTauri: () => false,
}))

vi.mock("@milkdown/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@milkdown/react")>()
  return {
    ...actual,
    // 委托真实 Hook 和 Editor，仅增加 emit 观察器，不替换数学插件或渲染逻辑。
    useEditor: (factory: Parameters<typeof actual.useEditor>[0], deps?: Parameters<typeof actual.useEditor>[1]) =>
      actual.useEditor((root) => {
        const editor = factory(root)
        if (editor instanceof Editor) {
          mocks.editor = editor
          editor.config((ctx) => {
            ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => { mocks.markdownEmits.push(markdown) })
          })
        }
        return editor
      }, deps),
  }
})

import {
  resolveMarkdownImageSrc,
  resolveMarkdownImageSrcAsync,
  sharedRemarkPlugins,
  sharedRehypePlugins,
} from "./markdown-image-resolver"
import { getCopyableAssistantContent } from "./chat-copy-content"
import { WikiEditor } from "@/components/editor/wiki-editor"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.editor = undefined
  mocks.markdownEmits.length = 0
})

describe("resolveMarkdownImageSrc", () => {
  it("returns empty source unchanged", () => {
    expect(resolveMarkdownImageSrc("", "/p")).toBe("")
  })

  it("passes through external and data URIs", () => {
    expect(resolveMarkdownImageSrc("https://x/y.png", "/p")).toBe("https://x/y.png")
    expect(resolveMarkdownImageSrc("data:image/png;base64,abc", "/p")).toBe("data:image/png;base64,abc")
    expect(resolveMarkdownImageSrc("blob:http://x/1", "/p")).toBe("blob:http://x/1")
    expect(resolveMarkdownImageSrc("file:///tmp/x.png", "/p")).toBe("file:///tmp/x.png")
    expect(resolveMarkdownImageSrc("tauri://local/x.png", "/p")).toBe("tauri://local/x.png")
  })

  it("returns the source unchanged without a project", () => {
    expect(resolveMarkdownImageSrc("a.png", null)).toBe("a.png")
  })

  it("returns the source unchanged outside tauri", () => {
    mocks.isTauri.mockReturnValue(false)
    expect(resolveMarkdownImageSrc("a.png", "/p")).toBe("a.png")
  })

  it("converts absolute paths directly", () => {
    mocks.isTauri.mockReturnValue(true)
    expect(resolveMarkdownImageSrc("/abs/x.png", "/p")).toBe("asset:///abs/x.png")
    expect(resolveMarkdownImageSrc("C:\\img\\x.png", "/p")).toBe("asset://C:\\img\\x.png")
    expect(resolveMarkdownImageSrc("\\\\server\\share\\x.png", "/p")).toBe("asset://\\\\server\\share\\x.png")
  })

  it("joins wiki-relative paths under the project wiki root and strips ./", () => {
    mocks.isTauri.mockReturnValue(true)
    expect(resolveMarkdownImageSrc("media/a/img-1.png", "/p")).toBe("asset:///p/wiki/media/a/img-1.png")
    expect(resolveMarkdownImageSrc("./media/b.png", "C:\\proj")).toBe("asset://C:/proj/wiki/media/b.png")
    expect(mocks.convertFileSrc).toHaveBeenCalledWith("C:/proj/wiki/media/b.png")
  })
})

describe("resolveMarkdownImageSrcAsync", () => {
  it("mirrors the sync behavior with the same early returns", async () => {
    mocks.isTauri.mockReturnValue(false)
    await expect(resolveMarkdownImageSrcAsync("x.png", "/p")).resolves.toBe("x.png")
    await expect(resolveMarkdownImageSrcAsync("x.png", null)).resolves.toBe("x.png")
    await expect(resolveMarkdownImageSrcAsync("https://x/y.png", null)).resolves.toBe("https://x/y.png")
    await expect(resolveMarkdownImageSrcAsync("", "/p")).resolves.toBe("")
    mocks.isTauri.mockReturnValue(true)
    await expect(resolveMarkdownImageSrcAsync("media/c.png", "/p")).resolves.toBe("asset:///p/wiki/media/c.png")
    await expect(resolveMarkdownImageSrcAsync("/abs/d.png", "/p")).resolves.toBe("asset:///abs/d.png")
  })
})

describe("真实数学依赖集成", () => {
  const markdown = "Inline $x^2$.\n\n$$\nx^2\n$$"
  const renderMarkdown = (source: string) => renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: sharedRemarkPlugins,
    rehypePlugins: sharedRehypePlugins,
    children: source,
  }))
  const parseHtml = (html: string) => new DOMParser().parseFromString(html, "text/html")

  it("共享实际插件渲染 inline/block、错误 fallback 与不可信 URL", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network fixture boundary"))
    try {
      const normal = parseHtml(renderMarkdown(markdown))
      expect(normal.querySelectorAll(".katex")).toHaveLength(2)
      expect(normal.querySelector(".katex-display")).not.toBeNull()
      const unsupported = parseHtml(renderMarkdown(String.raw`$\notAFunction{x}$`))
      expect(unsupported.querySelector(".katex")).not.toBeNull()
      expect(unsupported.body.textContent).toContain("\\notAFunction")
      const bad = parseHtml(renderMarkdown(String.raw`$\frac{a}$`))
      expect(bad.querySelector(".katex-error")).not.toBeNull()
      expect(bad.querySelector(".katex-error")?.textContent).toContain("\\frac{a}")
      const unsafe = parseHtml(renderMarkdown(String.raw`$\href{javascript:alert(1)}{x}$`))
      expect(unsafe.querySelector('script, iframe, img, [href^="javascript:"], [onerror], [onclick]')).toBeNull()
      expect(fetch).not.toHaveBeenCalled()
      console.info("M2-INTEGRATION", JSON.stringify({ probe: "shared", status: "verified", inline: true, block: true, fallback: true, unsafeUrlBlocked: true }))
    } finally {
      fetch.mockRestore()
    }
  })

  it("真实 WikiEditor 数学 NodeSchema 与序列化挂载不保存且首笔与后续编辑保存", async () => {
    const onSave = vi.fn()
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network fixture boundary"))
    const mounted = render(createElement(WikiEditor, { content: markdown, onSave, defaultMode: "edit" }))
    let editor: Editor | undefined
    try {
      await waitFor(() => expect(mocks.editor?.status).toBe(EditorStatus.Created))
      editor = mocks.editor
      if (!editor) throw new Error("real Milkdown Editor was not created")
      const realEditor = editor
      const mountMarkdownEmitCount = mocks.markdownEmits.length
      const mountSaveCount = onSave.mock.calls.length
      expect(mountMarkdownEmitCount).toBe(0)
      expect(onSave).not.toHaveBeenCalled()
      expect(realEditor.action((ctx) => ctx.get(defaultValueCtx))).toBe(markdown)
      expect(mounted.container.querySelector('[data-type="math_inline"] .katex')).not.toBeNull()
      expect(mounted.container.querySelector('[data-type="math_block"] .katex')).not.toBeNull()
      await act(async () => {
        realEditor.action(replaceAll(markdown + "\n\nHydrated fixture.", true))
      })
      expect(onSave).not.toHaveBeenCalled()
      expect(mocks.markdownEmits).toHaveLength(0)
      const serialized = realEditor.action((ctx) => {
        const schema = ctx.get(schemaCtx)
        const inline = schema.nodes.math_inline.create(null, schema.text("y^2"))
        const block = schema.nodes.math_block.create({ value: "y^2" })
        const inlineDom = DOMSerializer.fromSchema(schema).serializeNode(inline)
        const blockDom = DOMSerializer.fromSchema(schema).serializeNode(block)
        expect(inlineDom instanceof HTMLElement && inlineDom.querySelector(".katex")).toBeTruthy()
        expect(blockDom instanceof HTMLElement && blockDom.querySelector(".katex")).toBeTruthy()
        const view = ctx.get(editorViewCtx)
        const source = ctx.get(serializerCtx)(view.state.doc)
        return source
      })
      expect(serialized).toContain("$x^2$")
      expect(serialized).toContain("$$")
      expect(serialized).toContain("Hydrated fixture.")
      await act(async () => {
        realEditor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          view.dispatch(view.state.tr.insertText("edited ", 1))
        })
      })
      await waitFor(() => expect(mocks.markdownEmits).toHaveLength(1))
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
      const firstEditSaveCount = onSave.mock.calls.length
      expect(onSave.mock.calls[0][0]).toContain("edited ")
      expect(onSave.mock.calls[0][0]).toContain("$x^2$")
      await act(async () => {
        realEditor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          view.dispatch(view.state.tr.insertText("second ", 1))
        })
      })
      await waitFor(() => expect(mocks.markdownEmits).toHaveLength(2))
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
      const subsequentEditSaveCount = onSave.mock.calls.length
      expect(onSave.mock.calls[1][0]).toContain("second edited ")
      expect(onSave.mock.calls[1][0]).toContain("$x^2$")
      const switchedOnSave = vi.fn()
      mounted.rerender(createElement(WikiEditor, { key: "other-document", content: "Switched $z^2$.", onSave: switchedOnSave, defaultMode: "edit" }))
      await waitFor(() => {
        expect(mocks.editor).not.toBe(realEditor)
        expect(mocks.editor?.status).toBe(EditorStatus.Created)
      })
      const switchedEditor = mocks.editor
      if (!switchedEditor) throw new Error("switched real Milkdown Editor was not created")
      editor = switchedEditor
      await waitFor(() => expect(realEditor.status).toBe(EditorStatus.Destroyed))
      expect(switchedOnSave).not.toHaveBeenCalled()
      expect(mocks.markdownEmits).toHaveLength(2)
      const switchedMountSaveCount = switchedOnSave.mock.calls.length
      await act(async () => {
        switchedEditor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          view.dispatch(view.state.tr.insertText("next edit ", 1))
        })
      })
      await waitFor(() => expect(switchedOnSave).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(mocks.markdownEmits).toHaveLength(3))
      const switchedFirstEditSaveCount = switchedOnSave.mock.calls.length
      expect(switchedOnSave.mock.calls[0][0]).toContain("next edit ")
      expect(switchedOnSave.mock.calls[0][0]).toContain("$z^2$")
      expect(onSave).toHaveBeenCalledTimes(2)
      expect(fetch).not.toHaveBeenCalled()
      expect(mocks.invoke).not.toHaveBeenCalled()
      console.info("M2-INTEGRATION", JSON.stringify({ probe: "milkdown", status: "verified", realNodeSchema: true, serialized: true, defaultValuePreserved: true, mountMarkdownEmitCount, mountSaveCount, firstEditSaveCount, subsequentEditSaveCount, switchedMountSaveCount, switchedFirstEditSaveCount }))
    } finally {
      mounted.unmount()
      if (editor) await waitFor(() => expect(editor?.status).toBe(EditorStatus.Destroyed))
      fetch.mockRestore()
    }
  })

  it("执行实际 Mermaid 动态数学与 DOMPurify sanitize 分支并记录能力", async () => {
    const moduleUrl = pathToFileURL(resolve(process.cwd(), "node_modules/mermaid/dist/chunks/mermaid.core/chunk-DU6HZSFF.mjs"))
    expect(moduleUrl.protocol).toBe("file:")
    const module: unknown = await import(moduleUrl.href)
    if (typeof module !== "object" || module === null || !("renderKatexSanitized" in module) || typeof module.renderKatexSanitized !== "function") {
      throw new Error("actual Mermaid renderKatexSanitized export unavailable")
    }
    const config = { securityLevel: "strict", htmlLabels: true }
    const mathMLElementSupported = "MathMLElement" in window && window.MathMLElement !== undefined
    const productionOutput: unknown = await module.renderKatexSanitized("$$x^2$$", config)
    if (typeof productionOutput !== "string") throw new Error("actual Mermaid math output must be text")
    if (mathMLElementSupported) {
      expect(parseHtml(productionOutput).querySelector("math")).not.toBeNull()
    } else {
      expect(productionOutput).toContain("MathML is unsupported in this environment.")
    }
    const legacyFixtureConfig = { ...config, forceLegacyMathML: true }
    const normal: unknown = await module.renderKatexSanitized("$$x^2$$", legacyFixtureConfig)
    const unsafe: unknown = await module.renderKatexSanitized(String.raw`<script>throw new Error('fixture')</script>$$\href{javascript:alert(1)}{x}$$`, legacyFixtureConfig)
    if (typeof normal !== "string" || typeof unsafe !== "string") throw new Error("actual Mermaid math output must be text")
    expect(parseHtml(normal).querySelector(".katex")).not.toBeNull()
    expect(parseHtml(normal).querySelector("math")).not.toBeNull()
    expect(parseHtml(unsafe).querySelector('script, [href^="javascript:"], [onerror], [onclick]')).toBeNull()
    console.info("M2-INTEGRATION", JSON.stringify({ probe: "mermaid", status: "verified_finite_legacy_math_and_sanitize", dynamicKatex: true, actualDomPurify: true, securityLevel: "strict", mathMLElementSupported, forceLegacyMathMLFixtureOnly: true, applicationSvgInjectionVerified: false, visualQA: false }))
  })

  it("真实复制 helper 将原 TeX 交给隔离 clipboard 边界", async () => {
    const clipboard = { writeText: vi.fn(async (_text: string) => {}) }
    const html = renderMarkdown(markdown)
    expect(html).toContain("katex")
    await clipboard.writeText(getCopyableAssistantContent(markdown))
    expect(clipboard.writeText).toHaveBeenCalledWith(markdown)
    expect(clipboard.writeText.mock.calls[0][0]).not.toBe(html)
    console.info("M2-INTEGRATION", JSON.stringify({ probe: "copy-assets", status: "verified", originalTexPreserved: true, actualClipboardUsed: false, assetsReusedFromD3: true, visualQA: false }))
  })
})
