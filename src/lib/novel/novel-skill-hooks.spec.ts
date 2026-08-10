import { afterEach, describe, expect, it } from "vitest"
import {
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
})
