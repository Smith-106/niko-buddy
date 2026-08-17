import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { WikiUpdatePatch } from "./chapter-ingest-output"
import {
  canonicalizeGraphNodeId,
  canonicalizeSnapshotCharacters,
  detectNodeType,
  getCanonicalCharacterName,
  getCharacterNamesForMatching,
  NOVEL_NODE_TYPE_LABELS,
  NOVEL_RELATION_LABELS,
  sanitizeEntitySlug,
  snapshotToGraphEdges,
  snapshotToGraphNodes,
  supersedeFact,
  writePatchFieldsToWiki,
  writeSnapshotToWiki,
} from "./graph-adapter"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  fileExists: vi.fn(),
  createDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  fileExists: fsMocks.fileExists,
  createDirectory: fsMocks.createDirectory,
}))

function mkSnapshot(overrides: Partial<ChapterSnapshot> = {}): ChapterSnapshot {
  return {
    chapterId: "ch-0001",
    chapterNumber: 1,
    summary: "第1章摘要",
    characters: ["林烬"],
    locations: ["旧城"],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: [],
    timelineEvents: [],
    conflicts: [],
    endingHook: "钩子",
    graphNodes: [],
    graphEdges: [],
    ...overrides,
  }
}

beforeEach(() => {
  for (const mock of Object.values(fsMocks)) mock.mockReset()
})

describe("getCanonicalCharacterName", () => {
  it("无 characterAliases → 原样返回 trimmed name", () => {
    expect(getCanonicalCharacterName(mkSnapshot(), " 林烬 ")).toBe("林烬")
  })

  it("空白 name → 返回空串", () => {
    expect(getCanonicalCharacterName(mkSnapshot(), "   ")).toBe("")
  })

  it("别名映射到 canonical name", () => {
    const s = mkSnapshot({ characterAliases: { 林烬: ["林少", "阿烬"] } })
    expect(getCanonicalCharacterName(s, "林少")).toBe("林烬")
    expect(getCanonicalCharacterName(s, "阿烬")).toBe("林烬")
    expect(getCanonicalCharacterName(s, "林烬")).toBe("林烬")
  })

  it("canonical 为空白时跳过该条目（不映射别名）", () => {
    const s = mkSnapshot({ characterAliases: { "  ": ["林少"] } })
    expect(getCanonicalCharacterName(s, "林少")).toBe("林少")
  })

  it("别名与 canonical 相同的条目被过滤（不进映射）", () => {
    const s = mkSnapshot({ characterAliases: { 林烬: ["林烬", "林少"] } })
    expect(getCharacterNamesForMatching(s, "林少")).toEqual(["林烬", "林少"])
  })

  it("空对象 characterAliases → normalizedEntries 为空 → 走 undefined 路径", () => {
    const s = mkSnapshot({ characterAliases: {} })
    expect(getCanonicalCharacterName(s, "林少")).toBe("林少")
    expect(canonicalizeSnapshotCharacters(s).characters).toEqual(["林烬"])
  })
})

describe("getCharacterNamesForMatching", () => {
  it("返回 canonical + aliases 去重列表", () => {
    const s = mkSnapshot({ characterAliases: { 林烬: ["林少"] } })
    expect(getCharacterNamesForMatching(s, "林少")).toEqual(["林烬", "林少"])
  })

  it("无别名 → 仅 [canonical]", () => {
    expect(getCharacterNamesForMatching(mkSnapshot(), "林烬")).toEqual(["林烬"])
  })
})

describe("canonicalizeGraphNodeId", () => {
  const s = mkSnapshot({ characterAliases: { 林烬: ["林少"] } })

  it("空白 → 原样返回", () => {
    expect(canonicalizeGraphNodeId(s, "   ")).toBe("")
  })

  it("character: 前缀 → canonical 化 label", () => {
    expect(canonicalizeGraphNodeId(s, "character:林少")).toBe("character:林烬")
  })

  it("非 character 前缀 → 原样返回", () => {
    expect(canonicalizeGraphNodeId(s, "location:旧城")).toBe("location:旧城")
  })

  it("无前缀但命中别名 → character:canonical", () => {
    expect(canonicalizeGraphNodeId(s, "林少")).toBe("character:林烬")
  })

  it("无前缀未命中 → 原样返回", () => {
    expect(canonicalizeGraphNodeId(s, "旧城")).toBe("旧城")
  })
})

