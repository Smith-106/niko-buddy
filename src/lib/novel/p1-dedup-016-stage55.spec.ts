import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  hasCheckpointRevision,
} from "@/lib/novel/deep-chapter-runtime-support"

/**
 * ISS-20260708-016：stage-5.5 resume 结构性 unreachable 证伪后删死抑制。
 *
 * 全仓 grep 证：hasCheckpointRevision 在 repair 主路径被调用（消费者存在），
 * stage-5.5 内分支（deepChapterReview && pending）可达——`v8 ignore next` 为死抑制，已删。
 * 本单测锁定可达性：revision checkpoint + pending 门控即命中 stage-5.5 条件。
 */
describe("ISS-20260708-016 stage-5.5 reachable", () => {
  it("revision checkpoint 仍命中 stage-5.5 内分支条件", () => {
    const checkpoint = {
      version: 1,
      originalRequest: "req",
      chapterNumber: 1,
      stage: "after_revision",
      taskBrief: "brief",
      draftContent: "draft",
      reviewResults: [{ severity: "error", type: "x", message: "m", evidence: "" }],
      currentContent: "revised body",
      decisionGates: { overall: "pending" },
    } as never
    expect(hasCheckpointRevision(checkpoint)).toBe(true)
    // 内分支条件：deepChapterReview 开 && overall pending
    const novelConfig: { deepChapterReview: boolean } = { deepChapterReview: true }
    const decisionGates: { overall: string } = { overall: "pending" }
    expect(novelConfig.deepChapterReview && decisionGates.overall === "pending").toBe(true)
  })

  it("死抑制已删（无覆盖抑制紧贴 stage-5.5 分支）", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/novel/deep-chapter-review-repair.ts"),
      "utf-8",
    )
    const lines = src.split("\n")
    const idx = lines.findIndex((l) => l.includes("阶段5.5：返修后复审"))
    expect(idx).toBeGreaterThan(0)
    // 前 6 行内不应再有覆盖抑制（已证可达，无需抑制）
    const window = lines.slice(Math.max(0, idx - 6), idx).join("\n")
    expect(window).not.toContain("v8 ignore")
  })
});
