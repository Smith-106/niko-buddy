/**
 * chapter-ingest-entity-validation — 章节摄入实体链接/校验子模块（M13-3 切片 #4，arch-risk W4 god-object 拆分）。
 *
 * 从 chapter-ingest.ts 抽出的实体链接/校验家族：loadEntityLinkIndex/
 * replaceCanonicalNames/linkSnapshotEntities/validateEntityReferences/
 * validateCanonConflicts。主文件只做编排——链接与校验逻辑独立可测，
 * 不再埋在编排体里。
 *
 * 约束：ValidationWarning 类型留母文件（chapter-snapshot-normalize.ts 注释约束），
 * 此处 type-only import（编译期擦除，无运行时循环）；母文件对外 export 面零变化。
 * 新增文件零新依赖（全部复用母文件已有依赖）。
 */

import { readFile, fileExists } from "@/commands/fs"
import { listEntityFiles, resolveEntityPath } from "./entity-subdir-resolver"
import { buildEntityLinkIndex, resolveEntityLink, extractEntitySummary, type EntitySummary } from "@/lib/dedup"
import { canonicalizeSnapshotCharacters, sanitizeEntitySlug } from "./graph-adapter"
import { logger, toErrorMessage } from "@/lib/utils"
import type { ChapterSnapshot, ValidationWarning } from "./chapter-ingest"

export async function loadEntityLinkIndex(projectPath: string) {
  try {
    // listEntityFiles 聚合子目录+顶层散装，返回 {name:slug, path}。
    const files = await listEntityFiles(projectPath)
    const summaries = await Promise.all(files
      .map(async (file) => {
        try {
          return extractEntitySummary(file.path, await readFile(file.path))
        } catch {
          logger.warn("Chapter Ingest", "silent-degrade: 降级返回空值（吞错已标记）", { line: 2825 })
          return null
        }
      }))
    return buildEntityLinkIndex(summaries.filter((summary): summary is EntitySummary => Boolean(summary)))
  } catch (err) {
    // ISS-20260709-025 PAT-IM2: 实体链接索引构建失败记诊断，控制流不变（空索引降级）。
    logger.warn("Chapter Ingest", "load entity link index failed, degrade to empty (non-fatal)", { error: toErrorMessage(err) })
    return buildEntityLinkIndex([])
  }
}

export function replaceCanonicalNames(values: string[], type: "character" | "location" | "organization" | "item", index: ReturnType<typeof buildEntityLinkIndex>, warnings: ValidationWarning[]): string[] {
  return Array.from(new Set(values.map((name) => {
    const link = resolveEntityLink(index, name, type)
    if (!link || link.canonicalName === name) return name
    warnings.push({ type: "canon_conflict", message: `实体链接: ${name} -> ${link.canonicalName} (${type})` })
    return link.canonicalName
  })))
}

export async function linkSnapshotEntities(projectPath: string, snapshot: ChapterSnapshot): Promise<ValidationWarning[]> {
  const index = await loadEntityLinkIndex(projectPath)
  const warnings: ValidationWarning[] = []
  const next = { ...snapshot }
  const aliases = { ...(snapshot.characterAliases ?? {}) }
  for (const name of snapshot.characters) {
    const link = resolveEntityLink(index, name, "character")
    if (link && link.canonicalName !== name) {
      aliases[link.canonicalName] = Array.from(new Set([...(aliases[link.canonicalName] ?? []), name]))
    }
  }
  next.characterAliases = Object.keys(aliases).length > 0 ? aliases : undefined
  next.characters = replaceCanonicalNames(snapshot.characters, "character", index, warnings)
  next.locations = replaceCanonicalNames(snapshot.locations, "location", index, warnings)
  next.organizations = replaceCanonicalNames(snapshot.organizations, "organization", index, warnings)
  next.items = replaceCanonicalNames(snapshot.items, "item", index, warnings)
  if (snapshot.characterDetails) {
    next.characterDetails = Object.fromEntries(Object.entries(snapshot.characterDetails).map(([name, value]) => {
      const canonical = resolveEntityLink(index, name, "character")?.canonicalName ?? name
      return [canonical, value]
    }))
  }
  if (snapshot.locationDetails) {
    next.locationDetails = Object.fromEntries(Object.entries(snapshot.locationDetails).map(([name, value]) => {
      const canonical = resolveEntityLink(index, name, "location")?.canonicalName ?? name
      return [canonical, value]
    }))
  }
  if (snapshot.organizationDetails) {
    next.organizationDetails = Object.fromEntries(Object.entries(snapshot.organizationDetails).map(([name, value]) => {
      const canonical = resolveEntityLink(index, name, "organization")?.canonicalName ?? name
      return [canonical, value]
    }))
  }
  if (snapshot.itemDetails) {
    next.itemDetails = Object.fromEntries(Object.entries(snapshot.itemDetails).map(([name, value]) => {
      const canonical = resolveEntityLink(index, name, "item")?.canonicalName ?? name
      return [canonical, value]
    }))
  }
  Object.assign(snapshot, canonicalizeSnapshotCharacters(next))
  return warnings
}

