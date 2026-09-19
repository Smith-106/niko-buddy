/**
 * 数据域注册表 — niko-buddy 数据隔离 + 一键删除的统一入口。
 *
 * 设计目标（用户需求）：改方案后能整批删干净，不要出现"只能一点点删"。
 * 底层数据已硬隔离在 `<project>/.niko-buddy/` 下（isolation audit 10 faces 已验），
 * 本注册表把 40+ 数据域按"逻辑数据组"聚合，每组可独立清空。
 *
 * 删除策略：先移入 `.niko-buddy/.trash-bin/<timestamp>/<domain>`（可恢复），
 * 用户确认后再物理删除 —— 符合 ISO 27001 数据删除可追溯 + 防误删。
 */

/** 一个逻辑数据组（用户视角的删除粒度）。 */
export interface DataDomain {
  /** 唯一 id（用于 trash-bin 子目录名）。 */
  id: string
  /** 显示名（i18n key）。 */
  labelKey: string
  /** 描述（i18n key）。 */
  descKey: string
  /** `.niko-buddy/` 下的相对路径（目录或文件）。 */
  relPaths: string[]
  /** 风险等级：cache 可安全清 / generated 删后可重建 / user 用户内容需强确认。 */
  risk: "cache" | "generated" | "user"
}

/**
 * 数据域清单（按逻辑组聚合 .niko-buddy/ 下散落的子路径）。
 * relPaths 相对 `<project>/.niko-buddy/`。
 */
export const DATA_DOMAINS: DataDomain[] = [
  {
    id: "chapter-snapshots",
    labelKey: "dataManager.domain.chapterSnapshots",
    descKey: "dataManager.domain.chapterSnapshotsDesc",
    relPaths: ["chapter-backups", "page-history"],
    risk: "user",
  },
  {
    id: "vector-index",
    labelKey: "dataManager.domain.vectorIndex",
    descKey: "dataManager.domain.vectorIndexDesc",
    relPaths: ["lancedb", "fts-index", "vector-fingerprints", "ann"],
    risk: "generated",
  },
  {
    id: "caches",
    labelKey: "dataManager.domain.caches",
    descKey: "dataManager.domain.cachesDesc",
    relPaths: [
      "ingest-cache",
      "ingest-queue",
      "image-caption-cache",
      "chunk-annotations",
      "retrieval-traces",
      "db",
      "scheduled-import-db",
      "dedup-queue",
      "dedup-not-duplicates",
    ],
    risk: "cache",
  },
  {
    id: "generation-history",
    labelKey: "dataManager.domain.generationHistory",
    descKey: "dataManager.domain.generationHistoryDesc",
    relPaths: ["generation-history", "review", "history"],
    risk: "user",
  },
  {
    id: "anti-ai",
    labelKey: "dataManager.domain.antiAi",
    descKey: "dataManager.domain.antiAiDesc",
    relPaths: ["de-ai-skills", "writing-skills", "writing-style", "skill-favorites"],
    risk: "user",
  },
  {
    id: "knowledge-library",
    labelKey: "dataManager.domain.knowledgeLibrary",
    descKey: "dataManager.domain.knowledgeLibraryDesc",
    relPaths: ["dismantling", "book-analysis-tasks"],
    risk: "user",
  },
  {
    id: "conversations",
    labelKey: "dataManager.domain.conversations",
    descKey: "dataManager.domain.conversationsDesc",
    relPaths: ["chats", "chat-history", "conversations", "outline-chats"],
    risk: "user",
  },
  {
    id: "simulations",
    labelKey: "dataManager.domain.simulations",
    descKey: "dataManager.domain.simulationsDesc",
    relPaths: ["simulations"],
    risk: "user",
  },
  {
    id: "character-assets",
    labelKey: "dataManager.domain.characterAssets",
    descKey: "dataManager.domain.characterAssetsDesc",
    relPaths: ["character-aura", "character-auras", "user-assets"],
    risk: "user",
  },
  {
    id: "dashboard",
    labelKey: "dataManager.domain.dashboard",
    descKey: "dataManager.domain.dashboardDesc",
    relPaths: ["dashboard-issues"],
    risk: "generated",
  },
  {
    id: "configs",
    labelKey: "dataManager.domain.configs",
    descKey: "dataManager.domain.configsDesc",
    relPaths: [
      "novel-config",
      "rerank-config",
      "revision-feedback-config",
      "source-watch-config",
      "sync-config",
      "owner",
    ],
    risk: "user",
  },
]

/** 回收站根目录（相对 .niko-buddy/）。 */
export const TRASH_BIN_DIR = ".trash-bin"

/** 生成回收站内的目标相对路径。 */
export function trashBinPath(domainId: string, stamp: string): string {
  return `${TRASH_BIN_DIR}/${stamp}/${domainId}`
}

/** 风险等级对应的确认强度。 */
export function domainRequiresTypedConfirm(domain: DataDomain): boolean {
  return domain.risk === "user"
}