describe("canonicalizeSnapshotCharacters", () => {
  it("无 aliases → 原样返回 snapshot", () => {
    const s = mkSnapshot()
    expect(canonicalizeSnapshotCharacters(s)).toBe(s)
  })

  it("有 aliases → characters 去重 canonical + graphNodes canonical 化 + details 合并", () => {
    const s = mkSnapshot({
      characters: ["林少", "林烬", "沈微"],
      characterAliases: { 林烬: ["林少"] },
      characterDetails: {
        林少: { currentState: "受伤" },
        沈微: { currentState: "健康" },
      },
      graphNodes: ["character:林少", "location:旧城"],
    })
    const result = canonicalizeSnapshotCharacters(s)
    expect(result.characters).toEqual(["林烬", "沈微"])
    expect(result.graphNodes).toEqual(["character:林烬", "location:旧城"])
    expect(result.characterDetails).toEqual({
      林烬: { currentState: "受伤" },
      沈微: { currentState: "健康" },
    })
  })

  it("无 characterDetails → characterDetails 为 undefined", () => {
    const result = canonicalizeSnapshotCharacters(mkSnapshot({ characterAliases: { 林烬: [] } }))
    expect(result.characterDetails).toBeUndefined()
  })
})

describe("snapshotToGraphNodes", () => {
  it("产出各类型节点 + 章节节点", () => {
    const s = mkSnapshot({
      locations: ["旧城"],
      organizations: ["清辉阁"],
      items: ["镇魂铃"],
      events: ["夜巡遇袭"],
    })
    const nodes = snapshotToGraphNodes(s)
    const ids = nodes.map((n) => n.id)
    expect(ids).toContain("character:林烬")
    expect(ids).toContain("location:旧城")
    expect(ids).toContain("organization:清辉阁")
    expect(ids).toContain("item:镇魂铃")
    expect(ids).toContain("event:夜巡遇袭")
    expect(ids).toContain("chapter:1")
    const chapterNode = nodes.find((n) => n.type === "chapter")
    expect(chapterNode?.label).toBe("第1章")
  })
})

