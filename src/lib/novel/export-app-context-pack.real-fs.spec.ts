/**
 * Headless nearest-app ContextPack export.
 *
 * Mocks Tauri fs invoke with Node fs so buildContextPack can run outside GUI.
 * Not identical to live searchWiki vector path, but closer than offline-minimal:
 * same code path as app (buildContextPack + data sources + exemplars).
 *
 * Trigger:
 *   EXPORT_APP_PACK=1 EXPORT_APP_PACK_PROJECT="E:/写作/8人" EXPORT_APP_PACK_CHAPTER=4 \
 *   EXPORT_APP_PACK_OUT="../.workflow/harvest-staging/.../context-pack.app.json" \
 *   npx vitest run src/lib/novel/export-app-context-pack.real-fs.spec.ts
 */
import { describe, expect, it, vi } from "vitest"
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const PROJECT = process.env.EXPORT_APP_PACK_PROJECT || ""
const CHAPTER = Number(process.env.EXPORT_APP_PACK_CHAPTER || "0")
const OUT = process.env.EXPORT_APP_PACK_OUT || ""
const enabled = process.env.EXPORT_APP_PACK === "1" && PROJECT && OUT && CHAPTER > 0

function walkMd(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walkMd(p, acc)
    else if (name.endsWith(".md")) acc.push(p)
  }
  return acc
}

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async (path: string): Promise<string> => {
    return readFileSync(path, "utf8")
  }),
  writeFile: vi.fn(async () => {}),
  writeFileAtomic: vi.fn(async () => {}),
  createDirectory: vi.fn(async () => {}),
  fileExists: vi.fn(async (path: string) => existsSync(path)),
  listDirectory: vi.fn(async (path: string) => {
    if (!existsSync(path)) return []
    const nodes: Array<{ name: string; path: string; isDirectory: boolean; children?: unknown[] }> = []
    for (const name of readdirSync(path)) {
      const full = join(path, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        nodes.push({ name, path: full, isDirectory: true, children: [] })
      } else {
        nodes.push({ name, path: full, isDirectory: false })
      }
    }
    return nodes
  }),
  getFileModifiedTime: vi.fn(async () => Date.now()),
  getFileSize: vi.fn(async () => 0),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
  fileExists: fsMocks.fileExists,
  listDirectory: fsMocks.listDirectory,
  getFileModifiedTime: fsMocks.getFileModifiedTime,
  getFileSize: fsMocks.getFileSize,
}))

// Soft-stub embedding / vector to avoid native deps in headless export
vi.mock("@/lib/embedding", async (importOriginal) => {
  try {
    const actual = await importOriginal<Record<string, unknown>>()
    return {
      ...actual,
      embedTexts: async () => [],
      searchSimilar: async () => [],
    }
  } catch {
    return {
      embedTexts: async () => [],
      searchSimilar: async () => [],
    }
  }
})

const describeOrSkip = enabled ? describe : describe.skip

describeOrSkip("export app-nearest ContextPack via buildContextPack (Node fs)", () => {
  it(
    "writes production ContextPack JSON",
    async () => {
      const { buildContextPack } = await import("./context-engine")
      const { DEFAULT_NOVEL_CONFIG } = await import("@/stores/wiki-store")

      const projectPath = resolve(PROJECT)
      const task = `六维审查第${CHAPTER}章（app-nearest headless buildContextPack）`
      const pack = await buildContextPack(projectPath, task, CHAPTER, {
        novelMode: true,
        novelConfig: {
          ...DEFAULT_NOVEL_CONFIG,
          temporalFactsEnabled: true,
          entityBoostEnabled: true,
          exemplarEnabled: true,
          conditionalRoutingEnabled: true,
          outlineThrillSoftGateEnabled: true,
        },
      })

      const outPath = resolve(OUT)
      mkdirSync(dirname(outPath), { recursive: true })
      const payload = {
        generatedAt: new Date().toISOString(),
        provenance: {
          kind: "app-nearest-headless-buildContextPack",
          note: "Node fs mock of Tauri invoke; same buildContextPack code path; vector/search may soft-degrade",
          projectPath,
          chapter: CHAPTER,
          mdFilesSeen: walkMd(join(projectPath, "wiki")).length,
        },
        pack,
      }
      writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8")

      expect(pack.task).toBeTruthy()
      expect(typeof pack.outline).toBe("string")
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            ok: true,
            out: outPath,
            outlineChars: pack.outline?.length ?? 0,
            recent: pack.recentChapterContents?.length ?? 0,
            prevEnd: pack.previousChapterEnding?.length ?? 0,
            exemplars: pack.styleExemplars?.length ?? 0,
            gaps: pack.gaps?.length ?? 0,
          },
          null,
          2,
        ),
      )
    },
    120_000,
  )
})
