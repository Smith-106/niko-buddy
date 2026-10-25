// S5 首拆切片 #2（chapter-ingest 拆分第 2 步）：快照预览纯函数簇。
// 零 IO；chapter-ingest 经 re-export 保持既有 import 面不变。
import type { ChapterSnapshot } from "./chapter-ingest"
import type { EditImpactStores } from "./edit-impact-analyzer"

/** 51 号报告 G4: 将快照投影为影响分析文本（实体名 + 关键内容字段拼接）。 */
export function projectSnapshotForImpact(snapshot: ChapterSnapshot | null): string {
  if (!snapshot) return ""
  const parts: string[] = [
    snapshot.summary ?? "",
    ...(snapshot.characters ?? []),
    ...(snapshot.locations ?? []),
    ...(snapshot.organizations ?? []),
    ...(snapshot.items ?? []),
    ...(snapshot.events ?? []),
    ...(snapshot.newCanonFacts ?? []),
    ...(snapshot.characterStateChanges ?? []),
    ...(snapshot.foreshadowingChanges ?? []),
  ]
  return parts.filter(Boolean).join("\n")
}

/** 51 号报告 G4: 从快照派生影响分析 stores（角色/伏笔/canon 事实；subplot 不在快照内留空）。 */
export function projectSnapshotToImpactStores(snapshot: ChapterSnapshot): EditImpactStores {
  return {
    characters: (snapshot.characters ?? []).map((name) => ({ id: name, characterName: name })),
    // 52 号报告终验补全：newCanonFacts/foreshadowingChanges 也投影进 stores，
    // 使 analyzeEditImpact 能命中 canon 边与伏笔的受影响判定（此前仅 characters）。
    canonEdges: (snapshot.newCanonFacts ?? []).map((fact) => ({
      id: fact,
      source_id: "",
      target_id: "",
      predicate: fact,
      edge_kind: "world_fact" as const,
    })),
    foreshadows: (snapshot.foreshadowingChanges ?? []).map((f) => ({
      id: f,
      name: f,
      description: f,
      status: "planted" as const,
      plantedChapter: snapshot.chapterNumber,
      advancedChapters: [],
      relatedCharacters: [],
      relatedEvents: [],
      notes: "",
    })),
  }
}

function appendPreviewSection(lines: string[], title: string, items: string[]): void {
  lines.push(`${title}：`)
  if (items.length === 0) {
    lines.push("- 无")
  } else {
    lines.push(...items.map(item => `- ${item}`))
  }
  lines.push("")
}

export function buildSnapshotMemorySyncPreview(snapshot: ChapterSnapshot): string {
  const graphItems = [
    ...snapshot.characters,
    ...snapshot.locations,
    ...snapshot.organizations,
    ...snapshot.items,
    ...snapshot.events,
  ]
  const uniqueGraphItems = Array.from(new Set(graphItems.filter(Boolean)))
  const lines = ["本次将同步以下内容：", ""]

  appendPreviewSection(lines, "人物状态", snapshot.characterStateChanges)
  appendPreviewSection(lines, "角色认知", snapshot.knowledgeChanges)
  appendPreviewSection(lines, "伏笔追踪", snapshot.foreshadowingChanges)
  appendPreviewSection(lines, "实体页 / 图谱", uniqueGraphItems)
  appendPreviewSection(lines, "RAG 记忆页面", ["章节快照记忆", "角色认知状态", "人物状态记忆", "伏笔追踪记忆"])

  return lines.join("\n").trimEnd()
}
