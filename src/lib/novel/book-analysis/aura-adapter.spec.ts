import { describe, expect, it } from "vitest"
import {
  buildGeneratedAuraInputFromBookCharacter,
  buildSimpleSkillContent,
} from "./aura-adapter"
import type { BookAnalysisMetadata, CharacterSkill, ExtractedCharacter } from "./types"

describe("buildGeneratedAuraInputFromBookCharacter", () => {
  it("maps extracted character data into custom soul fields", () => {
    const metadata: BookAnalysisMetadata = {
      title: "长夜书",
      totalChapters: 3,
      totalWords: 12000,
      sourceType: "file",
      createdAt: 1,
      updatedAt: 2,
    }
    const character: ExtractedCharacter = {
      id: "char-linjing",
      name: "林烬",
      aliases: ["林少"],
      importance: 9,
      category: "protagonist",
      firstAppearance: 1,
      lastAppearance: 3,
      appearanceCount: 3,
      description: "旧城巡夜人。",
      personality: "克制，谨慎，不轻易信任。",
      speechStyle: "短句，低声，压力越大越慢。",
      relationships: [{ target: "沈微", relation: "同盟", description: "彼此试探" }],
      keyEvents: [{ chapterId: "ch-0002", description: "救下沈微但隐藏伤势" }],
      corpus: "林烬压住怒气，先看门缝里的灰。",
    }
    const skill: CharacterSkill = {
      id: "skill-char-linjing",
      characterId: "char-linjing",
      characterName: "林烬",
      skillContent: "---\nname: 林烬\n---\n# 林烬\n",
      sourceBook: "长夜书",
      chapterRange: ["1", "3"],
      createdAt: 3,
      filePath: "E:/Novel/book-analysis/book-1/skills/林烬-skill.md",
    }

    const input = buildGeneratedAuraInputFromBookCharacter(character, skill, metadata)

    expect(input.name).toBe("林烬")
    expect(input.category).toBe("拆书角色")
    expect(input.sourceBook).toBe("长夜书")
    expect(input.skillContent).toContain("# 林烬")
    expect(input.expressionDna).toContain("短句")
    expect(input.mentalModel).toContain("克制")
    expect(input.decisionHeuristics).toContain("救下沈微")
    expect(input.researchFiles?.["02-conversations.md"]).toContain("压力越大越慢")
    expect(input.researchFiles?.["06-timeline.md"]).toContain("第 1 章")
  })

  it("prefers a complete personality profile and renders representative quotes", () => {
    const metadata: BookAnalysisMetadata = {
      title: "回声录",
      totalChapters: 5,
      totalWords: 5000,
      sourceType: "file",
      createdAt: 1,
      updatedAt: 1,
    }
    const character: ExtractedCharacter = {
      id: "profiled",
      name: "沈微",
      aliases: [],
      importance: 5,
      category: "supporting",
      firstAppearance: 2,
      lastAppearance: 4,
      appearanceCount: 2,
      description: "",
      personality: "",
      speechStyle: "",
      relationships: [{ target: "林烬", relation: "同盟" }],
      keyEvents: [],
      corpus: "",
      personalityProfile: {
        personality: "谨慎",
        motivation: "守住证据",
        speechStyle: "短促陈述",
        behaviorPatterns: "先观察后行动",
        quotes: ["门还没锁。", "别回头。"],
      },
    }
    const skill: CharacterSkill = {
      id: "skill-profiled",
      characterId: character.id,
      characterName: character.name,
      skillContent: "# 沈微",
      sourceBook: metadata.title,
      chapterRange: ["2"],
      createdAt: 1,
    }

    const input = buildGeneratedAuraInputFromBookCharacter(character, skill, metadata)

    expect(input.notes).toContain("第 2 章 - 第 4 章")
    expect(input.corpus).toContain("谨慎；守住证据")
    expect(input.corpus).toContain("「门还没锁。」")
    expect(input.behaviorRules).toContain("- 林烬：同盟")
    expect(input.decisionHeuristics).toContain("暂未提取到关键事件")
    expect(input.researchFiles?.["01-writings.md"]).toContain("暂未保存角色语料")
    expect(input.researchFiles?.["02-conversations.md"]).toContain("「别回头。」")
  })

  it("uses public fallbacks when the extracted character has no usable details", () => {
    const metadata: BookAnalysisMetadata = {
      title: "空白书",
      totalChapters: 1,
      totalWords: 1,
      sourceType: "file",
      createdAt: 1,
      updatedAt: 1,
    }
    const character: ExtractedCharacter = {
      id: "empty",
      name: "无名",
      aliases: [],
      importance: 0,
      category: "minor",
      firstAppearance: 1,
      lastAppearance: 1,
      appearanceCount: 0,
      description: "",
      personality: "",
      speechStyle: "",
      relationships: [],
      keyEvents: [],
    }
    const skill: CharacterSkill = {
      id: "skill-empty",
      characterId: character.id,
      characterName: character.name,
      skillContent: "",
      sourceBook: metadata.title,
      chapterRange: [],
      createdAt: 1,
    }

    const input = buildGeneratedAuraInputFromBookCharacter(character, skill, metadata)

    expect(input.styleDescription).toContain("暂未提取到角色描述")
    expect(input.expressionDna).toContain("暂未提取到说话风格")
    expect(input.mentalModel).toContain("暂未提取到性格特征")
    expect(input.corpus).toContain("暂未保存角色语料")
  })

  it("builds simple skill content including each representative quote", () => {
    const content = buildSimpleSkillContent({
      characterName: "沈微",
      profile: {
        personality: "谨慎",
        motivation: "求生",
        speechStyle: "短句",
        behaviorPatterns: "观察",
        quotes: ["第一句", "第二句"],
      },
    })

    expect(content).toContain("# 角色 - 沈微")
    expect(content).toContain("## 代表性台词")
    expect(content).toContain("「第一句」\n「第二句」")
  })
})

