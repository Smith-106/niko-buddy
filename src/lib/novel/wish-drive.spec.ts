/**
 * wish-drive.spec.ts — TASK-P4-29b (T29b): 卡文引导流装配单测
 *
 * 蓝图 T29b 验收: `npx vitest run canon-editor wish-drive`
 * 覆盖：wish 清单装配（wish/motive/ghost/arc_stage 填充率）+ 卡文检测 + 引导提示。
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；Draft-first 不触正式层。
 */
import { describe, expect, it } from "vitest"
import {
  assembleWishList,
  buildWishDrivePrompt,
  detectWriterBlock,
  type CanonEntityProjection,
} from "./wish-drive"

const fullEntity: CanonEntityProjection = {
  digest: "prot-001",
  name: "林晚",
  wish: ["找到失踪的妹妹"],
  motive: ["偿还童年亏欠"],
  mckee_ghost: "妹妹因自己疏忽失踪",
  arc_stage: "commitment",
}

const emptyEntity: CanonEntityProjection = {
  digest: "prot-002",
  name: "无名主角",
}

describe("TASK-P4-29b (T29b) wish-drive — wish 清单装配", () => {
  it("完整实体装配 100% 完整度", () => {
    const a = assembleWishList("prot-001", [fullEntity])
    expect(a.completeness).toBe(1)
    expect(a.items).toHaveLength(1)
    expect(a.items[0].wish).toBe("找到失踪的妹妹")
    expect(a.items[0].arcStage).toBe("commitment")
    expect(a.missing).toHaveLength(0)
  })

  it("空实体装配 0% 完整度 + 缺失清单", () => {
    const a = assembleWishList("prot-002", [emptyEntity])
    expect(a.completeness).toBe(0)
    expect(a.items).toHaveLength(0)
    expect(a.missing).toEqual(["wish", "motive", "ghost", "arc_stage"])
  })

  it("无实体返回空装配", () => {
    const a = assembleWishList("prot-999", [])
    expect(a.items).toHaveLength(0)
    expect(a.completeness).toBe(0)
  })

  it("部分填充（仅 wish）→ 25% 完整度", () => {
    const partial: CanonEntityProjection = { digest: "prot-003", name: "配角", wish: ["活下去"] }
    const a = assembleWishList("prot-003", [partial])
    expect(a.completeness).toBe(0.25)
    expect(a.missing).toEqual(["motive", "ghost", "arc_stage"])
  })
})

describe("TASK-P4-29b (T29b) wish-drive — 卡文检测", () => {
  it("完整清单不卡文", () => {
    const a = assembleWishList("prot-001", [fullEntity])
    const r = detectWriterBlock(a)
    expect(r.blocked).toBe(false)
    expect(r.reasons).toHaveLength(0)
  })

  it("空清单卡文 + 引导建议", () => {
    const a = assembleWishList("prot-002", [emptyEntity])
    const r = detectWriterBlock(a)
    expect(r.blocked).toBe(true)
    expect(r.reasons.join("; ")).toContain("wish 清单为空")
    expect(r.suggestions.length).toBeGreaterThan(0)
  })

  it("ghost 缺失卡文（麦基鬼魂未装配）", () => {
    const noGhost: CanonEntityProjection = {
      digest: "prot-004", name: "主角", wish: ["目标"], motive: ["动机"], mckee_ghost: null, arc_stage: "active",
    }
    const a = assembleWishList("prot-004", [noGhost])
    const r = detectWriterBlock(a)
    expect(r.blocked).toBe(true)
    expect(r.reasons.join("; ")).toContain("ghost")
  })

  it("引导提示装配（纯函数，含完整度与建议）", () => {
    const a = assembleWishList("prot-002", [emptyEntity])
    const r = detectWriterBlock(a)
    const prompt = buildWishDrivePrompt(a, r)
    expect(prompt).toContain("卡文引导")
    expect(prompt).toContain("装配度 0%")
    expect(prompt).toContain("建议")
  })

  it("完整清单提示不含卡文段", () => {
    const a = assembleWishList("prot-001", [fullEntity])
    const r = detectWriterBlock(a)
    const prompt = buildWishDrivePrompt(a, r)
    expect(prompt).toContain("wish 清单完整")
    expect(prompt).not.toContain("卡文原因")
  })
})
