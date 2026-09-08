import { describe, expect, it } from "vitest"
import { allChangelog, currentVersionChangelog, ENTRIES } from "./changelog"

describe("changelog", () => {
  it("shows the latest visible 2.3 and 2.2 releases before earlier releases", () => {
    const entries = allChangelog()
    const versions = entries.map((entry) => entry.version)

    // 2.6.3 头部 + 2.6.2 + 2.6.1 + 2.6.0 + 2.5.1 + 2.5.0 + 2.4.x 链（2.6.3 发布后整体后移）
    expect(versions.slice(0, 10)).toEqual(["2.6.3", "2.6.2", "2.6.1", "2.6.0", "2.5.1", "2.5.0", "2.4.11", "2.4.10", "2.4.6", "2.4.5"])
    expect(versions[10]).toBe("2.4.4")
    expect(versions[11]).toBe("2.4.3")
    expect(versions[12]).toBe("2.4.2")
    expect(versions[13]).toBe("2.4.1")
    expect(versions[14]).toBe("2.4.0")
    expect(versions[15]).toBe("2.3.2")
    expect(versions[16]).toBe("2.3.1")
    expect(versions[17]).toBe("2.3.0")
    // 2.2.x patch chain starts after 2.6.x + 2.5.x + 2.4.x + 2.3.x heads
    expect(versions.slice(18, 38)).toEqual([
      "2.2.24", "2.2.23", "2.2.22", "2.2.21", "2.2.20",
      "2.2.19", "2.2.18", "2.2.17", "2.2.16", "2.2.14",
      "2.2.13", "2.2.12", "2.2.11", "2.2.10", "2.2.9",
      "2.2.8", "2.2.7", "2.2.0", "2.1.0", "2.0.0",
    ])

    for (let patch = 1; patch <= 6; patch += 1) {
      expect(versions).not.toContain(`2.2.${patch}`)
      expect(currentVersionChangelog(`2.2.${patch}`)).toEqual([])
    }
    for (let patch = 1; patch <= 10; patch += 1) {
      expect(versions).not.toContain(`2.1.${patch}`)
      expect(currentVersionChangelog(`2.1.${patch}`)).toEqual([])
    }
    for (let patch = 1; patch <= 12; patch += 1) {
      expect(versions).not.toContain(`2.0.${patch}`)
      expect(currentVersionChangelog(`2.0.${patch}`)).toEqual([])
    }

    expect(versions).toContain("1.0.7")
    for (let patch = 8; patch <= 32; patch += 1) {
      expect(versions).not.toContain(`1.0.${patch}`)
    }

    const release = currentVersionChangelog("2.0.0")[0]
    expect(release.highlights.en.join("\n")).toContain("Major release")
    expect(release.highlights.en.join("\n")).toContain("Review Center")
    expect(release.highlights.en.join("\n")).toContain("AI Rewrite")
  })

  it("returns the 2.2.0 changelog entry", () => {
    const release = currentVersionChangelog("2.2.0")[0]
    const zh = release.highlights.zh.join("\n")
    const en = release.highlights.en.join("\n")

    expect(release.version).toBe("2.2.0")
    expect(en).toContain("Continue Next Chapter")
    expect(en).toContain("target chapter number")
    expect(en).toContain("Character Soul")
    expect(en).toContain("2,200-3,200")
    expect(en).toContain("network errors")
    expect(zh).not.toContain("鑱旂郴鏂瑰紡")
  })

  it("returns the 2.4.10 / 2.4.8 / 2.4.7 changelog entries", () => {
    for (const v of ["2.5.0", "2.4.11", "2.4.10", "2.4.8", "2.4.7"]) {
      const entries = currentVersionChangelog(v)
      expect(entries).toHaveLength(1)
      expect(entries[0]!.version).toBe(v)
    }
  })

  it("returns the 2.2.7 changelog entry for the hidden dismantling library and resume recovery", () => {
    const release = currentVersionChangelog("2.2.7")[0]
    const en = release.highlights.en.join("\n")

    expect(release.version).toBe("2.2.7")
    expect(en).toContain("Hidden the Dismantling Library UI")
    expect(en).toContain("Removed the 2.2.6 to 2.2.1 release notes")
    expect(en).toContain("saved stage checkpoint")
    expect(en).toContain("Switching models")
    expect(en).toContain("newly inserted paragraph")
  })
  it("returns the 2.2.8 changelog entry for review fixes and deep chapter length control", () => {
    const release = currentVersionChangelog("2.2.8")[0]
    const en = release.highlights.en.join("\n")

    expect(release.version).toBe("2.2.8")
    expect(en).toContain("local-environment LLM defaults")
    expect(en).toContain("selected chapter file names")
    expect(en).toContain("different projects no longer share retrieval graphs")
    expect(en).toContain("3,500-character cap")
    expect(en).toContain("6,000 characters")
  })

  it("returns the 2.2.9 changelog entry for the outline crash fix", () => {
    const release = currentVersionChangelog("2.2.9")[0]
    const zh = release.highlights.zh.join("\n")
    const en = release.highlights.en.join("\n")

    expect(release.version).toBe("2.2.9")
    expect(en).toContain("undefined length/trim errors")
    expect(zh).toContain("length / trim")
    expect(zh).toContain("大纲上下文或对话字段缺失")
  })

  it("returns the 2.2.11 changelog entry for toolbar, de-ai, and local cli fixes", () => {
    const release = currentVersionChangelog("2.2.11")[0]
    const zh = release.highlights.zh.join("\n")
    const en = release.highlights.en.join("\n")

    expect(release.version).toBe("2.2.11")
    expect(en).toContain("full right-side chapter toolbar")
    expect(en).toContain("2,200-3,200")
    expect(en).toContain("Claude Code CLI")
    expect(zh).toContain("保存到章节库")
    expect(zh).toContain("2200-3200")
    expect(zh).toContain("本地 Claude Code CLI / Codex CLI")
  })

  it.each([
    "2.4.8", "2.4.7", "2.4.6", "2.4.5", "2.4.4", "2.4.3", "2.4.2", "2.4.1", "2.4.0",
    "2.3.2", "2.3.1", "2.3.0",
    "2.2.24", "2.2.23", "2.2.22", "2.2.21", "2.2.20", "2.2.19", "2.2.18", "2.2.17", "2.2.16",
    "2.2.14", "2.2.13", "2.2.12", "2.2.10",
    "2.1.0",
  ])("returns the changelog entry for %s", (version) => {
    const entries = currentVersionChangelog(version)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.version).toBe(version)
  })

  it("returns empty for merged one-point releases and unmatched versions", () => {
    expect(currentVersionChangelog("1.0.20")).toEqual([]) // merged 1.0.8..1.0.32
    expect(currentVersionChangelog("1.0.33")).toEqual([]) // patch > 32: not merged
    expect(currentVersionChangelog("2.0.13")).toEqual([]) // 2.0.x beyond the merged block
    expect(currentVersionChangelog("0.9.1")).toEqual([]) // no matching entry
  })
})

