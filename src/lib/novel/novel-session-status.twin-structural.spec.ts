import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * EPIC-000 / ADR-31 / TASK-003: lifecycle-twin 结构回归测试
 *
 * ADR-31 工厂提取 (buildNextStatus / persistCheckpointBase) 把 6 个 lifecycle
 * 函数 (persist/complete/pause/block/accept/reject) 此前各自内联的手动 `next`
 * status 字面量块收敛为单一工厂调用。该手动复制在历史触发 lifecycle-twin
 * 遗漏 4 次 (SH-5 → ARCH-006 → PAT-G1 → DC-2): 每次复发都是镜像站点之一
 * 静默丢了一个字段。
 *
 * 本 spec 是结构不变量守卫: readFileSync 源文本 + 正则扫描, 断言工厂提取
 * 后的结构不被回归。一旦有人重新引入手动 `const next: NovelSessionStatus = {`
 * 字面量块, 或减少 buildNextStatus/persistCheckpointBase 调用点, 测试立即红。
 *
 * HARD-1: 本 spec 不引入新真源, 仅扫描源码断言不变量 (无运行时状态写入)。
 * 简化依赖: 用 node:fs readFileSync + RegExp, 非 ts-morph。
 */
describe("EPIC-000 / ADR-31 / TASK-003: lifecycle-twin 结构不变量", () => {
  const sourcePath = resolve(__dirname, "novel-session-status.ts")
  const source = readFileSync(sourcePath, "utf-8")

  it("无手动 `const next: NovelSessionStatus = {` 块 (工厂提取后禁止手写 next 字面量)", () => {
    // 工厂提取前, 6 个 lifecycle 函数各自内联 `const next: NovelSessionStatus = {`
    // 字面量并手动复制 9 个字段。提取后所有 lifecycle 函数改走 buildNextStatus,
    // 显式类型注解的手动块应归零。若此 count > 0, 说明有人重新引入手动复制,
    // lifecycle-twin 遗漏风险回归。
    const matches = source.match(/const next:\s*NovelSessionStatus\s*=\s*\{/g)
    expect(matches, "工厂提取后不应存在手动 `const next: NovelSessionStatus = {` 块").toBeNull()
  })

  it("buildNextStatus 调用点 >= 7 (1 定义 + 6 lifecycle 调用)", () => {
    // 1 export function 定义 (line ~503) + 6 lifecycle 调用:
    // persistDeepChapterCheckpoint / completeDeepChapterSession /
    // pauseDeepChapterSession / blockDeepChapterSession /
    // acceptDeepChapterDraft / rejectDeepChapterDraft。
    // startDeepChapterSession 走 createBaseStatus (start 路径, 非工厂) 故不计。
    // 若 count < 7, 说明有 lifecycle 函数退回手动块, 工厂覆盖不全。
    const matches = source.match(/buildNextStatus\(/g) ?? []
    expect(matches.length, "buildNextStatus 应有 1 定义 + 6 调用 = 7 处").toBeGreaterThanOrEqual(7)
  })

  it("persistCheckpointBase 调用点 >= 7 (1 定义 + 6 lifecycle 调用)", () => {
    // 1 export async function 定义 (line ~580) + 6 lifecycle 调用, 与
    // buildNextStatus 一一对应 (每个 lifecycle 先构造 next 再 persist)。
    // 若 count < 7, 说明有 lifecycle 函数退回内联 saveNovelSessionStatus,
    // 绕过 evidence_refs 合并与真源身份校验。
    const matches = source.match(/persistCheckpointBase\(/g) ?? []
    expect(matches.length, "persistCheckpointBase 应有 1 定义 + 6 调用 = 7 处").toBeGreaterThanOrEqual(7)
  })

  it("7 个 lifecycle 函数名全部 present", () => {
    // ADR-31 工厂服务于 6 个 lifecycle 函数 + startDeepChapterSession (start 路径)。
    // 这 7 个函数名是 status.json 真源生命周期的完整契约面, 任何一个消失都意味着
    // 生命周期断链。逐一断言, 失败信息指明缺失的函数名。
    const expected = [
      "startDeepChapterSession",
      "persistDeepChapterCheckpoint",
      "completeDeepChapterSession",
      "pauseDeepChapterSession",
      "blockDeepChapterSession",
      "acceptDeepChapterDraft",
      "rejectDeepChapterDraft",
    ]
    for (const name of expected) {
      const pattern = new RegExp(`export\\s+async\\s+function\\s+${name}\\b`)
      expect(
        pattern.test(source),
        `lifecycle 函数 ${name} 应作为 export async function 存在`,
      ).toBe(true)
    }
  })
})
