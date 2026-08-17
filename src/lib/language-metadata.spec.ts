import { describe, expect, it } from "vitest"
import {
  getHtmlLang,
  getLanguageMetadata,
  getLanguagePromptName,
  getTextDirection,
  sameScriptFamily,
} from "./language-metadata"

describe("getLanguageMetadata", () => {
  it("returns metadata for known languages", () => {
    expect(getLanguageMetadata("English").direction).toBe("ltr")
    expect(getLanguageMetadata("Arabic").direction).toBe("rtl")
    expect(getLanguageMetadata("Persian").scriptFamily).toBe("arabic")
    expect(getLanguageMetadata("Chinese").htmlLang).toBe("zh-Hans")
    expect(getLanguageMetadata("Traditional Chinese").htmlLang).toBe("zh-Hant")
    expect(getLanguageMetadata("Japanese").scriptFamily).toBe("cjk")
    expect(getLanguageMetadata("Korean").direction).toBe("ltr")
    expect(getLanguageMetadata("Hebrew").scriptFamily).toBe("other")
  })

  it("falls back to default metadata for unknown languages, preserving the name", () => {
    const meta = getLanguageMetadata("Klingon")
    expect(meta).toEqual({
      promptName: "Klingon",
      direction: "ltr",
      scriptFamily: "latin",
    })
  })

  it("falls back to the default prompt name for an empty language", () => {
    expect(getLanguageMetadata("").promptName).toBe("English")
  })
})

describe("getLanguagePromptName", () => {
  it("returns the prompt name for a known language", () => {
    expect(getLanguagePromptName("Arabic")).toBe("Arabic / العربية")
  })

  it("returns the input itself for an unknown language", () => {
    expect(getLanguagePromptName("Sindarin")).toBe("Sindarin")
  })
})

describe("getTextDirection", () => {
  it("returns rtl for right-to-left languages", () => {
    expect(getTextDirection("Arabic")).toBe("rtl")
    expect(getTextDirection("Persian")).toBe("rtl")
    expect(getTextDirection("Hebrew")).toBe("rtl")
  })

  it("returns ltr for left-to-right languages", () => {
    expect(getTextDirection("English")).toBe("ltr")
    expect(getTextDirection("Chinese")).toBe("ltr")
  })
})

describe("getHtmlLang", () => {
  it("returns the html lang tag for known languages", () => {
    expect(getHtmlLang("English")).toBe("en")
    expect(getHtmlLang("Arabic")).toBe("ar")
    expect(getHtmlLang("Korean")).toBe("ko")
  })

  it("returns undefined for unknown languages", () => {
    expect(getHtmlLang("Klingon")).toBeUndefined()
  })
})

describe("sameScriptFamily", () => {
  it("returns true for languages sharing a script family", () => {
    expect(sameScriptFamily("Chinese", "Japanese")).toBe(true)
    expect(sameScriptFamily("Arabic", "Persian")).toBe(true)
    expect(sameScriptFamily("English", "Unknown")).toBe(true)
  })

  it("returns false for different script families", () => {
    expect(sameScriptFamily("Chinese", "Arabic")).toBe(false)
  })
})
