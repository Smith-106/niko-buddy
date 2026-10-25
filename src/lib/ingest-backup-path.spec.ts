import { describe, expect, it } from "vitest"
import { sanitizeBackupRelativePath } from "./ingest"

// CWE-22: backupExistingPage flattens `relativePath` into a single
// filename segment under `.niko-buddy/page-history/`. These tests lock
// that `..`/absolute/drive/NUL payloads cannot escape that directory.
// The sanitizer is the single choke point used by backupExistingPage.

const PP = "P:/proj"
const BACKUP_DIR = `${PP}/.niko-buddy/page-history`
const STAMP = "2026-01-01T00-00-00-000Z"

function backupPathFor(relativePath: string): string {
  return `${BACKUP_DIR}/${sanitizeBackupRelativePath(relativePath)}-${STAMP}`
}

/** Shared containment assertion: single segment, still under page-history. */
function expectContained(relativePath: string): { sanitized: string; full: string } {
  const sanitized = sanitizeBackupRelativePath(relativePath)
  expect(sanitized).not.toContain("/")
  expect(sanitized).not.toContain("\\")
  expect(sanitized).not.toContain(":")
  expect(sanitized).not.toContain("\0")
  expect(sanitized.length).toBeGreaterThan(0)
  const full = backupPathFor(relativePath)
  expect(full.startsWith(`${BACKUP_DIR}/`)).toBe(true)
  // The filename segment itself must never be a traversal segment.
  const fileSegment = full.slice(BACKUP_DIR.length + 1)
  expect(fileSegment.split("/")).not.toContain("..")
  expect(fileSegment).not.toBe("..")
  return { sanitized, full }
}

describe("sanitizeBackupRelativePath — CWE-22 containment", () => {
  it("converges a classic traversal payload inside page-history", () => {
    const { sanitized, full } = expectContained("../../etc/passwd")
    expect(sanitized).toBe(".._.._etc_passwd")
    expect(full).toBe(`${BACKUP_DIR}/.._.._etc_passwd-${STAMP}`)
  })

  it("converges a Windows drive payload inside page-history", () => {
    const { sanitized, full } = expectContained("C:\\evil")
    // Both the drive colon and the backslash are flattened so the
    // result is writable on Windows (no ADS) and has no separator.
    expect(sanitized).toBe("C__evil")
    expect(full).toBe(`${BACKUP_DIR}/C__evil-${STAMP}`)
  })

  it("strips an embedded NUL and stays inside page-history", () => {
    const { sanitized, full } = expectContained("wiki/entities/a\0../b.md")
    expect(sanitized).not.toContain("\0")
    expect(sanitized).toBe("wiki_entities_a.._b.md")
    expect(full).toBe(`${BACKUP_DIR}/wiki_entities_a.._b.md-${STAMP}`)
  })

  it("converges an absolute POSIX path inside page-history", () => {
    const { sanitized, full } = expectContained("/etc/passwd")
    expect(sanitized).toBe("_etc_passwd")
    expect(full.startsWith(`${BACKUP_DIR}/`)).toBe(true)
  })

  it("maps empty and dot-only inputs to a safe placeholder", () => {
    expect(sanitizeBackupRelativePath("")).toBe("unnamed")
    expect(sanitizeBackupRelativePath("..")).toBe("unnamed")
    expect(sanitizeBackupRelativePath(".")).toBe("unnamed")
    expect(backupPathFor("").startsWith(`${BACKUP_DIR}/`)).toBe(true)
  })

  it("keeps normal wiki paths as a flattened single segment", () => {
    expect(sanitizeBackupRelativePath("wiki/entities/foo.md")).toBe("wiki_entities_foo.md")
    expectContained("wiki/entities/foo.md")
  })
})
