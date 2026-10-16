// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  assembleChapterRequest,
  buildBaseRequest,
  buildCharacterConstraint,
  buildStageHint,
  enrichWithEventPool,
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

  it("enrichWithEventPool 预留位直接透传原串", async () => {
    const request = "请撰写第 1 章正文。"
    await expect(enrichWithEventPool(request)).resolves.toBe(request)
  })
})
