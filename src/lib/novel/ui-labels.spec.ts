import { describe, expect, it, vi, beforeEach } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

const tMock = vi.fn((key: string) => `trans:${key}`)
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => tMock(key) }),
}))

const storeState = { novelMode: true }
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

import { useNovelLabel, useNovelMode } from "./ui-labels"

function ProbeLabel() {
  const label = useNovelLabel("common.original", "common.novel")
  return React.createElement("span", null, label)
}

function ProbeMode() {
  const mode = useNovelMode()
  return React.createElement("span", null, String(mode))
}

describe("ui-labels hooks", () => {
  beforeEach(() => {
    tMock.mockClear()
  })

  it("useNovelLabel returns novel key translation in novel mode", () => {
    storeState.novelMode = true
    const html = renderToStaticMarkup(React.createElement(ProbeLabel))
    expect(html).toContain("trans:common.novel")
    expect(tMock).toHaveBeenCalledWith("common.novel")
    expect(tMock).not.toHaveBeenCalledWith("common.original")
  })

  it("useNovelLabel returns original key translation outside novel mode", () => {
    storeState.novelMode = false
    const html = renderToStaticMarkup(React.createElement(ProbeLabel))
    expect(html).toContain("trans:common.original")
    expect(tMock).toHaveBeenCalledWith("common.original")
  })

  it("useNovelMode reflects current novelMode", () => {
    storeState.novelMode = true
    expect(renderToStaticMarkup(React.createElement(ProbeMode))).toContain("true")
    storeState.novelMode = false
    expect(renderToStaticMarkup(React.createElement(ProbeMode))).toContain("false")
  })
})
