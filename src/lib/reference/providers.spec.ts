import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  characterProvider,
  chapterProvider,
  settingProvider,
  loadAllReferenceCandidates,
} from "./providers"

vi.mock("@/lib/novel/bindable-characters", () => ({
  listBindableNovelCharacters: vi.fn(),
}))

vi.mock("@/lib/novel/chapter-ingest", () => ({
  listSnapshots: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))

import { listBindableNovelCharacters } from "@/lib/novel/bindable-characters"
import { listSnapshots } from "@/lib/novel/chapter-ingest"
import { listDirectory, readFile } from "@/commands/fs"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("reference/providers", () => {
  describe("characterProvider", () => {
    it("maps bindable character names to candidates", async () => {
      vi.mocked(listBindableNovelCharacters).mockResolvedValue(["林墨", "北境"])
      const candidates = await characterProvider.listCandidates("/p")
      expect(candidates).toEqual([
        { id: "character:林墨", kind: "character", name: "林墨", score: 0 },
        { id: "character:北境", kind: "character", name: "北境", score: 0 },
      ])
    })
  })

  describe("chapterProvider", () => {
    it("maps snapshot numbers to chapter candidates", async () => {
      vi.mocked(listSnapshots).mockResolvedValue([3, 12])
      const candidates = await chapterProvider.listCandidates("/p")
      expect(candidates).toEqual([
        { id: "chapter:3", kind: "chapter", name: "第3章", score: 0 },
        { id: "chapter:12", kind: "chapter", name: "第12章", score: 0 },
      ])
    })
  })

  describe("settingProvider", () => {
    it("collects entities with setting-type frontmatter", async () => {
      vi.mocked(listDirectory).mockResolvedValue([
        { name: "北境.md", path: "/p/wiki/entities/北境.md", is_dir: false },
      ])
      vi.mocked(readFile).mockResolvedValue("type: setting\ntitle: 北境\n\n北境是极北之地。")
      const candidates = await settingProvider.listCandidates("/p")
      expect(candidates).toEqual([
        { id: "setting:北境", kind: "setting", name: "北境", score: 0 },
      ])
    })

    it("accepts location/organization/item types", async () => {
      vi.mocked(listDirectory).mockResolvedValue([
        { name: "a.md", path: "/p/wiki/entities/a.md", is_dir: false },
        { name: "b.md", path: "/p/wiki/entities/b.md", is_dir: false },
        { name: "c.md", path: "/p/wiki/entities/c.md", is_dir: false },
      ])
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.endsWith("a.md")) return "type: location\ntitle: 城"
        if (path.endsWith("b.md")) return "type: organization\ntitle: 盟"
        return "type: item\ntitle: 剑"
      })
      const candidates = await settingProvider.listCandidates("/p")
      expect(candidates.map((c) => c.name).sort()).toEqual(["剑", "城", "盟"])
    })

    it("skips entities without type or with non-setting type", async () => {
      vi.mocked(listDirectory).mockResolvedValue([
        { name: "no-type.md", path: "/p/wiki/entities/no-type.md", is_dir: false },
        { name: "char.md", path: "/p/wiki/entities/char.md", is_dir: false },
      ])
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.endsWith("char.md")) return "type: character\ntitle: 林墨"
        return "正文没有 type 行"
      })
      const candidates = await settingProvider.listCandidates("/p")
      expect(candidates).toEqual([])
    })

    it("falls back to file name when title frontmatter missing", async () => {
      vi.mocked(listDirectory).mockResolvedValue([
        { name: "无名之地.md", path: "/p/wiki/entities/无名之地.md", is_dir: false },
      ])
      vi.mocked(readFile).mockResolvedValue("type: setting\n\n正文")
      const candidates = await settingProvider.listCandidates("/p")
      expect(candidates[0]?.name).toBe("无名之地")
    })

    it("skips single-file read failures", async () => {
      vi.mocked(listDirectory).mockResolvedValue([
        { name: "a.md", path: "/p/wiki/entities/a.md", is_dir: false },
        { name: "b.md", path: "/p/wiki/entities/b.md", is_dir: false },
      ])
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.endsWith("a.md")) throw new Error("boom")
        return "type: setting\ntitle: 乙"
      })
      const candidates = await settingProvider.listCandidates("/p")
      expect(candidates).toEqual([
        { id: "setting:乙", kind: "setting", name: "乙", score: 0 },
      ])
    })

    it("returns empty when entity dir listing fails", async () => {
      vi.mocked(listDirectory).mockRejectedValue(new Error("ENOENT"))
      const candidates = await settingProvider.listCandidates("/p")
      expect(candidates).toEqual([])
    })

    it("flattens nested directories recursively", async () => {
      vi.mocked(listDirectory).mockResolvedValue([
        {
          name: "sub",
          path: "/p/wiki/entities/sub",
          is_dir: true,
          children: [
            { name: "深城.md", path: "/p/wiki/entities/sub/深城.md", is_dir: false },
            { name: "notes.txt", path: "/p/wiki/entities/sub/notes.txt", is_dir: false },
          ],
        },
        { name: "顶层.md", path: "/p/wiki/entities/顶层.md", is_dir: false },
      ])
      vi.mocked(readFile).mockResolvedValue("type: setting\ntitle: 占位")
      const candidates = await settingProvider.listCandidates("/p")
      expect(candidates).toHaveLength(2)
      expect(readFile).toHaveBeenCalledWith("/p/wiki/entities/sub/深城.md")
      expect(readFile).not.toHaveBeenCalledWith("/p/wiki/entities/sub/notes.txt")
    })

    it("skips dir nodes without children array", async () => {
      vi.mocked(listDirectory).mockResolvedValue([
        { name: "empty-dir", path: "/p/wiki/entities/empty-dir", is_dir: true },
      ])
      const candidates = await settingProvider.listCandidates("/p")
      expect(candidates).toEqual([])
      expect(readFile).not.toHaveBeenCalled()
    })
  })

  describe("loadAllReferenceCandidates", () => {
    it("aggregates all providers in order", async () => {
      vi.mocked(listBindableNovelCharacters).mockResolvedValue(["林墨"])
      vi.mocked(listSnapshots).mockResolvedValue([1])
      vi.mocked(listDirectory).mockResolvedValue([])
      const candidates = await loadAllReferenceCandidates("/p")
      expect(candidates.map((c) => c.kind)).toEqual(["character", "chapter"])
    })

    it("degrades a failing provider to empty (fail-open)", async () => {
      vi.mocked(listBindableNovelCharacters).mockRejectedValue(new Error("boom"))
      vi.mocked(listSnapshots).mockResolvedValue([1])
      vi.mocked(listDirectory).mockResolvedValue([])
      const candidates = await loadAllReferenceCandidates("/p")
      expect(candidates.map((c) => c.kind)).toEqual(["chapter"])
    })
  })
})
