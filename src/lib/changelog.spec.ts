import { describe, expect, it } from "vitest"
import { allChangelog, currentVersionChangelog } from "./changelog"

describe("changelog", () => {
  it("shows the latest visible 2.3 and 2.2 releases before earlier releases", () => {
    const entries = allChangelog()
    const versions = entries.map((entry) => entry.version)

    // 2.6.0 头部 + 2.5.1 + 2.5.0 + 2.4.x 链（2.6.0 发布后整体后移）
    expect(versions.slice(0, 10)).toEqual(["2.6.0", "2.5.1", "2.5.0", "2.4.11", "2.4.10", "2.4.6", "2.4.5", "2.4.4", "2.4.3", "2.4.2"])
    expect(versions[10]).toBe("2.4.1")
    expect(versions[11]).toBe("2.4.0")
    expect(versions[12]).toBe("2.3.2")
    expect(versions[13]).toBe("2.3.1")
    expect(versions[14]).toBe("2.3.0")
    // 2.2.x patch chain starts after 2.6.0 + 2.5.x + 2.4.x + 2.3.x heads
    expect(versions.slice(15, 35)).toEqual([
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
