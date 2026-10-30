import { describe, expect, it } from "vitest"
import {
  auditHistory,
  evaluateLatestAssets,
  evaluateTarget,
  isoWeekKey,
  localDay,
  stableReleases,
} from "./check-release-cadence.mjs"

const rel = (tagName, publishedAt, extra = {}) => ({
  tagName,
  publishedAt,
  isDraft: false,
  isPrerelease: false,
  isLatest: false,
  ...extra,
})

describe("release cadence gate", () => {
  it("groups by local day and ISO week starting Monday", () => {
    // 2026-10-18 是周日；10-17 是周六 → 同一 ISO 周（周一起算）
    expect(isoWeekKey("2026-10-18T02:13:27Z")).toBe(isoWeekKey("2026-10-17T14:17:36Z"))
    // 2026-10-19 是下周一 → 新周
    expect(isoWeekKey("2026-10-19T02:00:00Z")).not.toBe(isoWeekKey("2026-10-18T02:00:00Z"))
    expect(localDay("2026-10-18T02:13:27Z")).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("ignores prerelease and draft releases in the stable series", () => {
    const stables = stableReleases([
      rel("v1.0.0", "2026-10-01T00:00:00Z"),
      rel("v1.0.1", "2026-10-02T00:00:00Z", { isPrerelease: true }),
      rel("v1.0.2", "2026-10-03T00:00:00Z", { isDraft: true }),
    ])
    expect(stables.map((r) => r.tagName)).toEqual(["v1.0.0"])
  })

  it("flags a second stable in the same ISO week", () => {
    const releases = [rel("v1.0.0", "2026-10-17T14:17:36Z"), rel("v1.0.1", "2026-10-18T02:13:27Z")]
    const gate = evaluateTarget(releases, "v1.0.1", [])
    expect(gate.rules.map((r) => r.rule)).toEqual(["weekly-stable"])
    expect(gate.rules[0].exempted).toBeUndefined()
  })

  it("flags two stables on the same local day", () => {
    const releases = [rel("v1.0.0", "2026-10-18T00:10:00Z"), rel("v1.0.1", "2026-10-18T02:13:27Z")]
    const rules = evaluateTarget(releases, "v1.0.1", []).rules.map((r) => r.rule)
    expect(rules).toContain("same-day-duplicate")
  })

  it("flags more than four stable releases in the trailing 30 days", () => {
    const releases = [1, 2, 3, 4, 5].map((n) => rel(`v2.0.${n}`, `2026-09-${10 + n}T00:00:00Z`))
    const rules = evaluateTarget(releases, "v2.0.5", []).rules.map((r) => r.rule)
    expect(rules).toContain("thirty-day-stable")
  })

  it("exemptions cover only the declared rules and keep the basis visible", () => {
    const releases = [rel("v2.17.0", "2026-10-17T14:17:36Z"), rel("v2.17.1", "2026-10-18T02:13:27Z")]
    const exemptions = [
      { tag: "v2.17.1", reason: "fix-forward", approvedAt: "2026-10-18", scope: ["weekly-stable"] },
    ]
    const gate = evaluateTarget(releases, "v2.17.1", exemptions)
    const weekly = gate.rules.find((r) => r.rule === "weekly-stable")
    expect(weekly.exempted).toBe(true)
    expect(weekly.reason).toBe("fix-forward")
    // 未列入 scope 的同日重复仍会报（本用例同周但不同日，只有 weekly 一条）
    expect(gate.rules.filter((r) => !r.exempted)).toEqual([])
  })

  it("does not resurrect historical violations when gating a clean target", () => {
    const releases = [
      rel("v1.0.0", "2026-08-01T00:00:00Z"),
      rel("v1.0.1", "2026-08-01T06:00:00Z"), // 历史同日重复
      rel("v1.1.0", "2026-09-20T00:00:00Z"),
      rel("v1.1.1", "2026-10-16T00:00:00Z"),
    ]
    const gate = evaluateTarget(releases, "v1.1.1", [])
    expect(gate.rules).toEqual([])
    const history = auditHistory(releases)
    expect(history.stableTotal).toBe(4)
    expect(history.days).toBe(1)
  })

  it("requires latest.json plus a signed installer and tolerates portable without sig", () => {
    const latest = rel("v2.17.1", "2026-10-18T02:13:27Z", { isLatest: true })
    const ok = evaluateLatestAssets(latest, [
      "latest.json",
      "niko-buddy_2.17.1_windows_X64.exe",
      "niko-buddy_2.17.1_windows_X64.exe.sig",
      "niko-buddy_2.17.1_windows_X64_portable.exe",
    ])
    expect(ok).toEqual([])

    const bad = evaluateLatestAssets(latest, ["niko-buddy_2.17.1_windows_X64.exe"])
    expect(bad).toContain("缺 latest.json")
    expect(bad).toContain("缺 niko-buddy_2.17.1_windows_X64.exe.sig")

    expect(evaluateLatestAssets({ ...latest, isPrerelease: true }, ["latest.json"])).toContain(
      "被审 release 标记为 prerelease",
    )
  })

  it("--tag 显式审 prerelease：不把 prerelease 标记当资产问题，资产与 draft 仍照查", () => {
    const pre = rel("v2.23.0", "2026-10-30T15:00:00Z", { isPrerelease: true })
    const assets = [
      "latest.json",
      "niko-buddy_2.23.0_windows_X64.exe",
      "niko-buddy_2.23.0_windows_X64.exe.sig",
      "niko-buddy_2.23.0_windows_X64_portable.exe",
    ]
    expect(evaluateLatestAssets(pre, assets, { allowPrerelease: true })).toEqual([])
    expect(evaluateLatestAssets(pre, assets)).toEqual(["被审 release 标记为 prerelease"])
    expect(evaluateLatestAssets(pre, ["niko-buddy_2.23.0_windows_X64.exe"], { allowPrerelease: true })).toEqual([
      "缺 latest.json",
      "缺 niko-buddy_2.23.0_windows_X64.exe.sig",
    ])
    expect(evaluateLatestAssets({ ...pre, isDraft: true }, assets, { allowPrerelease: true })).toEqual([
      "被审 release 是 draft",
    ])
  })
})
