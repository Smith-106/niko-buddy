import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildPack,
  stripCredentialLines,
} from "./skill-pack/pack-export"
import { NBSKILL_PACK_SCHEMA_VERSION_V2, parseNbskillPack } from "./skill-pack/pack-format"
import { importNbskillPack } from "./skill-pack/pack-import"
import { normalizeUserSkill } from "./skill-library"
import {
  cloneSkillAsEditable,
  loadLinkedSkillContent,
  normalizeUserSkillConfig,
  PROJECT_ROOT_TOKEN,
  upsertWritingSkills,
  USER_ASSET_ROOT_TOKEN,
} from "./user-skill-store"
import {
  bookRulesToPromptFragment,
  fanficPolicyFromRules,
  normalizeBookRules,
  validateFanficChapter,
  type BookRules,
} from "./book-rules"
import { buildMcpRuntime } from "@/lib/mcp/runtime"
import { buildMcpAgentTools, loadEffectiveMcpConfig } from "@/lib/mcp/agent-consumer"
import { forkBuiltInCharacterAura } from "./character-aura-generation"
import { BUILT_IN_CHARACTER_AURAS } from "./character-aura-builtin"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(async () => {}),
  createDirectory: vi.fn(async () => {}),
  listDirectory: vi.fn(async () => []),
}))

vi.mock("@tauri-apps/api/path", () => ({
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fsMocks.readFile,
    writeFileAtomic: fsMocks.writeFileAtomic,
    createDirectory: fsMocks.createDirectory,
    listDirectory: fsMocks.listDirectory,
  }
})

