import { describe, it, expect, vi } from "vitest"
import { applyFileEdit } from "./agent-tools"
import type { FileEditAction } from "./agent-parser"

// Mock fs commands
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
}))

describe("agent-tools applyFileEdit security", () => {
  it("should block path traversal with .. segments (ISS-20260731-001)", async () => {
    const maliciousEdit: FileEditAction = {
      filePath: "wiki/chapters/../../../../etc/passwd",
      search: "test",
      replace: "hacked",
    }

    const result = await applyFileEdit("/project", maliciousEdit)

    expect(result.success).toBe(false)
    expect(result.error).toContain("路径不安全")
    expect(result.error).toContain("..")
  })

  it("should block absolute paths", async () => {
    const maliciousEdit: FileEditAction = {
      filePath: "/etc/passwd",
      search: "test",
      replace: "hacked",
    }

    const result = await applyFileEdit("/project", maliciousEdit)

    expect(result.success).toBe(false)
    expect(result.error).toContain("路径不安全")
  })

  it("should block Windows drive letters", async () => {
    const maliciousEdit: FileEditAction = {
      filePath: "C:\\Windows\\System32\\config\\SAM",
      search: "test",
      replace: "hacked",
    }

    const result = await applyFileEdit("/project", maliciousEdit)

    expect(result.success).toBe(false)
    expect(result.error).toContain("路径不安全")
  })

  it("should block control characters", async () => {
    const maliciousEdit: FileEditAction = {
      filePath: "wiki/chapters/test\x00.md",
      search: "test",
      replace: "hacked",
    }

    const result = await applyFileEdit("/project", maliciousEdit)

    expect(result.success).toBe(false)
    expect(result.error).toContain("路径不安全")
  })

  it("should allow valid wiki/chapters/ paths", async () => {
    const validEdit: FileEditAction = {
      filePath: "wiki/chapters/chapter1.md",
      search: "old text",
      replace: "new text",
    }

    // Mock readFile to return content with search text
    const { readFile, writeFile } = await import("@/commands/fs")
    vi.mocked(readFile).mockResolvedValue("This is old text content")
    vi.mocked(writeFile).mockResolvedValue(undefined)

    const result = await applyFileEdit("/project", validEdit)

    // Should pass security check and succeed
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })
})
