// @vitest-environment jsdom

import { StrictMode } from "react"
import { cleanup } from "@testing-library/react"
import { render } from "@/test-helpers/component-test-utils"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const deps = vi.hoisted(() => ({
  configureMonaco: vi.fn(),
}))

// 隔离 Monaco worker / loader：configureMonaco 在 jsdom 下无需真实初始化
vi.mock("@/lib/novel/monaco-loader", () => ({
  configureMonaco: deps.configureMonaco,
}))

// mock @monaco-editor/react：DiffEditor 捕获 props，loader 提供 no-op config
const mockDiffEditor = vi.fn((_props: Record<string, unknown>) => null)
vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: Record<string, unknown>) => mockDiffEditor(props),
  loader: { config: vi.fn() },
}))

import { MonacoDiffEditor } from "./monaco-diff-editor"

describe("MonacoDiffEditor (RPC-2 / TASK-004)", () => {
  beforeEach(() => {
    mockDiffEditor.mockClear()
    deps.configureMonaco.mockClear()
  })

  afterEach(() => cleanup())

  it("render 不抛错，且 original/modified 透传给 DiffEditor（默认 markdown 语言）", () => {
    expect(() =>
      renderToStaticMarkup(
        <MonacoDiffEditor original="原文片段" modified="改写片段" />,
      ),
    ).not.toThrow()
    expect(mockDiffEditor).toHaveBeenCalledTimes(1)
    const callProps = mockDiffEditor.mock.calls[0][0] as Record<string, unknown>
    expect(callProps.original).toBe("原文片段")
    expect(callProps.modified).toBe("改写片段")
    expect(callProps.language).toBe("markdown")
  })

  it("透传 height / readOnly，且 options.renderSideBySide=true", () => {
    renderToStaticMarkup(
      <MonacoDiffEditor original="a" modified="b" height={300} readOnly />,
    )
    const callProps = mockDiffEditor.mock.calls[0][0] as Record<string, unknown>
    expect(callProps.height).toBe(300)
    const options = callProps.options as Record<string, unknown>
    expect(options.renderSideBySide).toBe(true)
    expect(options.readOnly).toBe(true)
  })

  it("configures Monaco and forwards modified editor changes", () => {
    const onModifiedChange = vi.fn()
    const { rerender } = render(<StrictMode><MonacoDiffEditor original="a" modified="b" onModifiedChange={onModifiedChange} /></StrictMode>)

    expect(deps.configureMonaco).toHaveBeenCalledTimes(1)
    rerender(<StrictMode><MonacoDiffEditor original="c" modified="d" onModifiedChange={onModifiedChange} /></StrictMode>)
    expect(deps.configureMonaco).toHaveBeenCalledTimes(1)
    const onMount = mockDiffEditor.mock.calls[1][0].onMount as (editor: unknown) => void
    let contentListener!: () => void
    const modifiedEditor = {
      onDidChangeModelContent: (listener: () => void) => { contentListener = listener },
      getValue: () => "changed",
    }
    onMount({ getModifiedEditor: () => modifiedEditor })
    contentListener()
    expect(onModifiedChange).toHaveBeenCalledWith("changed")
  })

  it("does not throw when modified change callback is omitted", () => {
    render(<MonacoDiffEditor original="a" modified="b" />)
    const onMount = mockDiffEditor.mock.calls[0][0].onMount as (editor: unknown) => void
    let contentListener!: () => void
    const modifiedEditor = {
      onDidChangeModelContent: (listener: () => void) => { contentListener = listener },
      getValue: () => "changed",
    }
    onMount({ getModifiedEditor: () => modifiedEditor })
    expect(() => contentListener()).not.toThrow()
  })
})
