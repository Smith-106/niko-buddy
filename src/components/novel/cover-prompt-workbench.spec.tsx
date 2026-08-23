// @vitest-environment jsdom
/**
 * CoverPromptWorkbench — 封面 Prompt 工作台（F-012）。
 * 覆盖：平台选择、模板加载（默认 config 导入）、Prompt 生成占位符替换、
 * 一键复制、空模板优雅降级、非法条目过滤。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import type { CoverPlatformTemplate } from "./cover-prompt-workbench"

const tMock = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock.t }),
}))

import {
  CoverPromptWorkbench,
  buildCoverPrompt,
  normalizeCoverPlatforms,
} from "./cover-prompt-workbench"

const TEMPLATES: CoverPlatformTemplate[] = [
  {
    platform: "番茄",
    style: "高饱和度竖版网文封面",
    dimensions: { width: 600, height: 800 },
    promptTemplate: "为《{{title}}》设计{{platform}}封面：{{style}}，{{width}}x{{height}}，题材 {{genre}}，氛围 {{keywords}}。",
  },
  {
    platform: "起点",
    style: "写实国风插画",
    dimensions: { width: 600, height: 800 },
    promptTemplate: "{{platform}}封面：《{{title}}》",
  },
]

const clipboard = vi.hoisted(() => ({
  writeText: vi.fn<(text: string) => Promise<void>>(async () => {}),
}))

beforeEach(() => {
  vi.clearAllMocks()
  clipboard.writeText.mockResolvedValue(undefined)
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: clipboard,
    configurable: true,
    writable: true,
  })
})

afterEach(() => cleanup())

describe("CoverPromptWorkbench", () => {
  it("renders platform buttons from the default externalized config", () => {
    render(<CoverPromptWorkbench />)
    // 默认 config 含番茄/起点/晋江三平台
    for (const platform of ["番茄", "起点", "晋江"]) {
      expect(document.querySelector(`[data-cover-platform="${platform}"]`)).toBeTruthy()
    }
    // 默认选中第一个平台并展示尺寸
    expect(document.querySelector('[data-cover-dimensions="true"]')?.textContent).toBeTruthy()
  })

  it("switching platform updates style/dimensions and regenerates the prompt", async () => {
    render(<CoverPromptWorkbench templates={TEMPLATES} />)
    fireEvent.input(document.querySelector('[data-cover-input="title"]') as HTMLElement, {
      target: { value: "测试书名" },
    })
    let preview = (document.querySelector("[data-cover-prompt-preview]") as HTMLTextAreaElement).value
    expect(preview).toContain("番茄")
    expect(preview).toContain("测试书名")

    fireEvent.click(document.querySelector('[data-cover-platform="起点"]') as HTMLElement)
    await waitFor(() => {
      preview = (document.querySelector("[data-cover-prompt-preview]") as HTMLTextAreaElement).value
      expect(preview).toContain("起点")
    })
    expect(preview).toContain("《测试书名》")
  })

  it("substitutes all placeholders (title/genre/keywords/style/dimensions)", () => {
    render(<CoverPromptWorkbench templates={TEMPLATES} />)
    fireEvent.input(document.querySelector('[data-cover-input="title"]') as HTMLElement, { target: { value: " 书名A " } })
    fireEvent.input(document.querySelector('[data-cover-input="genre"]') as HTMLElement, { target: { value: "东方玄幻" } })
    fireEvent.input(document.querySelector('[data-cover-input="keywords"]') as HTMLElement, { target: { value: "热血 逆袭" } })
    const preview = (document.querySelector("[data-cover-prompt-preview]") as HTMLTextAreaElement).value
    expect(preview).toBe(
      "为《书名A》设计番茄封面：高饱和度竖版网文封面，600x800，题材 东方玄幻，氛围 热血 逆袭。",
    )
  })

  it("copies the generated prompt to the clipboard with feedback", async () => {
    render(<CoverPromptWorkbench templates={TEMPLATES} />)
    const copyBtn = document.querySelector("[data-cover-copy]") as HTMLButtonElement
    expect(copyBtn.hasAttribute("disabled")).toBe(false)
    fireEvent.click(copyBtn)
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1))
    expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("番茄"))
    await waitFor(() => expect(screen.getByText("novel.coverWorkbench.copied")).toBeInTheDocument())
  })

  it("degrades gracefully when the template list is empty", () => {
    render(<CoverPromptWorkbench templates={[]} />)
    expect(screen.getByText("novel.coverWorkbench.emptyTemplates")).toBeInTheDocument()
    expect(document.querySelector("[data-cover-prompt-preview]")).toBeNull()
    expect(document.querySelector("[data-cover-copy]")).toBeNull()
  })

  it("filters invalid template entries via normalization", () => {
    const cleaned = normalizeCoverPlatforms({
      platforms: [
        { platform: "番茄", style: "s", dimensions: { width: 600, height: 800 }, promptTemplate: "ok" },
        { platform: "", promptTemplate: "no platform" },
        { platform: "无模板", promptTemplate: "" },
        null,
        "junk",
        { platform: "缺尺寸", promptTemplate: "p" },
        { platform: "坏尺寸", promptTemplate: "p", dimensions: { width: -1, height: 0 } },
      ],
    })
    expect(cleaned.map((c) => c.platform)).toEqual(["番茄", "缺尺寸", "坏尺寸"])
    // 非法尺寸回退默认
    expect(cleaned[1].dimensions).toEqual({ width: 600, height: 800 })
    expect(cleaned[2].dimensions).toEqual({ width: 600, height: 800 })
  })

  it("normalizeCoverPlatforms returns an empty list for malformed roots", () => {
    expect(normalizeCoverPlatforms(null)).toEqual([])
    expect(normalizeCoverPlatforms("junk")).toEqual([])
    expect(normalizeCoverPlatforms({})).toEqual([])
    expect(normalizeCoverPlatforms({ platforms: "not-an-array" })).toEqual([])
  })
})

describe("buildCoverPrompt — 纯函数", () => {
  const template: CoverPlatformTemplate = {
    platform: "晋江",
    style: "柔美言情风",
    dimensions: { width: 540, height: 720 },
    promptTemplate: "{{platform}}|{{style}}|{{width}}|{{height}}|{{title}}|{{genre}}|{{keywords}}",
  }

  it("replaces every placeholder and trims user input", () => {
    expect(buildCoverPrompt(template, { title: " A ", genre: " B ", keywords: " C " })).toBe(
      "晋江|柔美言情风|540|720|A|B|C",
    )
  })

  it("leaves empty user input as empty substitutions", () => {
    expect(buildCoverPrompt(template, { title: "", genre: "", keywords: "" })).toBe(
      "晋江|柔美言情风|540|720|||",
    )
  })
})