describe("snapshotToGraphEdges", () => {
  it("标准边: 角色 APPEARS_IN / 地点 HAPPENS_IN / 组织与物品 APPEARS_IN", () => {
    const s = mkSnapshot({
      locations: ["旧城"],
      organizations: ["清辉阁"],
      items: ["镇魂铃"],
    })
    const edges = snapshotToGraphEdges(s)
    expect(edges).toContainEqual({ source: "character:林烬", target: "chapter:1", relation: "APPEARS_IN" })
    expect(edges).toContainEqual({ source: "chapter:1", target: "location:旧城", relation: "HAPPENS_IN" })
    expect(edges).toContainEqual({ source: "organization:清辉阁", target: "chapter:1", relation: "APPEARS_IN" })
    expect(edges).toContainEqual({ source: "item:镇魂铃", target: "chapter:1", relation: "APPEARS_IN" })
  })

  it("graphEdges 三段解析: 别名节点 → canonical id, 已知 relation 类型映射", () => {
    const s = mkSnapshot({
      characterAliases: { 林烬: ["林少"] },
      characters: ["林烬", "沈微"],
      graphEdges: ["林少 -> KNOWS -> 沈微"],
    })
    const edges = snapshotToGraphEdges(s)
    expect(edges).toContainEqual({ source: "character:林烬", target: "character:沈微", relation: "KNOWS" })
  })

  it("graphEdges 中文 relation label → 类型映射（ENEMY_OF）", () => {
    const s = mkSnapshot({
      characters: ["林烬", "沈微"],
      graphEdges: ["林烬 -> 敌对 -> 沈微"],
    })
    const edges = snapshotToGraphEdges(s)
    expect(edges).toContainEqual({ source: "character:林烬", target: "character:沈微", relation: "ENEMY_OF" })
  })

  it("graphEdges 未知 relation → 回退 AFFECTS（SEC-004 安全降级）", () => {
    const s = mkSnapshot({
      characters: ["林烬", "沈微"],
      graphEdges: ["林烬 -> [[未知关系]] -> 沈微"],
    })
    const edges = snapshotToGraphEdges(s)
    expect(edges).toContainEqual({ source: "character:林烬", target: "character:沈微", relation: "AFFECTS" })
  })

  it("graphEdges 空 relation → AFFECTS", () => {
    const s = mkSnapshot({ characters: ["林烬", "沈微"], graphEdges: ["林烬 ->   -> 沈微"] })
    const edges = snapshotToGraphEdges(s)
    expect(edges).toContainEqual({ source: "character:林烬", target: "character:沈微", relation: "AFFECTS" })
  })

  it("graphEdges 空 source（` -> KNOWS -> 沈微`）→ 该边跳过", () => {
    const s = mkSnapshot({ characters: ["林烬", "沈微"], graphEdges: [" -> KNOWS -> 沈微"] })
    const edges = snapshotToGraphEdges(s)
    expect(edges.some((e) => e.relation === "KNOWS" && e.source === "")).toBe(false)
  })

  it("graphEdges 引用未注册的类型前缀 id → 原样保留（normalizeGraphEdgeNodeId 前缀分支）", () => {
    const s = mkSnapshot({
      characters: ["林烬"],
      graphEdges: ["林烬 -> KNOWS -> location:未知地点"],
    })
    const edges = snapshotToGraphEdges(s)
    expect(edges).toContainEqual({ source: "character:林烬", target: "location:未知地点", relation: "KNOWS" })
  })

  it("多边共享 target/source → relatedMap/edgesByNode has 命中分支（不重复建 Set/数组）", () => {
    const s = mkSnapshot({
      characters: ["林烬", "沈微", "白泽"],
      graphEdges: ["林烬 -> KNOWS -> 沈微", "林烬 -> ALLY_OF -> 白泽", "沈微 -> ENEMY_OF -> 林烬"],
    })
    const edges = snapshotToGraphEdges(s)
    expect(edges).toContainEqual({ source: "character:沈微", target: "character:林烬", relation: "ENEMY_OF" })
    const nodes = snapshotToGraphNodes(s)
    expect(nodes.length).toBe(5) // 3 chars + 默认地点旧城 + chapter
  })

  it("graphEdges 非三段（无 -> 或 2 段）→ 跳过", () => {
    const s = mkSnapshot({ characters: ["林烬"], graphEdges: ["林烬 -> KNOWS"] })
    expect(snapshotToGraphEdges(s).filter((e) => e.relation === "KNOWS")).toHaveLength(0)
  })

  it("带括号装饰的节点名被剥离后匹配", () => {
    const s = mkSnapshot({
      characters: ["林烬", "沈微"],
      graphEdges: ["林烬（主角） -> KNOWS -> 沈微（配角）"],
    })
    const edges = snapshotToGraphEdges(s)
    expect(edges).toContainEqual({ source: "character:林烬", target: "character:沈微", relation: "KNOWS" })
  })

  it("未匹配节点名的三段边 → 保留原始 trimmed 文本作为 id", () => {
    const s = mkSnapshot({ characters: ["林烬"], graphEdges: ["神秘人 -> KNOWS -> 沈微"] })
    const edges = snapshotToGraphEdges(s)
    expect(edges).toContainEqual({ source: "神秘人", target: "沈微", relation: "KNOWS" })
  })
})

describe("detectNodeType", () => {
  it("章节标题 → chapter", () => {
    expect(detectNodeType("第3章 初入江湖")).toBe("chapter")
    expect(detectNodeType("Chapter 5 Reunion")).toBe("chapter")
  })

  const prefixCases: Array<[string, string]> = [
    ["character:林烬", "character"],
    ["人物：林烬", "character"],
    ["location:旧城", "location"],
    ["地点：旧城", "location"],
    ["organization:清辉阁", "organization"],
    ["组织：清辉阁", "organization"],
    ["item:镇魂铃", "item"],
    ["物品：镇魂铃", "item"],
    ["event:夜巡", "event"],
    ["事件：夜巡", "event"],
    ["outline:三卷", "outline"],
    ["大纲：三卷", "outline"],
    ["foreshadowing:玉坠", "foreshadowing"],
    ["伏笔：玉坠", "foreshadowing"],
    ["secret:真相", "secret"],
    ["秘密：真相", "secret"],
    ["conflict:夺位", "conflict"],
    ["冲突：夺位", "conflict"],
    ["timeline-point:元年", "timeline-point"],
    ["时间点：元年", "timeline-point"],
    ["canon-rule:正史", "canon-rule"],
    ["正史：不杀", "canon-rule"],
  ]
  for (const [label, expected] of prefixCases) {
    it(`前缀 ${label} → ${expected}`, () => {
      expect(detectNodeType(label)).toBe(expected)
    })
  }

  const keywordCases: Array<[string, string]> = [
    ["主角", "character"],
    ["王都", "concept"],
    ["主角", "character"],
    ["城市", "location"],
    ["宗门", "organization"],
    ["武器", "item"],
    ["战争", "event"],
    ["悬念", "foreshadowing"],
    ["真相", "secret"],
    ["对抗", "conflict"],
    ["年表", "timeline-point"],
    ["规则", "canon-rule"],
  ]
  for (const [label, expected] of keywordCases) {
    it(`关键词 ${label} → ${expected}`, () => {
      expect(detectNodeType(label)).toBe(expected)
    })
  }

  it("无法识别 → concept", () => {
    expect(detectNodeType("随便一个词")).toBe("concept")
  })

  it("关键词 大纲 → outline", () => {
    expect(detectNodeType("大纲")).toBe("outline")
  })
})