export async function validateEntityReferences(
  projectPath: string,
  snapshot: ChapterSnapshot,
): Promise<ValidationWarning[]> {
  const warnings: ValidationWarning[] = []

  const categories = [
    { key: "characters" as const, label: "人物" },
    { key: "locations" as const, label: "地点" },
    { key: "organizations" as const, label: "组织" },
    { key: "items" as const, label: "物品" },
  ]

  /* v8 ignore next */
  if (!snapshot.entityIsNew) {
    snapshot.entityIsNew = {}
  }

  // PERF-NEW-07 (odyssey-improve DC-4): parallelize the per-entity fileExists
  // probe. Previously a serial `for (name of snapshot[key]) await fileExists`
  // — N entities × 4 categories of serial IPC on the ingestChapter hot path.
  // Collect all (name, filePath, label) probes first, run fileExists
  // concurrently, then apply results. entityIsNew writes target distinct
  // keys (no cross-entity dependency), so parallel application is safe.
  const probes: { name: string; filePath: string; label: string }[] = []
  for (const { key, label } of categories) {
    for (const name of snapshot[key]) {
      // SEC-002: sanitize the LLM-supplied entity name before interpolating
      // into the entity path (traversal via prompt-injected name).
      // `entityIsNew` is keyed by the original `name` (in-memory lookup key),
      // only the on-disk path uses the sanitized slug.
      // 物理分层：实体可能在 entities/<subdir>/（已迁移）或扁平（未迁移），
      // 探测须双查——resolveEntityPath 读模式先子目录后扁平回退。
      probes.push({ name, filePath: await resolveEntityPath(projectPath, sanitizeEntitySlug(name), { subtype: key === "items" ? "item" : key.slice(0, -1) }), label })
    }
  }

  const existsResults = await Promise.all(
    probes.map(async (probe) => {
      try {
        return { probe, exists: await fileExists(probe.filePath), errored: false }
      } catch (err) {
        // ISS-20260709-025 PAT-IM2: 探针失败记诊断，控制流不变（按不存在处理）。
        logger.warn("Chapter Ingest", "entity exists probe failed, treat as new (non-fatal)", { path: probe.filePath, error: toErrorMessage(err) })
        return { probe, exists: false, errored: true }
      }
    }),
  )

  for (const { probe, exists, errored } of existsResults) {
    if (errored) {
      snapshot.entityIsNew[probe.name] = true
      warnings.push({ type: "entity_new", message: `新${probe.label}: ${probe.name}` })
    } else {
      snapshot.entityIsNew[probe.name] = !exists
      if (!exists) {
        warnings.push({ type: "entity_new", message: `新${probe.label}: ${probe.name}` })
      }
    }
  }

  return warnings
}

export async function validateCanonConflicts(
  projectPath: string,
  snapshot: ChapterSnapshot,
): Promise<ValidationWarning[]> {
  const warnings: ValidationWarning[] = []

  try {
    const canonPath = `${projectPath}/wiki/canon.md`
    try {
      await readFile(canonPath)
    } catch (err) {
      // ISS-20260709-025 PAT-IM2: 记诊断，控制流不变（无 canon 按零冲突处理）。
      logger.warn("Chapter Ingest", "canon file missing, skip conflict check (non-fatal)", { error: toErrorMessage(err) })
      return warnings
    }

    const conflictPatterns: [RegExp, string][] = [
      [/推翻|打破|改写了|不再是/, "设定推翻"],
      [/之前.+错误|误解|记错|搞错/, "历史修正"],
      [/实际上.+不是|真相是|真正.*是/, "真相揭示"],
    ]

    for (const event of snapshot.events) {
      for (const [regex, label] of conflictPatterns) {
        if (regex.test(event)) {
          warnings.push({
            type: "canon_conflict",
            message: `${label}: "${event}" 可能与正史规则存在潜在冲突`,
          })
          break
        }
      }
    }
  } catch (err) {
    // 校验失败不影响主流程
    // ISS-20260709-025 PAT-IM2: 记诊断，控制流不变。
    logger.warn("Chapter Ingest", "canon conflict validation failed (non-fatal)", { error: toErrorMessage(err) })
  }

  return warnings
}
