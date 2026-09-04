import { describe, expect, it } from "vitest"
import {
  OUTLINE_GENRE_CODE_TO_WEB_NOVEL,
  OUTLINE_GENRE_CODES,
  resolveDeAiGenre,
} from "./genre-codes"

describe("genre-codes (55 号设计 W1-1)", () => {
  it("9 码映射表逐项断言 (全量枚举, 禁抽样)", () => {
    expect(OUTLINE_GENRE_CODE_TO_WEB_NOVEL.mystery).toBe("悬疑")
    expect(OUTLINE_GENRE_CODE_TO_WEB_NOVEL.xianxia).toBe("仙侠")
    expect(OUTLINE_GENRE_CODE_TO_WEB_NOVEL.romance).toBe("言情")
    expect(OUTLINE_GENRE_CODE_TO_WEB_NOVEL.scifi).toBe("科幻")
    expect(OUTLINE_GENRE_CODE_TO_WEB_NOVEL.historical).toBe("历史")
    expect(OUTLINE_GENRE_CODE_TO_WEB_NOVEL.urban).toBe("都市")
    // 无语义精确对应 → undefined (未知 → 默认基线, 不强配)
    expect(OUTLINE_GENRE_CODE_TO_WEB_NOVEL.fantasy).toBeUndefined()
    expect(OUTLINE_GENRE_CODE_TO_WEB_NOVEL.military).toBeUndefined()
    expect(OUTLINE_GENRE_CODE_TO_WEB_NOVEL.general).toBeUndefined()
  })

  it("OUTLINE_GENRE_CODES 与映射表键集一致 (防码表漂移)", () => {
    const keys = Object.keys(OUTLINE_GENRE_CODE_TO_WEB_NOVEL).sort()
    expect([...OUTLINE_GENRE_CODES].sort()).toEqual(keys)
  })

  it("resolveDeAiGenre: 已知码 → 中文流派名", () => {
    expect(resolveDeAiGenre("mystery")).toBe("悬疑")
    expect(resolveDeAiGenre("xianxia")).toBe("仙侠")
  })

  it("resolveDeAiGenre: undefined / 空串 / 未知码 → undefined 透传 (零行为变更)", () => {
    expect(resolveDeAiGenre(undefined)).toBeUndefined()
    expect(resolveDeAiGenre("")).toBeUndefined()
    expect(resolveDeAiGenre("unknown-code")).toBeUndefined()
    expect(resolveDeAiGenre("general")).toBeUndefined()
  })
})
