// @vitest-environment node
/**
 * campaign-memory.spec — H4 战役前情结构化承接测试。
 * 覆盖：空串/全空白短路、三段结构（承接章号 / 前章收束 / 前章开端锚点）、
 * 首尾片段取样正确、任务简报行与 200 字截断、整体 1500 字封顶。
 */
import { describe, expect, it } from "vitest"
import {
  CARRYOVER_BRIEF_CHARS,
  CARRYOVER_CONTEXT_MAX_CHARS,
  CARRYOVER_HEAD_CHARS,
  CARRYOVER_TAIL_CHARS,
  buildCarryoverContext,
  type CarryoverSource,
} from "./campaign-memory"

const HEADER_TAIL = "【前章收束(末800字)】"
const HEADER_HEAD = "【前章开端锚点(首400字)】"

describe("buildCarryoverContext", () => {
  it("content 为空串时返回空串", () => {
    expect(buildCarryoverContext({ chapterNumber: 3, content: "" })).toBe("")
  })

  it("content 为全空白时返回空串", () => {
    expect(buildCarryoverContext({ chapterNumber: 3, content: "   \n\n\t  \r\n " })).toBe("")
  })

  it("短文：包含原文，且含三段标题与承接章号", () => {
    const content = "第7章：林越在雨夜推开旧书店的门，柜台后的人抬头看了他一眼，什么都没说。"
    const out = buildCarryoverContext({ chapterNumber: 7, content })

    expect(out).toContain(content)
    expect(out).toContain("【承接章号】第7章")
    expect(out).toContain(HEADER_TAIL)
    expect(out).toContain(HEADER_HEAD)

    // 三段顺序固定：章号 → 末段收束 → 首段锚点
    const iChapter = out.indexOf("【承接章号】")
    const iTail = out.indexOf(HEADER_TAIL)
    const iHead = out.indexOf(HEADER_HEAD)
    expect(iChapter).toBeGreaterThanOrEqual(0)
    expect(iTail).toBeGreaterThan(iChapter)
    expect(iHead).toBeGreaterThan(iTail)
    expect(out.startsWith("【承接章号】第7章")).toBe(true)
  })

  it("长文：含三段标题与头尾标记，丢弃中段，且总长不超过 1500", () => {
    const headMarker = "H".repeat(400)
    const middle = "M".repeat(3000)
    const tailMarker = "T".repeat(800)
    const out = buildCarryoverContext({ chapterNumber: 12, content: headMarker + middle + tailMarker })

    expect(out).toContain("【承接章号】第12章")
    expect(out).toContain(HEADER_TAIL)
    expect(out).toContain(HEADER_HEAD)
    expect(out).toContain(tailMarker)
    expect(out).toContain(headMarker)
    // 中段既不属末 800 也不属首 400，必须被结构性丢弃（而非盲截断灌入）
    expect(out).not.toContain("M")
    expect(out.length).toBeLessThanOrEqual(CARRYOVER_CONTEXT_MAX_CHARS)
    expect(out.length).toBeLessThanOrEqual(1500)
    expect(CARRYOVER_CONTEXT_MAX_CHARS).toBe(1500)
    expect(CARRYOVER_TAIL_CHARS).toBe(800)
    expect(CARRYOVER_HEAD_CHARS).toBe(400)
  })

  it("章号标注正确且随入参变化", () => {
    const content = "正文片段。"
    expect(buildCarryoverContext({ chapterNumber: 1, content })).toContain("【承接章号】第1章")
    expect(buildCarryoverContext({ chapterNumber: 42, content })).toContain("【承接章号】第42章")
    expect(buildCarryoverContext({ chapterNumber: 108, content })).toContain("【承接章号】第108章")
    expect(buildCarryoverContext({ chapterNumber: 1, content })).not.toContain("第42章")
  })

  it("taskBrief 非空时输出简报行并截断至 200 字；为空/全空白时不输出", () => {
    const brief = "B".repeat(500)
    const withBrief = buildCarryoverContext({ chapterNumber: 5, content: "正文。", taskBrief: brief })
    expect(withBrief).toContain("【任务简报】")
    expect(withBrief).toContain("B".repeat(CARRYOVER_BRIEF_CHARS))
    expect(withBrief).not.toContain("B".repeat(CARRYOVER_BRIEF_CHARS + 1))
    expect(CARRYOVER_BRIEF_CHARS).toBe(200)

    expect(
      buildCarryoverContext({ chapterNumber: 5, content: "正文。", taskBrief: "" }),
    ).not.toContain("【任务简报】")
    expect(
      buildCarryoverContext({ chapterNumber: 5, content: "正文。", taskBrief: "   " }),
    ).not.toContain("【任务简报】")
    expect(buildCarryoverContext({ chapterNumber: 5, content: "正文。" })).not.toContain("【任务简报】")
  })

  it("任何非空白输入下总长恒不超过 1500（含超长简报边界）", () => {
    const cases: CarryoverSource[] = [
      { chapterNumber: 1, content: "短。", taskBrief: "C".repeat(5000) },
      { chapterNumber: 9999, content: "X".repeat(20000) },
      { chapterNumber: 2, content: "Y".repeat(1201) + "\n" + "Z".repeat(1201), taskBrief: "D".repeat(200) },
    ]
    for (const input of cases) {
      const out = buildCarryoverContext(input)
      expect(out.length).toBeGreaterThan(0)
      expect(out.length).toBeLessThanOrEqual(CARRYOVER_CONTEXT_MAX_CHARS)
    }
  })
})
