// Consistency spec: ties the single source of truth for the in-app changelog
// (src/lib/changelog.ts ENTRIES) to the human-maintained release notes
// (CHANGELOG.md at the repo root). Human-written assertions only — nothing
// here regenerates content.
//
// Coverage-floor design decision (P0 A3, reported): CHANGELOG.md started
// recording `## [x.y.z]` titles at 2.4.0. Pre-2.4.0 history (2.3.x/2.2.x/
// 2.1.0/2.0.0/1.0.x/0.4.x legacy) exists only inside ENTRIES as in-app
// entries carried over from the pre-refactor consts, so the md-vs-ENTRIES
// agreement assertions are scoped to the MD_COVERAGE_FLOOR window. 2.4.9 is
// the one documented md-only exception (release notes recorded it; the app
// never shipped a separate entry for it). md titles carrying a "+suffix"
// (e.g. [2.4.6+docs-cleanup], [2.4.5+midloop]) normalize to their base
// version. The draft head 2.7.10 has a draft title in md, so the newest-version
// rule allows md to lead ENTRIES by at most one unreleased minor.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { ENTRIES } from "./changelog"

/** Earliest version with a `## [x.y.z]` title in CHANGELOG.md (coverage start). */
const MD_COVERAGE_FLOOR = "2.4.0"
/** Versions documented in md but intentionally absent from ENTRIES. */
const MD_ONLY_EXCEPTIONS = ["2.4.9"]

function compareSemver(a: string, b: string): number {
  const aParts = a.split(".").map(Number)
  const bParts = b.split(".").map(Number)
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function parseMarkdownVersionTitles(): { rawTitles: string[]; versions: string[] } {
  const md = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8")
  const rawTitles = [...md.matchAll(/^##\s+\[([^\]]+)\]/gm)].map((match) => match[1]!)
  const versions = rawTitles
    .map((title) => title.split("+")[0]!)
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
  return { rawTitles, versions }
}

function newestOf(versions: Iterable<string>): string {
  const list = [...versions]
  list.sort((a, b) => compareSemver(b, a))
  return list[0]!
}

describe("changelog consistency (ENTRIES <-> CHANGELOG.md)", () => {
  const { rawTitles, versions: mdVersions } = parseMarkdownVersionTitles()
  const mdWindow = new Set(mdVersions.filter((v) => compareSemver(v, MD_COVERAGE_FLOOR) >= 0))
  const entryVersions = ENTRIES.map((entry) => entry.version)
  const entriesWindow = new Set(entryVersions.filter((v) => compareSemver(v, MD_COVERAGE_FLOOR) >= 0))

  it("CHANGELOG.md covers every ENTRIES version at or above the coverage floor", () => {
    const missing = entryVersions
      .filter((v) => compareSemver(v, MD_COVERAGE_FLOOR) >= 0)
      .filter((v) => !mdWindow.has(v))
    expect(missing).toEqual([])
  })

  it("md and ENTRIES agree on the window version set (md extras must be declared)", () => {
    const mdOnly = [...mdWindow].filter((v) => !entriesWindow.has(v)).sort((a, b) => compareSemver(a, b))
    expect(mdOnly).toEqual(MD_ONLY_EXCEPTIONS)

    const entriesOnly = [...entriesWindow].filter((v) => !mdWindow.has(v)).sort((a, b) => compareSemver(a, b))
    expect(entriesOnly).toEqual([])
  })

  it("md newest does not lag ENTRIES newest (draft lead <= 1 unreleased minor)", () => {
    const mdNewest = newestOf(mdWindow)
    const entriesNewest = newestOf(entriesWindow)

    // md may carry the draft title (2.7.10) while ENTRIES still ends at the
    // released version — but md must never be older than the ENTRIES head.
    expect(compareSemver(mdNewest, entriesNewest)).toBeGreaterThanOrEqual(0)

    // And the lead is bounded: at most one unreleased minor version.
    const [major, minor] = entriesNewest.split(".").map(Number)
    const oneMinorAhead = `${major}.${(minor ?? 0) + 1}.0`
    expect(compareSemver(mdNewest, oneMinorAhead)).toBeLessThanOrEqual(0)
  })

  it("md titles are unique and strictly descending (by base version)", () => {
    // Raw headings must be unique (two identical `## [x.y.z]` headings are a
    // doc defect); "+suffix" wave variants (e.g. [2.4.6+docs-cleanup]) are
    // legitimate separate headings sharing one base version.
    expect(new Set(rawTitles).size).toBe(rawTitles.length)

    // Document order of the deduped base versions must be strictly descending
    // (Set preserves first-occurrence order).
    const ordered = [...new Set(mdVersions)]
    for (let i = 1; i < ordered.length; i += 1) {
      expect(compareSemver(ordered[i - 1]!, ordered[i]!)).toBeGreaterThan(0)
    }
  })
})
