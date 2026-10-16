// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  assembleChapterRequest,
  buildBaseRequest,
  buildCharacterConstraint,
  buildInterviewAnchor,
  buildPovConstraint,
  buildStageHint,
  enrichWithEventPool,
  formatEventCandidate,
} from "./chapter-request-builder"

describe("chapter-request-builder (S2 章节请求构建器)", () => {
  it("buildBaseRequest 返回标准基础指令", () => {
    expect(buildBaseRequest(3)).toBe("请撰写第 3 章正文。")
  })

  it("buildBaseRequest 支持首章编号", () => {
    expect(buildBaseRequest(1)).toBe("请撰写第 1 章正文。")
  })

  it("buildCharacterConstraint 空数组返回空串", () => {
    expect(buildCharacterConstraint([])).toBe("")
  })

  it("buildCharacterConstraint 全空白名字返回空串", () => {
    expect(buildCharacterConstraint(["  ", "\t"])).toBe("")
  })

  it("buildCharacterConstraint 单个人物直接输出", () => {
    expect(buildCharacterConstraint(["沈知遥"])).toBe(
      "【出场人物约束】本章允许出场：沈知遥；其余人物不得擅自登场。",
    )
  })

  it("buildCharacterConstraint 多个人物以顿号连接", () => {
    expect(buildCharacterConstraint(["沈知遥", "陆沉", "白鹭"])).toBe(
      "【出场人物约束】本章允许出场：沈知遥、陆沉、白鹭；其余人物不得擅自登场。",
    )
  })

  it("buildStageHint 首章处于起段", () => {
    expect(buildStageHint(1, 10)).toBe("【节拍提示】本章处于「起」段：开端铺垫")
  })

  it("buildStageHint 末章处于合段", () => {
    expect(buildStageHint(10, 10)).toBe("【节拍提示】本章处于「合」段：收束余韵")
  })

  it("buildStageHint 中段按 getNodeStage 映射（3/10 章为承段）", () => {
    expect(buildStageHint(3, 10)).toBe("【节拍提示】本章处于「承」段：矛盾升级")
  })

  it("buildStageHint 中段按 getNodeStage 映射（8/10 章为转段）", () => {
    expect(buildStageHint(8, 10)).toBe("【节拍提示】本章处于「转」段：冲突爆发")
  })

  it("assembleChapterRequest 非空段以双换行连接并跳过空段", () => {
    expect(
      assembleChapterRequest({
        base: "请撰写第 1 章正文。",
        character: "",
        stage: "【节拍提示】本章处于「起」段：开端铺垫",
        carryover: "【承接章号】第0章",
      }),
    ).toBe(
      "请撰写第 1 章正文。\n\n【节拍提示】本章处于「起」段：开端铺垫\n\n【承接章号】第0章",
    )
  })

  it("assembleChapterRequest 仅 base 时原样返回", () => {
    expect(assembleChapterRequest({ base: "请撰写第 2 章正文。" })).toBe(
      "请撰写第 2 章正文。",
    )
  })

  it("enrichWithEventPool 设定缺失时原串直通", async () => {
    const request = "请撰写第 1 章正文。"
    await expect(
      enrichWithEventPool({
        request,
        projectPath: "/nonexistent-project-xyz",
        llmConfig: { provider: "openai", apiKey: "", model: "x", ollamaUrl: "", customEndpoint: "", maxContextSize: 1000 },
        characters: [],
        chapterNumber: 1,
        totalChapters: 10,
      }),
    ).resolves.toBe(request)
  })

  it("formatEventCandidate 空串返回空串，非空包裹候选格式", () => {
    expect(formatEventCandidate("   ")).toBe("")
    expect(formatEventCandidate("密室惊现血字")).toBe("【本章事件候选】密室惊现血字（可选用，不必强塞）。")
  })

  it("buildPovConstraint null 返回空串", () => {
    expect(buildPovConstraint(null, ["沈知遥"])).toBe("")
  })

  it("buildPovConstraint 空白视点返回空串", () => {
    expect(buildPovConstraint("   ", ["陆沉"])).toBe("")
  })

  it("buildPovConstraint 无他人时省略后半句", () => {
    expect(buildPovConstraint("沈知遥", [])).toBe(
      "【视点约束】本章视点人物：沈知遥。",
    )
  })

  it("buildPovConstraint 有他人时输出完整约束", () => {
    expect(buildPovConstraint("沈知遥", ["陆沉", "白鹭"])).toBe(
      "【视点约束】本章视点人物：沈知遥；不得描写以下人物的内心活动：陆沉、白鹭。",
    )
  })

  it("buildPovConstraint 清洗空白去重并排除视点本人", () => {
    expect(buildPovConstraint("沈知遥", ["  ", "陆沉", "陆沉", "沈知遥", "白鹭"])).toBe(
      "【视点约束】本章视点人物：沈知遥；不得描写以下人物的内心活动：陆沉、白鹭。",
    )
  })

  it("buildInterviewAnchor 空数组返回空串", () => {
    expect(buildInterviewAnchor([])).toBe("")
    expect(buildInterviewAnchor(["  ", "\t"])).toBe("")
  })

  it("buildInterviewAnchor 单条包裹锚点格式", () => {
    expect(buildInterviewAnchor(["我亲眼看见灯灭了"])).toBe(
      "【人物访谈锚点】\n· 我亲眼看见灯灭了",
    )
  })

  it("buildInterviewAnchor 超过3条仅取最近3条", () => {
    expect(buildInterviewAnchor(["一", "二", "三", "四", "五"])).toBe(
      "【人物访谈锚点】\n· 三\n· 四\n· 五",
    )
  })

  it("buildInterviewAnchor 超长单条截断至200字", () => {
    const long = "啊".repeat(250)
    const out = buildInterviewAnchor([long])
    expect(out).toBe(`【人物访谈锚点】\n· ${"啊".repeat(200)}`)
  })

  it("assembleChapterRequest 按 base→character→pov→interview→stage→carryover 连接", () => {
    expect(
      assembleChapterRequest({
        base: "请撰写第 1 章正文。",
        character: "【出场人物约束】本章允许出场：沈知遥；其余人物不得擅自登场。",
        pov: "【视点约束】本章视点人物：沈知遥。",
        interview: "【人物访谈锚点】\n· 我亲眼看见灯灭了",
        stage: "【节拍提示】本章处于「起」段：开端铺垫",
        carryover: "",
      }),
    ).toBe(
      "请撰写第 1 章正文。\n\n【出场人物约束】本章允许出场：沈知遥；其余人物不得擅自登场。\n\n【视点约束】本章视点人物：沈知遥。\n\n【人物访谈锚点】\n· 我亲眼看见灯灭了\n\n【节拍提示】本章处于「起」段：开端铺垫",
    )
  })
})