// ── P0 batch A3 invariant upgrades ───────────────────────────────────────────
//
// Design decision (reported): the pre-A3 idea "allChangelog()[0] >= pkg.version"
// anchors on the WRONG view. allChangelog is the frozen HISTORY view
// (HISTORY_CEILING = 2.6.3, intentional A1/A2 freeze), so its head is pinned at
// the ceiling, never at pkg.version. The "newest entry may lead the released
// version" invariant anchors on ENTRIES (the draft head 2.7.10 may lead
// pkg.version 2.7.9 by one unreleased version), and the "released version is
// visible" invariant anchors on ENTRIES + currentVersionChangelog(pkg.version)
// — NOT on allChangelog, which deliberately freezes 2.7.x out of the history.
// The draft lead is additionally bounded (D3, PASS-with-notes fix): the
// ENTRIES head may be at most ONE unreleased version above pkg.version
// (head <= major.minor.(patch+1)), closing the lockstep blind spot.

/** HIDDEN_VERSIONS mirror (changelog.ts): folded releases, never surfaced. */
const HIDDEN_RELEASES = [
  "2.2.1", "2.2.2", "2.2.3", "2.2.4", "2.2.5", "2.2.6",
  "2.1.1", "2.1.2", "2.1.3", "2.1.4", "2.1.5", "2.1.6", "2.1.7", "2.1.8", "2.1.9", "2.1.10",
  "2.0.1", "2.0.2", "2.0.3", "2.0.4", "2.0.5", "2.0.6", "2.0.7", "2.0.8", "2.0.9", "2.0.10", "2.0.11", "2.0.12",
]

/** HISTORY_SKIPPED_VERSIONS mirror: in ENTRIES, but skipped by the frozen hand-maintained history. */
const HISTORY_SKIPPED = ["2.4.7", "2.4.8"]