describe("sanitizeEntitySlug", () => {
  it("null/undefined 输入按空串处理 → unnamed-entity", () => {
    expect(sanitizeEntitySlug(null as unknown as string)).toBe("unnamed-entity")
    expect(sanitizeEntitySlug(undefined as unknown as string)).toBe("unnamed-entity")
  })

  it("清理路径分隔符 / 父目录穿越 / 控制字符", () => {
    expect(sanitizeEntitySlug("../../etc/passwd")).toBe("etcpasswd")
    expect(sanitizeEntitySlug("a\x00b\x1fc")).toBe("abc")
  })

  it("剥离 Windows 盘符前缀", () => {
    expect(sanitizeEntitySlug("C:evil")).toBe("evil")
    expect(sanitizeEntitySlug("D:\\evil")).toBe("evil")
  })

  it("剥离前导点冒号", () => {
    expect(sanitizeEntitySlug("...name")).toBe("name")
  })

  it("空/纯路径字符 → unnamed-entity", () => {
    expect(sanitizeEntitySlug("")).toBe("unnamed-entity")
    expect(sanitizeEntitySlug("  ")).toBe("unnamed-entity")
    expect(sanitizeEntitySlug("///")).toBe("unnamed-entity")
  })

  it("正常名字原样保留", () => {
    expect(sanitizeEntitySlug("林烬")).toBe("林烬")
    expect(sanitizeEntitySlug(" 林烬 ")).toBe("林烬")
  })
})

describe("supersedeFact（projection-status-ledger.spec 之外的补充分支）", () => {
  it("无 frontmatter 关闭标记 → 原样返回", () => {
    const noClose = "# 林烬\n无 frontmatter"
    expect(supersedeFact(noClose, "status", "x")).toBe(noClose)
  })

  it("frontmatter 后无换行体（bodyStart<=0）→ 原样返回", () => {
    const noBody = "---\ntype: entity\ntitle: \"林烬\"\n---"
    expect(supersedeFact(noBody, "status", "x")).toBe(noBody)
  })

  it("插入到正文起始（frontmatter 之后首行）", () => {
    const page = "---\ntype: entity\ntitle: \"林烬\"\n---\n\n# 林烬\n正文"
    const out = supersedeFact(page, "status", "advanced")
    expect(out).toContain('status_v: "advanced"')
    expect(out.indexOf("status_v")).toBeLessThan(out.indexOf("# 林烬"))
    expect(out).toContain("# 林烬")
  })
})

describe("NOVEL_NODE_TYPE_LABELS / NOVEL_RELATION_LABELS", () => {
  it("所有 NovelNodeType 都有中文 label", () => {
    expect(NOVEL_NODE_TYPE_LABELS.character).toBe("人物")
    expect(NOVEL_NODE_TYPE_LABELS["timeline-point"]).toBe("时间点")
  })

  it("关系 label 表包含关键类型", () => {
    expect(NOVEL_RELATION_LABELS.APPEARS_IN).toBe("出场于")
    expect(NOVEL_RELATION_LABELS.ALLY_OF).toBe("合作")
  })
})

