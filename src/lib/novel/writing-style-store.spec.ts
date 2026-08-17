import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BookStyleProfile } from "./book-analysis/types"

const mem = new Map<string, string>()

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    if (!mem.has(path)) throw new Error("ENOENT")
    return mem.get(path)!
  }),
  writeFileAtomic: vi.fn(async (path: string, content: string) => {
    mem.set(path, content)
  }),
  createDirectory: vi.fn(async () => {}),
}))

import {
  loadWritingStyleStore,
  upsertWritingStylePreset,
  setEnabledWritingStyle,
  getEnabledWritingStyle,
  buildWritingStyleContext,
} from "./writing-style-store"

const PROJECT = "E:/Novel"

function makeProfile(overrides: Partial<BookStyleProfile> = {}): BookStyleProfile {
  return {
    schemaVersion: 1,
    generatedAt: 1,
    sampledChapterIds: ["ch-0001"],
    narrativeDensity: "密度高、推进快",
    descriptionWeight: "",
    emotionRendering: "",
    sentenceStyle: "",
    rhetoricDensity: "",
    transitionStyle: "",
    narrativeVoice: "",
    dialogueStyle: "",
    thematicHabits: "",
    constitution: "1. 朴素\n2. 克制",
    samples: ["原文片段一", "原文片段二"],
    ...overrides,
  }
}

beforeEach(() => {
  mem.clear()
})

describe("writing-style-store", () => {
  it("dedupes presets by sourceBook and overwrites the profile", async () => {
    const a = await upsertWritingStylePreset(PROJECT, { name: "凡人·文风", sourceBook: "凡人", profile: makeProfile() })
    const b = await upsertWritingStylePreset(PROJECT, {
      name: "凡人·文风",
      sourceBook: "凡人",
      profile: makeProfile({ narrativeDensity: "更新后的密度" }),
    })

    expect(a.id).toBe(b.id)
    const store = await loadWritingStyleStore(PROJECT)
    expect(store.styles).toHaveLength(1)
    expect(store.styles[0].profile.narrativeDensity).toBe("更新后的密度")
  })

  it("enables and clears the active style", async () => {
    const preset = await upsertWritingStylePreset(PROJECT, { name: "x", sourceBook: "凡人", profile: makeProfile() })
    await setEnabledWritingStyle(PROJECT, preset.id)
    expect((await getEnabledWritingStyle(PROJECT))?.id).toBe(preset.id)

    await setEnabledWritingStyle(PROJECT, null)
    expect(await getEnabledWritingStyle(PROJECT)).toBeNull()
  })

  it("ignores an unknown style id when enabling", async () => {
    await upsertWritingStylePreset(PROJECT, { name: "x", sourceBook: "凡人", profile: makeProfile() })
    await setEnabledWritingStyle(PROJECT, "does-not-exist")
    expect(await getEnabledWritingStyle(PROJECT)).toBeNull()
  })

  it("returns empty context when nothing is enabled", async () => {
    await upsertWritingStylePreset(PROJECT, { name: "x", sourceBook: "凡人", profile: makeProfile() })
    expect(await buildWritingStyleContext(PROJECT)).toBe("")
  })

  it("injects the guard, constitution and samples by default", async () => {
    const preset = await upsertWritingStylePreset(PROJECT, { name: "x", sourceBook: "凡人修仙传", profile: makeProfile() })
    await setEnabledWritingStyle(PROJECT, preset.id)

    const ctx = await buildWritingStyleContext(PROJECT)
    expect(ctx).toContain("《凡人修仙传》")
    expect(ctx).toContain("严禁借用")
    expect(ctx).toContain("朴素")
    expect(ctx).toContain("原文片段一")
  })

  it("omits samples when includeSamples is false", async () => {
    const preset = await upsertWritingStylePreset(PROJECT, { name: "x", sourceBook: "凡人", profile: makeProfile() })
    await setEnabledWritingStyle(PROJECT, preset.id)

    const ctx = await buildWritingStyleContext(PROJECT, { includeSamples: false })
    expect(ctx).not.toContain("原文片段一")
    expect(ctx).toContain("朴素")
  })

  it("coerces a non-array styles field from a persisted file to []", async () => {
    // Array.isArray(parsed.styles) 为 false → 回退 [] 臂
    mem.set(`${PROJECT}/.qmai/writing-style.json`, JSON.stringify({ version: 1, enabledStyleId: null, styles: "not-an-array" }))
    const store = await loadWritingStyleStore(PROJECT)
    expect(store.styles).toEqual([])
    expect(store.enabledStyleId).toBeNull()
  })

  it("returns null when the enabled style id is no longer present in the store", async () => {
    // enabledStyleId 已设置但对应 preset 被删 → find 回退 ?? null 臂
    mem.set(PROJECT + "/.qmai/writing-style.json", JSON.stringify({ version: 1, enabledStyleId: "ghost", styles: [] }))
    expect(await getEnabledWritingStyle(PROJECT)).toBeNull()
  })

  it("skips blank samples and stops at the samples char limit", async () => {
    const preset = await upsertWritingStylePreset(PROJECT, {
      name: "x",
      sourceBook: "凡人",
      profile: makeProfile({ samples: ["   ", "片段一", "片段二"], constitution: "朴素" }),
    })
    await setEnabledWritingStyle(PROJECT, preset.id)

    // 空白样本 continue; 累计超限 break → 只保留 non-blank 首个片段
    const ctx = await buildWritingStyleContext(PROJECT, { samplesCharLimit: 4 })
    expect(ctx).toContain("片段一")
    expect(ctx).not.toContain("片段二")
  })

  it("omits the samples section when every sample is blank", async () => {
    const preset = await upsertWritingStylePreset(PROJECT, {
      name: "x",
      sourceBook: "凡人",
      profile: makeProfile({ samples: ["  ", "\n "] }),
    })
    await setEnabledWritingStyle(PROJECT, preset.id)

    const ctx = await buildWritingStyleContext(PROJECT, { includeSamples: true })
    expect(ctx).not.toContain("文风参考片段")
  })

  it("clips an over-long constitution to the configured limit", async () => {
    const preset = await upsertWritingStylePreset(PROJECT, {
      name: "x",
      sourceBook: "凡人",
      profile: makeProfile({ constitution: "约束".repeat(1000) }),
    })
    await setEnabledWritingStyle(PROJECT, preset.id)

    const ctx = await buildWritingStyleContext(PROJECT, { constitutionCharLimit: 100 })
    expect(ctx).toContain("…")
    expect(ctx.length).toBeLessThan(800)
  })
})
