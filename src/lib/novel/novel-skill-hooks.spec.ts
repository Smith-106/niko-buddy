import { afterEach, describe, expect, it } from "vitest"
import {
  createAvoidAiMechanicalSlopHook,
  createCedSoftReportHook,
  createGoldScaleReadinessHook,
  getNovelSkillHookRegistry,
  listNovelSkillHooksForStage,
  registerNovelSkillHook,
  runNovelSkillHooks,
  setNovelSkillHookRegistry,
} from "./novel-skill-hooks"

describe("novel-skill-hooks", () => {
  afterEach(() => {
    setNovelSkillHookRegistry(null)
  })

  it("default registry is empty", () => {
    expect(getNovelSkillHookRegistry().hooks).toEqual([])
    expect(listNovelSkillHooksForStage("pre_write_prompt")).toEqual([])
  })

  it("register and run Track B hook", async () => {
    registerNovelSkillHook({
      id: "test.frag",
      title: "t",
      stages: ["pre_write_prompt"],
      track: "B",
      run: (ctx) => {
        ctx.bag.promptFragments.push("HELLO")
      },
    })
    const ctx = await runNovelSkillHooks("pre_write_prompt", { projectPath: "/p", chapterNumber: 4 })
    expect(ctx.bag.promptFragments).toContain("HELLO")
  })

  it("rejects non-B track", () => {
    expect(() =>
      registerNovelSkillHook({
        id: "bad",
        title: "bad",
        stages: ["pre_write_prompt"],
        track: "A" as "B",
        run: () => {},
      }),
    ).toThrow(/Track B/)
  })

  it("soft-fails hook errors", async () => {
    registerNovelSkillHook({
      id: "boom",
      title: "boom",
      stages: ["post_draft_light_check"],
      track: "B",
      run: () => {
        throw new Error("nope")
      },
    })
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("boom"))).toBe(true)
  })

  it("gold scale readiness hook injects fragment", async () => {
    registerNovelSkillHook(createGoldScaleReadinessHook("金标未就绪"))
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(ctx.bag.promptFragments.join("")).toContain("金标")
  })

  it("avoid-ai mechanical slop hook is Track B and soft-injects on sloppy text", async () => {
    const sloppy =
      "然而，总而言之，在这个时代背景下，他不禁陷入沉思。" +
      "与此同时，值得注意的是，一种微妙的氛围悄然蔓延。" +
      "综上所述，他感到一种难以言喻的复杂情绪。"
    registerNovelSkillHook(createAvoidAiMechanicalSlopHook({ text: sloppy }))
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("avoid-ai slop"))).toBe(true)
    expect(ctx.bag.notes.some((n) => n.includes("not product hard gate"))).toBe(true)
  })

  it("avoid-ai hook skips empty text without throwing", async () => {
    registerNovelSkillHook(createAvoidAiMechanicalSlopHook({ text: "" }))
    const ctx = await runNovelSkillHooks("post_draft_light_check", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("skipped"))).toBe(true)
  })

  it("ced soft report hook notes density without hard gate", async () => {
    registerNovelSkillHook(
      createCedSoftReportHook({
        findings: [
          {
            type: "absent_character",
            subtype: "consistency_mechanical",
            severity: "warning",
            ref: "character:x",
            message: "absent",
            chapter: 4,
          },
        ],
        textForWordCount: "她打开了门。雨打在台阶上。没有人说话。",
      }),
    )
    const ctx = await runNovelSkillHooks("pre_six_dim_review", { projectPath: "/p" })
    expect(ctx.bag.notes.some((n) => n.includes("CED soft"))).toBe(true)
    expect(ctx.bag.notes.some((n) => n.includes("not product hard gate"))).toBe(true)
  })
})