describe("writeSnapshotToWiki", () => {
  it("新实体页: 建目录 + 写 entity 页 + 返回路径", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const s = mkSnapshot({
      locations: ["旧城"],
      characters: ["林烬", "沈微"],
      characterAliases: { 林烬: ["林少"] },
      graphEdges: ["林烬 -> KNOWS -> 沈微"],
    })
    const paths = await writeSnapshotToWiki("E:/Novel", s)

    expect(fsMocks.createDirectory).toHaveBeenCalledWith("E:/Novel/wiki/entities")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(3)
    expect(paths).toEqual([
      "E:/Novel/wiki/entities/林烬.md",
      "E:/Novel/wiki/entities/沈微.md",
      "E:/Novel/wiki/entities/旧城.md",
    ])
    const [path, content] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(content).toContain('title: "林烬"')
    expect(content).toContain("aliases: [\"林少\"]")
    expect(content).toContain("知道") // KNOWS → 中文 label
    expect(content).toContain("- [[沈微]] — 知道")
    expect(content).not.toContain("APPEARS_IN")
    // 反向边: 沈微页作为 target 时走 e.source !== node.id 分支 (line 635)
    const [, shenweiContent] = fsMocks.writeFileAtomic.mock.calls[1]
    expect(shenweiContent).toContain("- [[林烬]] — 知道")
  })

  it("既有实体页: 读旧页 → merge 缺链接追加 + 应用 supersession meta", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(
      "---\ntype: entity\ntitle: \"林烬\"\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags: [character]\nsnapshot_id: \"old-r1\"\n---\n\n# 林烬\n旧正文\n- [[沈微]] — 知道\n",
    )
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const s = mkSnapshot({
      characters: ["林烬", "沈微", "白泽"],
      snapshotId: "new-r2",
      revision: 2,
      graphEdges: ["林烬 -> KNOWS -> 沈微", "林烬 -> ALLY_OF -> 白泽"],
    })
    await writeSnapshotToWiki("E:/Novel", s)

    const [, content] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(content).toContain('superseded_by_snapshot: "new-r2"')
    expect(content).toContain('snapshot_id: "new-r2"')
    expect(content).toContain("source_type: \"chapter\"")
    expect(content).toContain("is_historical: false")
    // mergeExistingPage: 新进来的 [[白泽]] 链接被追加到旧页正文
    expect(content).toContain("- [[白泽]]")
    // 旧页已存在的链接不重复追加
    expect(content.match(/- \[\[沈微\]\]/g)).toHaveLength(1)
  })

  it("既有实体页 snapshot_id 与 new 相同 → 不写 superseded_by_snapshot", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(
      "---\ntype: entity\ntitle: \"林烬\"\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags: [character]\nsnapshot_id: \"same-r1\"\n---\n\n# 林烬\n旧正文",
    )
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const s = mkSnapshot({ snapshotId: "same-r1" })
    await writeSnapshotToWiki("E:/Novel", s)
    const [, content] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(content).not.toContain("superseded_by_snapshot")
    expect(content).toContain('snapshot_id: "same-r1"')
  })

  it("isHistorical snapshot → 页面 is_historical: true（sourceType 缺省 + 负数章节走 outline）", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const s = mkSnapshot({
      chapterNumber: -2,
      sourceType: undefined as unknown as "outline",
      isHistorical: true,
      characters: ["林烬"],
    })
    await writeSnapshotToWiki("E:/Novel", s)
    const [, content] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(content).toContain("is_historical: true")
    expect(content).toContain('source_type: "outline"')
  })

  it("既有页 + isHistorical → applyProjectionSnapshotMeta 写 is_historical: true", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(
      "---\ntype: entity\ntitle: \"林烬\"\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags: [character]\nsnapshot_id: \"old-r1\"\n---\n\n# 林烬\n旧正文",
    )
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const s = mkSnapshot({ snapshotId: "new-r2", isHistorical: true })
    await writeSnapshotToWiki("E:/Novel", s)
    const [, content] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(content).toContain("is_historical: true")
    expect(content).toContain('superseded_by_snapshot: "new-r2"')
  })

  it("多边共享 target → relatedMap/edgesByNode 已存在分支 + 双向 relation 渲染", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const s = mkSnapshot({
      characters: ["林烬", "沈微"],
      graphEdges: [
        "林烬 -> KNOWS -> 沈微",
        "林烬 -> ALLY_OF -> 沈微",
        "沈微 -> ENEMY_OF -> 林烬",
      ],
    })
    const paths = await writeSnapshotToWiki("E:/Novel", s)
    expect(paths).toHaveLength(3) // 林烬 + 沈微 + 默认地点旧城
    const ljContent = fsMocks.writeFileAtomic.mock.calls[0][1]
    // 林烬 页双向边: 作为 source 和 target 的 relation 都渲染
    expect(ljContent).toContain("- [[沈微]] — 知道")
    expect(ljContent).toContain("- [[沈微]] — 合作")
    expect(ljContent).toContain("- [[沈微]] — 敌对")
  })

  it("outline snapshot（chapterNumber<0）: 文件名 outline-XXX.snapshot.json + sourceType outline", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const s = mkSnapshot({ chapterNumber: -3, sourceType: "outline", characters: ["林烬"] })
    await writeSnapshotToWiki("E:/Novel", s)
    const [, content] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(content).toContain('source_type: "outline"')
    expect(content).toContain("source_sequence: 3")
  })

  it("既有实体页缺失 snapshot_id → 不写 superseded_by_snapshot（priorSnapshotId falsy 分支）", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(
      "---\ntype: entity\ntitle: \"林烬\"\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags: [character]\n---\n\n# 林烬\n旧页正文",
    )
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    await writeSnapshotToWiki("E:/Novel", mkSnapshot({ characters: ["林烬"] }))
    const [, content] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(content).not.toContain("superseded_by_snapshot")
    expect(content).toContain('snapshot_id: "ch-0001-r1"')
  })

  it("prepare 阶段 readFile 抛错 → 该节点跳过（不写）", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockRejectedValue(new Error("io"))
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const s = mkSnapshot({ characters: ["林烬"] })
    const paths = await writeSnapshotToWiki("E:/Novel", s)
    expect(paths).toEqual([])
  })

  it("writeFileAtomic 失败 → 记 warn 但其余节点照写", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.writeFileAtomic
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined)

    const s = mkSnapshot({ characters: ["林烬"], locations: ["旧城"] })
    const paths = await writeSnapshotToWiki("E:/Novel", s)
    expect(paths).toEqual(["E:/Novel/wiki/entities/旧城.md"])
  })

  it("prepare 阶段 fileExists 以非 Error reject → String(err) 记 warn 跳过", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockRejectedValue("io-string")
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const s = mkSnapshot({ characters: ["林烬"] })
    const paths = await writeSnapshotToWiki("E:/Novel", s)
    expect(paths).toEqual([])
  })

  it("write 阶段 writeFileAtomic 以非 Error reject → String(err) 记 warn 跳过", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.writeFileAtomic.mockRejectedValue("disk-string")

    const s = mkSnapshot({ characters: ["林烬"], locations: ["旧城"] })
    const paths = await writeSnapshotToWiki("E:/Novel", s)
    expect(paths).toEqual([])
  })

  it("既有实体页缺少收尾 --- 围栏 → replaceOrInsertFrontmatterLine closeIndex<0 原样返回", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(
      "---\ntype: entity\ntitle: \"林烬\"\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags: [character]\nsnapshot_id: \"old-r1\"\n# 林烬\n旧正文（无收尾围栏）",
    )
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const s = mkSnapshot({ characters: ["林烬"], snapshotId: "new-r2" })
    await writeSnapshotToWiki("E:/Novel", s)
    const [, content] = fsMocks.writeFileAtomic.mock.calls[0]
    // 已存在 key 仍走 pattern 替换；缺失 key 因无收尾围栏无法插入
    expect(content).toContain('snapshot_id: "new-r2"')
    expect(content).not.toContain("superseded_by_snapshot")
    expect(content).not.toContain("source_type")
  })

  it("mergeExistingPage: 既有页缺收尾围栏 → closeFm<0 不追加缺失链接", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(
      "---\ntype: entity\ntitle: \"林烬\"\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags: [character]\n# 林烬\n旧正文（无收尾围栏）",
    )
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const s = mkSnapshot({ characters: ["林烬", "沈微"], graphEdges: ["林烬 -> KNOWS -> 沈微"] })
    await writeSnapshotToWiki("E:/Novel", s)
    const [, content] = fsMocks.writeFileAtomic.mock.calls[0]
    // closeFm<0 → 缺失链接既不追加、正文也不被替换（仍为旧页正文）
    expect(content).not.toContain("沈微")
    expect(content).not.toContain("- [[")
  })
})