describe("Phase 2 upgrades: SkillPack v2, linked tokens, BookRules v1.1, Fork, MCP", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    fsMocks.listDirectory.mockResolvedValue([])
  })

  it("nbskill/2 完整保留 name/description/kind/stages/modes/priority/tags/categoryId，支持 >64 技能且不加前缀", () => {
    const skills = Array.from({ length: 70 }, (_, i) =>
      normalizeUserSkill({
        id: `nmem-skill-${i}`,
        name: `写作技法-${i}`,
        description: `第 ${i} 条技法说明`,
        kind: ["structure", "style"],
        stages: ["planning", "drafting"],
        modes: ["standard", "strict"],
        priority: 85,
        tags: ["玄幻", "节奏"],
        categoryId: "cat-craft",
        content: `规则正文 ${i}\nmax_tokens: 4000\ntoken_budget: 6000`,
        source: "uploaded",
      }),
    )

    const exported = buildPack(skills, {
      name: "craft-suite",
      version: "2.0.0",
      author: "niko",
      schemaVersion: NBSKILL_PACK_SCHEMA_VERSION_V2,
    })
    expect(exported.pack.schemaVersion).toBe(2)
    expect(exported.warnings).toEqual([])
    expect(exported.pack.prompts).toHaveLength(70)
    expect(exported.pack.prompts[0].body).toContain("max_tokens: 4000")
    expect(exported.pack.prompts[0].body).toContain("token_budget: 6000")

    const parsed = parseNbskillPack(exported.pack)
    expect(parsed.ok).toBe(true)

    const imported = importNbskillPack(exported.pack, { categoryId: "fallback-cat" })
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.skills).toHaveLength(70)
    expect(imported.skills[0].name).toBe("写作技法-0")
    expect(imported.skills[0].description).toBe("第 0 条技法说明")
    expect(imported.skills[0].priority).toBe(85)
    expect(imported.skills[0].tags).toContain("玄幻")
    expect(imported.skills[0].categoryId).toBe("cat-craft")
  })

  it("stripCredentialLines 保留写作预算键（max_tokens/token_budget）但继续剥离真实凭据行", () => {
    const res = stripCredentialLines([
      "max_tokens: 4096",
      "token_budget: 6000",
      "api_token: super-secret-value",
      "password: my-password",
      "正常正文",
    ].join("\n"))
    expect(res.stripped).toBe(2)
    expect(res.body).toContain("max_tokens: 4096")
    expect(res.body).toContain("token_budget: 6000")
    expect(res.body).not.toContain("super-secret-value")
    expect(res.body).not.toContain("my-password")
  })

  it("loadLinkedSkillContent 支持展开 ${USER_ASSET_ROOT}/${PROJECT_ROOT} 并在磁盘缺失时回退 contentCache", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.replace(/\\/g, "/") === "/assets/pack1/skills/hook/SKILL.md") {
        return "# 钩子正文"
      }
      throw new Error("ENOENT")
    })

    const skill = normalizeUserSkill({
      id: "bundle:p1:hook",
      name: "章尾钩子",
      source: "linked",
      linkedPath: `${USER_ASSET_ROOT_TOKEN}/pack1/skills/hook`,
      content: "",
      contentCache: "缓存兜底内容",
    })

    const hit = await loadLinkedSkillContent(skill, { userAssetRoot: "/assets" })
    expect(hit).toBe("# 钩子正文")

    const missing = await loadLinkedSkillContent(
      { ...skill, linkedPath: `${PROJECT_ROOT_TOKEN}/missing/skill` },
      { projectPath: "/proj" },
    )
    expect(missing).toBe("缓存兜底内容")
  })

  it("upsertWritingSkills 同 id 覆盖旧版本，cloneSkillAsEditable 将 linked 复制为可编辑副本", () => {
    const oldSkill = normalizeUserSkill({
      id: "skill:1",
      name: "旧版本",
      content: "旧内容",
      source: "uploaded",
    })
    const linked = normalizeUserSkill({
      id: "linked:1",
      name: "外部技法",
      content: "",
      contentCache: "缓存技法正文",
      linkedPath: `${USER_ASSET_ROOT_TOKEN}/demo`,
      source: "linked",
    })
    const cfg = normalizeUserSkillConfig({ version: 1, selectedSkillId: "skill:1", disabledSkillIds: [], skills: [oldSkill, linked], categories: [] })
    const updated = upsertWritingSkills(cfg, [
      normalizeUserSkill({ id: "skill:1", name: "新版本", content: "新内容", source: "uploaded" }),
    ])
    expect(updated.skills.find((s) => s.id === "skill:1")?.name).toBe("新版本")
    expect(updated.skills.find((s) => s.id === "skill:1")?.content).toBe("新内容")

    const { config: afterClone, cloned } = cloneSkillAsEditable(updated, "linked:1", "完整外链正文", 999)
    expect(cloned).not.toBeNull()
    expect(cloned?.source).toBe("uploaded")
    expect(cloned?.content).toBe("完整外链正文")
    expect(afterClone.selectedSkillId).toBe(cloned?.id)
  })

  it("BookRules v1.1 fanficPolicyFromRules 真实读取 canonLockNames / auDeviations / oocMarkers / pairing", () => {
    const raw: BookRules = {
      version: "1.1",
      prohibitions: ["系统提示音"],
      allowedDeviations: [],
      fanficMode: "cp",
      canonLockNames: ["林渊", "苏青"],
      auDeviations: ["现代都市AU"],
      oocMarkers: ["【偏离】"],
      pairing: ["林渊", "苏青"],
    }
    const normalized = normalizeBookRules(raw)
    expect(normalized?.pairing).toEqual(["林渊", "苏青"])
    const policy = fanficPolicyFromRules(normalized!)
    expect(policy.canonLockNames).toEqual(["林渊", "苏青"])
    expect(policy.auDeviations).toEqual(["现代都市AU"])
    expect(policy.oocMarkers).toEqual(["【偏离】"])
    expect(policy.pairing).toEqual(["林渊", "苏青"])

    const check = validateFanficChapter(normalized!, "林渊独自走在雨里。", ["林渊"])
    expect(check.findings.some((f) => f.code === "fanfic_cp_missing_pair")).toBe(true)
    expect(bookRulesToPromptFragment(normalized!)).toContain("林渊 × 苏青")
  })

  it("forkBuiltInCharacterAura 零 LLM 克隆内置灵魂，skillFolder 为项目相对路径", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("character-aura.json")) {
        return JSON.stringify({ customAuras: [], bindings: [] })
      }
      throw new Error("ENOENT")
    })
    const source = BUILT_IN_CHARACTER_AURAS[0]
    const forked = await forkBuiltInCharacterAura("/MyBook", source, { name: "冷峻秦王" })
    expect(forked.builtIn).toBe(false)
    expect(forked.name).toBe("冷峻秦王")
    expect(forked.skillFolder).toMatch(/^\.niko-buddy\/character-auras\/.+-perspective$/)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalled()
  })

  it("MCP 运行时：只读工具在 standard/strict 均可用，写工具仅限 strict；项目覆盖与 dispose 正常工作", async () => {
    const baseConfig = {
      servers: [
        {
          id: "kb",
          name: "Knowledge",
          enabled: true,
          transport: "stdio" as const,
          command: "node",
          args: ["server.js"],
          tools: [
            {
              serverId: "kb",
              serverName: "Knowledge",
              name: "search_lore",
              description: "Search lore",
              operation: "read" as const,
              inputSchema: { type: "object" as const, properties: {} },
            },
            {
              serverId: "kb",
              serverName: "Knowledge",
              name: "write_note",
              description: "Write note",
              operation: "write" as const,
              inputSchema: { type: "object" as const, properties: {} },
            },
          ],
        },
      ],
    }

    const runtime = buildMcpRuntime(baseConfig)
    const readCap = runtime.mcpCapabilities.find((c) => c.id === "mcp:kb:search_lore")
    const writeCap = runtime.mcpCapabilities.find((c) => c.id === "mcp:kb:write_note")
    expect(readCap?.modes).toEqual(["standard", "strict"])
    expect(writeCap?.modes).toEqual(["strict"])

    fsMocks.readFile.mockResolvedValueOnce(JSON.stringify({ disabledServerIds: ["kb"] }))
    const effective = await loadEffectiveMcpConfig(baseConfig, "/MyBook")
    expect(effective.servers[0].enabled).toBe(false)

    const built = buildMcpAgentTools(baseConfig)
    expect(typeof built.dispose).toBe("function")
    await expect(built.dispose()).resolves.toBeUndefined()
  })
})
