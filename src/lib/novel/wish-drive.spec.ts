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

  it("F10-4：多 wish/motive 全量保留（allWishes/allMotives），首条契约不变", () => {
    const multi: CanonEntityProjection = {
      digest: "prot-multi", name: "主角",
      wish: ["找到失踪的妹妹", "  ", "重建家族"],
      motive: ["偿还童年亏欠", "守护活着的人"],
      mckee_ghost: "妹妹因自己疏忽失踪",
      arc_stage: "active",
    }
    const a = assembleWishList("prot-multi", [multi])
    // 全量保留：空白项被滤掉，保序
    expect(a.allWishes).toEqual(["找到失踪的妹妹", "重建家族"])
    expect(a.allMotives).toEqual(["偿还童年亏欠", "守护活着的人"])
    // 既有契约不变：首条 + 完整度 + 缺失清单
    expect(a.items).toHaveLength(1)
    expect(a.items[0].wish).toBe("找到失踪的妹妹")
    expect(a.items[0].motive).toBe("偿还童年亏欠")
    expect(a.completeness).toBe(1)
    expect(a.missing).toHaveLength(0)
    // 引导提示逐条列出首条之外（不再静默截断）
    const prompt = buildWishDrivePrompt(a, detectWriterBlock(a))
    expect(prompt).toContain("- wish[1]: 重建家族")
    expect(prompt).toContain("- motive[1]: 守护活着的人")
  })

  it("F10-4：单条实体提示零变化（无 wish[1]/motive[1] 行）", () => {
    const a = assembleWishList("prot-001", [fullEntity])
    expect(a.allWishes).toEqual(["找到失踪的妹妹"])
    expect(a.allMotives).toEqual(["偿还童年亏欠"])
    const prompt = buildWishDrivePrompt(a, detectWriterBlock(a))
    expect(prompt).not.toContain("wish[1]")
    expect(prompt).not.toContain("motive[1]")
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
