import { describe, expect, it } from "vitest"
import { getTemplate, templates, type WikiTemplate } from "./templates"

describe("templates", () => {
  it("exports all five registered templates with stable ids", () => {
    expect(templates.map((t) => t.id)).toEqual([
      "research",
      "reading",
      "personal",
      "business",
      "general",
    ])
  })

  it("bundles schema, purpose, icon and extra dirs per template", () => {
    const research = getTemplate("research")
    expect(research.name).toBe("Research")
    expect(research.icon).toBe("🔍")
    expect(research.schema).toContain("Wiki Schema — Research Deep-Dive")
    expect(research.schema).toContain("| entity | wiki/entities/ |")
    expect(research.purpose).toContain("# Project Purpose — Research Deep-Dive")
    expect(research.extraDirs).toEqual(["wiki/methodology", "wiki/findings", "wiki/thesis"])

    const general = getTemplate("general")
    expect(general.extraDirs).toEqual([])
    expect(general.schema).toContain("## Naming Conventions")
  })

  it("returns the reading template with its schema sections", () => {
    const reading = getTemplate("reading")
    expect(reading.schema).toContain("Reading a Book")
    expect(reading.schema).toContain("| character | wiki/characters/ |")
    expect(reading.purpose).toContain("## Book Details")
  })

  it("returns the personal and business templates", () => {
    expect(getTemplate("personal").schema).toContain("Personal Growth")
    expect(getTemplate("business").schema).toContain("Business / Team")
  })

  it("throws for unknown template ids", () => {
    expect(() => getTemplate("nope")).toThrow('Unknown template id: "nope"')
    expect(() => getTemplate("")).toThrow('Unknown template id: ""')
  })

  it("every template satisfies the WikiTemplate contract", () => {
    for (const t of templates) {
      expect(t).toMatchObject<WikiTemplate>({
        id: expect.any(String),
        name: expect.any(String),
        description: expect.any(String),
        icon: expect.any(String),
        schema: expect.any(String),
        purpose: expect.any(String),
        extraDirs: expect.any(Array),
      })
      expect(t.schema.length).toBeGreaterThan(100)
      expect(t.purpose.length).toBeGreaterThan(50)
    }
  })
})
