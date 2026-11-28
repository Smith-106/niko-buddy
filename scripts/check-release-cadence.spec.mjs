import { describe, expect, it, vi } from "vitest"
import {
  allowsPrerelease,
  auditHistory,
  evaluateDraftPromotion,
  evaluateLatestAssets,
  evaluateTarget,
  expectedPortableAssetName,
  isoWeekKey,
  localDay,
  main,
  readDraftReleasePages,
  readDraftAssetPages,
  readPublishedReleasePages,
  resolveBaseRef,
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
  it("groups by UTC day and ISO week starting Monday (timezone-independent)", () => {
    // 2026-10-18 是 UTC 周日；10-17 是 UTC 周六 → 同一 ISO 周（2026-10-12）
    expect(localDay("2026-10-18T00:13:27Z")).toBe("2026-10-18")
    expect(localDay("2026-10-17T23:59:59Z")).toBe("2026-10-17")
    expect(isoWeekKey("2026-10-18T02:13:27Z")).toBe("2026-10-12")
    expect(isoWeekKey("2026-10-17T14:17:36Z")).toBe("2026-10-12")
    // 2026-10-19 是下周一 → 新周 2026-10-19
    expect(isoWeekKey("2026-10-19T00:00:00Z")).toBe("2026-10-19")
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
    expect(bad).toContain("缺便携版资产 niko-buddy_2.17.1_windows_X64_portable.exe")

    const wrongVersion = evaluateLatestAssets(latest, [
      "latest.json",
      "niko-buddy_2.16.0_windows_X64.exe",
      "niko-buddy_2.16.0_windows_X64.exe.sig",
      "niko-buddy_2.17.1_windows_X64_portable.exe",
    ])
    expect(wrongVersion).toContain("缺版本匹配安装包 niko-buddy_2.17.1_windows_X64.exe")

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

  it("allowsPrerelease：只有被审 tag 不是 Latest 时才放行 prerelease 标记", () => {
    const releases = [
      rel("v2.22.2", "2026-10-25T00:00:00Z", { isLatest: true }),
      rel("v2.23.0", "2026-10-30T00:00:00Z", { isPrerelease: true }),
    ]
    expect(allowsPrerelease(releases, "v2.23.0")).toBe(true)
    expect(allowsPrerelease(releases, "v2.22.2")).toBe(false)
    // Latest 被误标 prerelease 时，即使用 --tag 显式指定也不放行
    const misMarked = [rel("v2.23.0", "2026-10-30T00:00:00Z", { isPrerelease: true, isLatest: true })]
    expect(allowsPrerelease(misMarked, "v2.23.0")).toBe(false)
  })

  it("enforces _portable.zip starting at v2.37.0 while preserving historical _portable.exe compatibility", () => {
    expect(expectedPortableAssetName("2.36.0")).toBe("niko-buddy_2.36.0_windows_X64_portable.exe")
    expect(expectedPortableAssetName("2.37.0")).toBe("niko-buddy_2.37.0_windows_X64_portable.zip")
    expect(expectedPortableAssetName("3.0.0")).toBe("niko-buddy_3.0.0_windows_X64_portable.zip")

    const v237 = rel("v2.37.0", "2026-12-01T00:00:00Z", { isLatest: true })
    expect(
      evaluateLatestAssets(v237, [
        "latest.json",
        "niko-buddy_2.37.0_windows_X64.exe",
        "niko-buddy_2.37.0_windows_X64.exe.sig",
        "niko-buddy_2.37.0_windows_X64_portable.zip",
      ]),
    ).toEqual([])
    expect(
      evaluateLatestAssets(v237, [
        "latest.json",
        "niko-buddy_2.37.0_windows_X64.exe",
        "niko-buddy_2.37.0_windows_X64.exe.sig",
        "niko-buddy_2.37.0_windows_X64_portable.exe",
      ]),
    ).toContain("缺便携版资产 niko-buddy_2.37.0_windows_X64_portable.zip")
  })
})

describe("evaluateDraftPromotion：草稿晋升模拟（不发布）", () => {
  const exe = "niko-buddy_2.24.0_windows_X64.exe"
  const fullAssets = ["latest.json", exe, `${exe}.sig`, "niko-buddy_2.24.0_windows_X64_portable.exe"]

  it("唯一未公开 stable 草稿 + 四资产齐全 → 模拟晋升后按 stable 节奏评估", () => {
    const releases = [
      rel("v2.23.0", "2026-11-01T00:00:00Z", { isLatest: true }),
      rel("v2.24.0", null, { isDraft: true }),
    ]
    const { gate, assetProblems } = evaluateDraftPromotion(releases, "v2.24.0", fullAssets, "2026-11-20T00:00:00Z")
    expect(assetProblems).toEqual([])
    expect(gate.tag).toBe("v2.24.0")
    expect(gate.missing).not.toBe(true)
    // 草稿本身不计入 stable 历史审计
    const history = auditHistory(releases)
    expect(history.stableTotal).toBe(1)
  })

  it("缺 portable 资产 / 已发布目标 / 邻近 stable 同周日触发 → 如实拒绝", () => {
    const draft = rel("v2.24.0", null, { isDraft: true })
    const nearby = rel("v2.23.0", "2026-11-19T00:00:00Z", { isLatest: true })
    // 缺 portable → asset problem
    const missing = evaluateDraftPromotion([nearby, draft], "v2.24.0", ["latest.json", exe, `${exe}.sig`], "2026-11-20T00:00:00Z")
    expect(missing.assetProblems.some((p) => p.includes("portable"))).toBe(true)
    // 同日/同周已有 stable → gate 报节奏违规（非 missing）
    const blocked = evaluateDraftPromotion([nearby, draft], "v2.24.0", fullAssets, "2026-11-20T00:00:00Z")
    expect(blocked.gate.rules.length).toBeGreaterThan(0)
    // 已发布目标不属于草稿晋升
    const published = evaluateDraftPromotion([rel("v2.24.0", "2026-11-01T00:00:00Z")], "v2.24.0", fullAssets, "2026-11-20T00:00:00Z")
    expect(published.assetProblems).toEqual(["Expected one unpublished stable release draft"])
  })

  it("paginated draft read: cross-page stable draft → ID-bound assets, 上传不完整 fail-closed", () => {
    const releases = readDraftReleasePages([
      [{ id: 7, tag_name: "v2.23.0", draft: false, prerelease: false, published_at: "2026-11-01T00:00:00Z" }],
      [{ id: 9, tag_name: "v2.24.0", draft: true, prerelease: false, published_at: null }],
    ])
    const draft = releases.find((r) => r.id === 9)
    expect(draft?.isDraft).toBe(true)
    expect(releases.find((r) => r.id === 7)?.isLatest).toBe(false)

    const assetPages = [
      [
        { name: "latest.json", state: "uploaded", size: 1, digest: "sha256:" + "a".repeat(64) },
        { name: exe, state: "uploaded", size: 1, digest: "sha256:" + "a".repeat(64) },
      ],
      [
        { name: `${exe}.sig`, state: "uploaded", size: 1, digest: "sha256:" + "a".repeat(64) },
        { name: "niko-buddy_2.24.0_windows_X64_portable.exe", state: "uploaded", size: 1, digest: "sha256:" + "a".repeat(64) },
      ],
    ]
    const names = readDraftAssetPages(assetPages)
    const { assetProblems } = evaluateDraftPromotion(releases, "v2.24.0", names, "2026-11-20T00:00:00Z")
    expect(assetProblems).toEqual([])
    // pending state is not stable history
    const history = auditHistory(releases)
    expect(history.stableTotal).toBe(1)
    // fail-closed: pending state or missing digest both reject
    expect(() => readDraftAssetPages([[{ name: exe, state: "new", size: 1, digest: "sha256:" + "a".repeat(64) }]])).toThrow("Incomplete GitHub draft asset metadata")
    expect(() => readDraftAssetPages([[{ name: exe, state: "uploaded", size: 1 }]])).toThrow("Incomplete GitHub draft asset metadata")
  })

  it("refuses a published row without a publication timestamp", () => {
    expect(() => readDraftReleasePages([[{ id: 7, tag_name: "v2.23.0", draft: false, prerelease: false, published_at: null }]])).toThrow("Invalid GitHub release metadata")
  })

  it.each(["matched", "mismatch", "unavailable"])("checks the exact remote tag before allowing draft promotion: %s", (tagState) => {
    const tag = "v2.24.0"
    const ref = `refs/tags/${tag}`
    const localTag = "a".repeat(40)
    const repo = "Smith-106/niko-buddy"
    const run = vi.fn((cmd, args) => {
      if (cmd === "git") return args[0] === "merge-base" ? "" : localTag
      if (args.includes(`repos/${repo}/releases?per_page=100`)) {
        return JSON.stringify([[{ id: 9, tag_name: tag, draft: true, prerelease: false, published_at: null }]])
      }
      if (args.includes(`repos/${repo}/releases/9/assets?per_page=100`)) {
        return JSON.stringify([fullAssets.map(name => ({ name, state: "uploaded", size: 1, digest: "sha256:" + "b".repeat(64) }))])
      }
      if (args.includes(`repos/${repo}/git/ref/tags/${tag}`) && tagState !== "unavailable") {
        return JSON.stringify({ ref, object: { sha: tagState === "matched" ? localTag : "c".repeat(40) } })
      }
      throw new Error("synthetic ref lookup failure")
    })
    expect(main(["--tag", tag, "--draft-promotion", "--json"], run)).toBe(tagState === "matched" ? 0 : 1)
    expect(run).toHaveBeenCalledWith("git", ["merge-base", "--is-ancestor", `${ref}^{commit}`, "refs/remotes/smith/master"])
    expect(run).toHaveBeenCalledWith("gh", ["api", `repos/${repo}/git/ref/tags/${tag}`])
  })

  it.each([null, "not-a-date"])("refuses invalid published timestamps before evaluating cadence: %s", (publishedAt) => {
    const run = vi.fn(() => JSON.stringify([[{ tag_name: "v2.24.0", draft: false, prerelease: false, published_at: publishedAt }]]))
    expect(main(["--tag", "v2.24.0"], run)).toBe(2)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("fails on a missing target instead of passing an empty audit", () => {
    const repo = "Smith-106/niko-buddy"
    const run = vi.fn((cmd, args) => {
      if (args.includes(`repos/${repo}/releases?per_page=100`)) {
        return JSON.stringify([[{ tag_name: "v2.23.0", draft: false, prerelease: false, published_at: "2026-11-01T00:00:00Z" }]])
      }
      if (args.includes(`repos/${repo}/releases/latest`)) {
        return JSON.stringify({ tag_name: "v2.23.0" })
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`)
    })
    expect(main(["--tag", "v2.24.0"], run)).toBe(1)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("rejects a missing option value before starting any command", () => {
    const run = vi.fn()
    expect(main(["--tag", "--json"], run)).toBe(2)
    expect(main(["--base-ref", "--json"], run)).toBe(2)
    expect(run).not.toHaveBeenCalled()
  })
})

describe("paginated published releases & base-ref resolution", () => {
  const repo = "Smith-106/niko-buddy"
  const fullAssets = (ver) => [
    "latest.json",
    `niko-buddy_${ver}_windows_X64.exe`,
    `niko-buddy_${ver}_windows_X64.exe.sig`,
    `niko-buddy_${ver}_windows_X64_portable.exe`,
  ]

  it("merges multi-page published releases and marks isLatest from /releases/latest", () => {
    const merged = readPublishedReleasePages(
      [
        [
          { tag_name: "v2.25.0", draft: false, prerelease: false, published_at: "2026-11-20T00:00:00Z" },
          { tag_name: "v2.26.0", draft: true, prerelease: false, published_at: null },
        ],
        [
          { tag_name: "v2.24.0", draft: false, prerelease: false, published_at: "2026-11-01T00:00:00Z" },
          { tag_name: "v2.23.0", draft: false, prerelease: true, published_at: "2026-10-20T00:00:00Z" },
        ],
      ],
      "v2.25.0",
    )
    expect(merged).toHaveLength(4)
    expect(merged.find((r) => r.tagName === "v2.25.0")?.isLatest).toBe(true)
    expect(merged.find((r) => r.tagName === "v2.24.0")?.isLatest).toBe(false)
    expect(merged.find((r) => r.tagName === "v2.26.0")?.isLatest).toBe(false)

    // 跨页审计：page 1 和 page 2 同周发两个 stable → 合并后能正确抓出 weekly-stable 违规
    const sha = "a".repeat(40)
    const run = vi.fn((cmd, args) => {
      if (cmd === "gh" && args.includes(`repos/${repo}/releases?per_page=100`)) {
        return JSON.stringify([
          [{ tag_name: "v2.25.0", draft: false, prerelease: false, published_at: "2026-11-18T10:00:00Z" }],
          [{ tag_name: "v2.24.0", draft: false, prerelease: false, published_at: "2026-11-17T10:00:00Z" }],
        ])
      }
      if (cmd === "gh" && args.includes(`repos/${repo}/releases/latest`)) {
        return JSON.stringify({ tag_name: "v2.25.0" })
      }
      if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
        return JSON.stringify({ assets: fullAssets("2.25.0").map((name) => ({ name })) })
      }
      if (cmd === "gh" && args.includes(`repos/${repo}/git/ref/tags/v2.25.0`)) {
        return JSON.stringify({ ref: "refs/tags/v2.25.0", object: { sha } })
      }
      if (cmd === "git") return args[0] === "merge-base" ? "" : sha
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`)
    })
    expect(main(["--json"], run)).toBe(1)
    expect(run).toHaveBeenCalledWith("gh", ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`])
    expect(run).toHaveBeenCalledWith("gh", ["api", `repos/${repo}/releases/latest`])
  })

  it("falls back to refs/remotes/origin/master when smith/master is absent", () => {
    const runProbe = vi.fn((_cmd, args) => {
      if (args[2] === "refs/remotes/smith/master") throw new Error("not found")
      if (args[2] === "refs/remotes/origin/master") return "a".repeat(40)
      throw new Error(`unexpected probe: ${args.join(" ")}`)
    })
    expect(resolveBaseRef(null, false, runProbe)).toBe("refs/remotes/origin/master")
    expect(runProbe).toHaveBeenNthCalledWith(1, "git", ["rev-parse", "--verify", "refs/remotes/smith/master"])
    expect(runProbe).toHaveBeenNthCalledWith(2, "git", ["rev-parse", "--verify", "refs/remotes/origin/master"])

    // 两者均不存在时兜底 refs/remotes/smith/master
    const runEmpty = vi.fn(() => {
      throw new Error("not found")
    })
    expect(resolveBaseRef(null, false, runEmpty)).toBe("refs/remotes/smith/master")

    // main() 端到端验证回退 origin/master
    const sha = "a".repeat(40)
    const runMain = vi.fn((cmd, args) => {
      if (cmd === "gh" && args.includes(`repos/${repo}/releases?per_page=100`)) {
        return JSON.stringify([[{ tag_name: "v2.25.0", draft: false, prerelease: false, published_at: "2026-11-20T00:00:00Z" }]])
      }
      if (cmd === "gh" && args.includes(`repos/${repo}/releases/latest`)) {
        return JSON.stringify({ tag_name: "v2.25.0" })
      }
      if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
        return JSON.stringify({ assets: fullAssets("2.25.0").map((name) => ({ name })) })
      }
      if (cmd === "gh" && args.includes(`repos/${repo}/git/ref/tags/v2.25.0`)) {
        return JSON.stringify({ ref: "refs/tags/v2.25.0", object: { sha } })
      }
      if (cmd === "git" && args[0] === "rev-parse" && args[2] === "refs/remotes/smith/master") {
        throw new Error("missing smith remote")
      }
      if (cmd === "git") return sha
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`)
    })
    expect(main(["--json"], runMain)).toBe(0)
    expect(runMain).toHaveBeenCalledWith("git", ["merge-base", "--is-ancestor", "refs/tags/v2.25.0^{commit}", "refs/remotes/origin/master"])
  })

  it("honors explicit --base-ref override without probing remote defaults", () => {
    const runUnused = vi.fn()
    expect(resolveBaseRef("refs/heads/release-main", false, runUnused)).toBe("refs/heads/release-main")
    expect(runUnused).not.toHaveBeenCalled()

    const sha = "a".repeat(40)
    const runMain = vi.fn((cmd, args) => {
      if (cmd === "gh" && args.includes(`repos/${repo}/releases?per_page=100`)) {
        return JSON.stringify([[{ tag_name: "v2.25.0", draft: false, prerelease: false, published_at: "2026-11-20T00:00:00Z" }]])
      }
      if (cmd === "gh" && args.includes(`repos/${repo}/releases/latest`)) {
        return JSON.stringify({ tag_name: "v2.25.0" })
      }
      if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
        return JSON.stringify({ assets: fullAssets("2.25.0").map((name) => ({ name })) })
      }
      if (cmd === "gh" && args.includes(`repos/${repo}/git/ref/tags/v2.25.0`)) {
        return JSON.stringify({ ref: "refs/tags/v2.25.0", object: { sha } })
      }
      if (cmd === "git") return sha
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`)
    })
    expect(main(["--tag", "v2.25.0", "--base-ref", "refs/heads/release-main", "--json"], runMain)).toBe(0)
    expect(runMain).toHaveBeenCalledWith("git", ["merge-base", "--is-ancestor", "refs/tags/v2.25.0^{commit}", "refs/heads/release-main"])
    expect(runMain).not.toHaveBeenCalledWith("git", ["rev-parse", "--verify", "refs/remotes/smith/master"])
    expect(runMain).not.toHaveBeenCalledWith("git", ["rev-parse", "--verify", "refs/remotes/origin/master"])
  })

  it("skips untagged GitHub drafts without crashing in both published and draft readers", () => {
    const published = readPublishedReleasePages(
      [[
        { tag_name: "", draft: true, prerelease: false, published_at: null },
        { tag_name: null, draft: true, prerelease: false, published_at: null },
        { tag_name: "v2.25.0", draft: false, prerelease: false, published_at: "2026-11-20T00:00:00Z" },
      ]],
      "v2.25.0",
    )
    expect(published).toHaveLength(1)
    expect(published[0].tagName).toBe("v2.25.0")

    const drafts = readDraftReleasePages([[
      { id: 1, tag_name: "", draft: true, prerelease: false, published_at: null },
      { id: 2, tag_name: "v2.26.0", draft: true, prerelease: false, published_at: null },
    ]])
    expect(drafts).toHaveLength(1)
    expect(drafts[0].tagName).toBe("v2.26.0")
  })

  it("fails closed on non-draft release when local tag is missing or remote tag mismatches", () => {
    const sha = "a".repeat(40)
    const runMissingLocal = vi.fn((cmd, args) => {
      if (cmd === "gh" && args.includes(`repos/${repo}/releases?per_page=100`)) {
        return JSON.stringify([[{ tag_name: "v2.25.0", draft: false, prerelease: false, published_at: "2026-11-20T00:00:00Z" }]])
      }
      if (cmd === "gh" && args.includes(`repos/${repo}/releases/latest`)) {
        return JSON.stringify({ tag_name: "v2.25.0" })
      }
      if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
        return JSON.stringify({ assets: fullAssets("2.25.0").map((name) => ({ name })) })
      }
      if (cmd === "git") throw new Error("unknown revision")
      throw new Error(`unexpected: ${cmd} ${args.join(" ")}`)
    })
    expect(main(["--json"], runMissingLocal)).toBe(1)

    const runMismatchRemote = vi.fn((cmd, args) => {
      if (cmd === "gh" && args.includes(`repos/${repo}/releases?per_page=100`)) {
        return JSON.stringify([[{ tag_name: "v2.25.0", draft: false, prerelease: false, published_at: "2026-11-20T00:00:00Z" }]])
      }
      if (cmd === "gh" && args.includes(`repos/${repo}/releases/latest`)) {
        return JSON.stringify({ tag_name: "v2.25.0" })
      }
      if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
        return JSON.stringify({ assets: fullAssets("2.25.0").map((name) => ({ name })) })
      }
      if (cmd === "gh" && args.includes(`repos/${repo}/git/ref/tags/v2.25.0`)) {
        return JSON.stringify({ ref: "refs/tags/v2.25.0", object: { sha: "b".repeat(40) } })
      }
      if (cmd === "git") return sha
      throw new Error(`unexpected: ${cmd} ${args.join(" ")}`)
    })
    expect(main(["--json"], runMismatchRemote)).toBe(1)
  })

  it("emits valid JSON payload on all --json early-return error paths", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      // 1. parseArgs error
      expect(main(["--tag", "--json"], vi.fn())).toBe(2)
      expect(JSON.parse(logSpy.mock.calls.at(-1)[0])).toMatchObject({ ok: false, exitCode: 2 })

      // 2. invalid --draft-promotion args
      expect(main(["--draft-promotion", "--json"], vi.fn())).toBe(2)
      expect(JSON.parse(logSpy.mock.calls.at(-1)[0])).toMatchObject({ ok: false, exitCode: 2 })

      // 3. gh read failure
      expect(main(["--json"], vi.fn(() => { throw new Error("gh offline") }))).toBe(2)
      expect(JSON.parse(logSpy.mock.calls.at(-1)[0])).toMatchObject({ ok: false, exitCode: 2 })

      // 4. missing targetTag (no latest and no --tag)
      expect(
        main(
          ["--json"],
          vi.fn((_cmd, args) => {
            if (args.includes(`repos/${repo}/releases?per_page=100`)) return JSON.stringify([[]])
            throw new Error("404 Not Found")
          }),
        ),
      ).toBe(2)
      expect(JSON.parse(logSpy.mock.calls.at(-1)[0])).toMatchObject({ ok: false, exitCode: 2 })

      // 5. missing target release
      expect(
        main(
          ["--tag", "v9.9.9", "--json"],
          vi.fn((_cmd, args) => {
            if (args.includes(`repos/${repo}/releases?per_page=100`)) {
              return JSON.stringify([[{ tag_name: "v2.25.0", draft: false, prerelease: false, published_at: "2026-11-20T00:00:00Z" }]])
            }
            return JSON.stringify({ tag_name: "v2.25.0" })
          }),
        ),
      ).toBe(1)
      expect(JSON.parse(logSpy.mock.calls.at(-1)[0])).toMatchObject({ ok: false, exitCode: 1, tag: "v9.9.9" })
    } finally {
      logSpy.mockRestore()
    }
  })
})