describe("writePatchFieldsToWiki", () => {
  it("entryId 无冒号 → nodeIdToSlug 原样返回（else 分支）", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const plainIdPatch: WikiUpdatePatch = {
      sharedWiki: true,
      entries: [
        {
          entryId: "林烬",
          entryType: "character",
          title: "林烬",
          mergeStrategy: "merge-by-entry-id",
          fields: { name: "林烬" },
          sources: [{ chapterNumber: 1, snapshotId: "ch-0001" }],
        },
      ],
    }
    const paths = await writePatchFieldsToWiki("E:/Novel", plainIdPatch)
    expect(paths).toEqual(["E:/Novel/wiki/entities/林烬.md"])
  })

  it("字段值为 null / 空串 / 空数组 / 全空白 → 跳过渲染", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const dirtyPatch: WikiUpdatePatch = {
      sharedWiki: true,
      entries: [
        {
          entryId: "character:林烬",
          entryType: "character",
          title: "林烬",
          mergeStrategy: "merge-by-entry-id",
          fields: { name: "林烬", emptyStr: "", nilField: null, emptyArr: [], blankOnly: "   ", emptyStrArr: [""] },
          sources: [{ chapterNumber: 1, snapshotId: "ch-0001" }],
        },
      ],
    }
    const paths = await writePatchFieldsToWiki("E:/Novel", dirtyPatch)
    const [, content] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(paths).toHaveLength(1)
    expect(content).not.toContain("emptyStr")
    expect(content).not.toContain("nilField")
    expect(content).not.toContain("emptyArr")
    expect(content).not.toContain("emptyStrArr")
    expect(content).toContain("- **名称**: 林烬")
  })

  it("prepare 以非 Error 值 reject → String(err) 记 warn，跳过该 entry", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockRejectedValueOnce("io-string").mockResolvedValueOnce(false)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const twoEntryPatch: WikiUpdatePatch = {
      sharedWiki: true,
      entries: [
        {
          entryId: "character:沈微",
          entryType: "character",
          title: "沈微",
          mergeStrategy: "merge-by-entry-id",
          fields: { name: "沈微" },
          sources: [{ chapterNumber: 1, snapshotId: "ch-0001" }],
        },
        {
          entryId: "character:林烬",
          entryType: "character",
          title: "林烬",
          mergeStrategy: "merge-by-entry-id",
          fields: { name: "林烬" },
          sources: [{ chapterNumber: 1, snapshotId: "ch-0001" }],
        },
      ],
    }
    const paths = await writePatchFieldsToWiki("E:/Novel", twoEntryPatch)
    expect(paths).toEqual(["E:/Novel/wiki/entities/林烬.md"])
  })

  it("write 以非 Error 值 reject → String(err) 记 warn，其余照写", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.writeFileAtomic
      .mockRejectedValueOnce("disk-string")
      .mockResolvedValueOnce(undefined)

    const twoEntryPatch: WikiUpdatePatch = {
      sharedWiki: true,
      entries: [
        {
          entryId: "character:沈微",
          entryType: "character",
          title: "沈微",
          mergeStrategy: "merge-by-entry-id",
          fields: { name: "沈微" },
          sources: [{ chapterNumber: 1, snapshotId: "ch-0001" }],
        },
        {
          entryId: "character:林烬",
          entryType: "character",
          title: "林烬",
          mergeStrategy: "merge-by-entry-id",
          fields: { name: "林烬" },
          sources: [{ chapterNumber: 1, snapshotId: "ch-0001" }],
        },
      ],
    }
    const paths = await writePatchFieldsToWiki("E:/Novel", twoEntryPatch)
    expect(paths).toEqual(["E:/Novel/wiki/entities/林烬.md"])
  })

  const patch: WikiUpdatePatch = {
    sharedWiki: true,
    entries: [
      {
        entryId: "character:林烬",
        entryType: "character",
        title: "林烬",
        mergeStrategy: "merge-by-entry-id",
        fields: {
          name: "林烬",
          currentState: "重伤",
          appearanceChapters: [1, 2],
          aliases: ["林少", " 阿烬 "],
          keyEvents: [{ chapterId: "ch-1", description: "夜巡" }],
        },
        sources: [{ chapterNumber: 1, snapshotId: "ch-0001" }],
      },
      {
        entryId: "foreshadowing:玉坠",
        entryType: "foreshadowing",
        title: "玉坠",
        mergeStrategy: "merge-by-entry-id",
        fields: { status: "created", evidence: "玉坠" },
        sources: [{ chapterNumber: 1, snapshotId: "ch-0001" }],
      },
    ],
  }

  it("新实体页: 稳定类型写入 + aliases 清洗 + 章节信息段（含 object 字段 / detailKeys / 未知字段）", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const richPatch: WikiUpdatePatch = {
      sharedWiki: true,
      entries: [
        {
          entryId: "character:林烬",
          entryType: "character",
          title: "林烬",
          mergeStrategy: "merge-by-entry-id",
          fields: {
            name: "林烬",
            currentState: "重伤",
            appearanceChapters: [1, 2],
            aliases: ["林少", " 阿烬 "],
            keyEvents: [{ chapterId: "ch-1", description: "夜巡" }],
            identity: "巡夜人",
            customUnknownField: "保留原 key",
            cognition: { knows: ["沈微"], doesNotKnow: ["真相"] },
          },
          sources: [{ chapterNumber: 1, snapshotId: "ch-0001" }],
        },
      ],
    }
    const paths = await writePatchFieldsToWiki("E:/Novel", richPatch)

    expect(paths).toEqual(["E:/Novel/wiki/entities/林烬.md"])
    const [, content] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(content).toContain('title: "林烬"')
    expect(content).toContain('aliases: ["林少", "阿烬"]')
    expect(content).toContain("## 章节信息")
    expect(content).toContain("- **当前状态**: 重伤")
    expect(content).toContain("- **关键事件**:")
    // formatFieldValue 的 object 值路径: keyEvents 对象数组 JSON.stringify
    expect(content).toContain('{"chapterId":"ch-1"')
    // detailKeys → ## 段（identity 在 detailKeys 集合内）
    expect(content).toContain("## 身份")
    expect(content).toContain("巡夜人")
    // 未知字段回退原 key
    expect(content).toContain("- **customUnknownField**: 保留原 key")
    // 非数组 object 字段 → JSON.stringify 展示
    expect(content).toContain('{"knows":["沈微"]')
  })

  it("timeline entry 非 stable patch type → 被过滤不写盘", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const timelinePatch: WikiUpdatePatch = {
      sharedWiki: true,
      entries: [
        {
          entryId: "timeline:夜巡",
          entryType: "timeline",
          title: "夜巡",
          mergeStrategy: "merge-by-entry-id",
          fields: { timePoint: "亥时", eventSummary: "夜巡遇袭" },
          sources: [{ chapterNumber: 1, snapshotId: "ch-0001" }],
        },
      ],
    }
    const paths = await writePatchFieldsToWiki("E:/Novel", timelinePatch)
    expect(paths).toEqual([])
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("既有实体页: appendChapterInfo 追加到旧内容", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(
      "---\ntype: entity\ntitle: \"林烬\"\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags: [character]\n---\n\n# 林烬\n旧章节信息",
    )
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    await writePatchFieldsToWiki("E:/Novel", {
      sharedWiki: true,
      entries: [patch.entries[0]],
    })
    const [, content] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(content).toContain("旧章节信息")
    expect(content).toContain("## 章节信息")
    expect(content).toContain("updated: ")
  })

  it("write 阶段失败 → warn 跳过但其余照写（writeFileAtomic reject 路径）", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.writeFileAtomic
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined)

    const twoEntryPatch: WikiUpdatePatch = {
      sharedWiki: true,
      entries: [
        {
          entryId: "character:沈微",
          entryType: "character",
          title: "沈微",
          mergeStrategy: "merge-by-entry-id",
          fields: { name: "沈微" },
          sources: [{ chapterNumber: 1, snapshotId: "ch-0001" }],
        },
        {
          entryId: "character:林烬",
          entryType: "character",
          title: "林烬",
          mergeStrategy: "merge-by-entry-id",
          fields: { name: "林烬" },
          sources: [{ chapterNumber: 1, snapshotId: "ch-0001" }],
        },
      ],
    }
    const paths = await writePatchFieldsToWiki("E:/Novel", twoEntryPatch)
    expect(paths).toEqual(["E:/Novel/wiki/entities/林烬.md"])
  })

  it("prepare 异常 → 跳过该 entry；write 异常 → 其余照写", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockRejectedValueOnce(new Error("io")).mockResolvedValueOnce(false)
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)

    const twoEntryPatch: WikiUpdatePatch = {
      sharedWiki: true,
      entries: [
        {
          entryId: "character:沈微",
          entryType: "character",
          title: "沈微",
          mergeStrategy: "merge-by-entry-id",
          fields: { name: "沈微" },
          sources: [{ chapterNumber: 1, snapshotId: "ch-0001" }],
        },
        {
          entryId: "character:林烬",
          entryType: "character",
          title: "林烬",
          mergeStrategy: "merge-by-entry-id",
          fields: { name: "林烬" },
          sources: [{ chapterNumber: 1, snapshotId: "ch-0001" }],
        },
      ],
    }
    const paths = await writePatchFieldsToWiki("E:/Novel", twoEntryPatch)
    expect(paths).toEqual(["E:/Novel/wiki/entities/林烬.md"])
  })
})