/** 1.0.8..1.0.32 merged into the single 1.0.7 entry (isMergedOnePointRelease). */
const MERGED_ONE_POINT = Array.from({ length: 25 }, (_, i) => `1.0.${i + 8}`)

function compareSemver(a: string, b: string): number {
  const aParts = a.split(".").map(Number)
  const bParts = b.split(".").map(Number)
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** One release step above `version` (patch + 1, e.g. 2.7.9 -> 2.7.10): the
 * D3 upper bound on how far the ENTRIES draft head may lead pkg.version —
 * at most ONE unreleased version. Deliberately NOT the consistency spec's
 * minor+1.0 bound, which would silently let two concurrent drafts (2.7.11
 * and 2.7.12 lockstep with md) slip through. */
function oneVersionAheadOf(version: string): string {
  const [major, minor, patch] = version.split(".").map(Number)
  return `${major}.${minor ?? 0}.${(patch ?? 0) + 1}`
}

describe("changelog invariants (P0 A3)", () => {
  it("ENTRIES is strictly descending; the draft head may lead pkg.version by at most one version", () => {
    const versions = ENTRIES.map((entry) => entry.version)

    for (let i = 1; i < versions.length; i += 1) {
      expect(compareSemver(versions[i - 1]!, versions[i]!)).toBeGreaterThan(0)
    }

    // Draft period: the newest entry (2.7.10) may be one unreleased version
    // ahead of pkg.version (2.7.9). The pre-A3 "latest >= pkg.version" intent
    // is anchored here, at the entry level — never on the frozen history view.
    expect(compareSemver(versions[0]!, __APP_VERSION__)).toBeGreaterThanOrEqual(0)

    // A3 D3 upper bound (PASS-with-notes fix): the lead is capped at ONE
    // unreleased version. A second draft entry (2.7.11 while pkg is 2.7.9)
    // must fail even in lockstep with md — the consistency spec's minor+1.0
    // bound (2.8.0) cannot see that, which was the demonstrated blind spot.
    expect(compareSemver(versions[0]!, oneVersionAheadOf(__APP_VERSION__))).toBeLessThanOrEqual(0)
  })

  it("the released pkg.version stays visible via ENTRIES / exact lookup", () => {
    const versions = ENTRIES.map((entry) => entry.version)

    // The A3 toContain anchor: pkg.version must exist as an entry and be
    // served by currentVersionChangelog — even though HISTORY_CEILING keeps
    // it out of allChangelog (2.7.9 > 2.6.3).
    expect(versions).toContain(__APP_VERSION__)
    const release = currentVersionChangelog(__APP_VERSION__)
    expect(release).toHaveLength(1)
    expect(release[0]!.version).toBe(__APP_VERSION__)
  })

  it("allChangelog stays frozen at the 2.6.3 ceiling by design (A1/A2)", () => {
    const versions = allChangelog().map((entry) => entry.version)

    // Freeze-faithful: the history head is pinned to HISTORY_CEILING.
    expect(versions[0]).toBe("2.6.3")
    for (const version of versions) {
      expect(compareSemver(version, "2.6.3")).toBeLessThanOrEqual(0)
    }

    // The released version (2.7.9) and the draft head (2.7.10) are beyond the
    // ceiling: they must NOT appear in the history view — they are served by
    // currentVersionChangelog instead (see the sibling assertion above).
    expect(versions).not.toContain(__APP_VERSION__)
    expect(versions).not.toContain("2.7.10")
  })

  it("hidden, merged and history-skipped versions never leak into ENTRIES/history", () => {
    const entryVersions = ENTRIES.map((entry) => entry.version)
    const historyVersions = allChangelog().map((entry) => entry.version)
    const hidden = [...HIDDEN_RELEASES, ...MERGED_ONE_POINT]

    for (const version of hidden) {
      expect(entryVersions).not.toContain(version)
      expect(historyVersions).not.toContain(version)
      expect(currentVersionChangelog(version)).toEqual([])
    }

    // Skipped versions are a history-view-only freeze quirk: they stay
    // reachable by exact lookup but never appear in allChangelog.
    for (const version of HISTORY_SKIPPED) {
      expect(entryVersions).toContain(version)
      expect(currentVersionChangelog(version)).toHaveLength(1)
      expect(historyVersions).not.toContain(version)
    }
  })
})
