/** 前端传入 Rust 端的项目信息 */
export interface ProjectBackupInfo {
  id: string
  path: string
  name: string
}

/** 导出参数 */
export interface ExportParams {
  savePath: string
  localStorageData: Record<string, string>
  projects: ProjectBackupInfo[]
}

/** 导出结果 */
export interface ExportResult {
  success: boolean
  warnings: string[]
  fileCount: number
  totalSize: number
  error: string | null
}

/** 导入策略 */
export type ImportStrategy = "full" | "global-only" | "selective"

/** 选择性导入时的项目恢复信息 */
export interface ProjectRestoreInfo {
  id: string
  targetPath: string
}

/** 导入参数 */
export interface ImportParams {
  zipPath: string
  strategy: ImportStrategy
  projects?: ProjectRestoreInfo[]
}

/** 项目恢复结果 */
export interface ProjectRestoreResult {
  id: string
  path: string
  name: string
  success: boolean
  error: string | null
}

/** 导入结果 */
export interface ImportResult {
  success: boolean
  appState: Record<string, unknown> | null
  localStorageData: Record<string, string> | null
  projects: ProjectRestoreResult[]
  warnings: string[]
  error: string | null
}

/** 备份清单（zip 内 manifest.json） */
export interface BackupManifest {
  backupVersion: number
  createdAt: string
  appVersion: string
  projects: ProjectBackupInfo[]
}

/**
 * 进度事件载荷（`backup-progress` 通道）。
 *
 * 该通道由两次发射方共用：`commands/backup.rs` 发 `export` / `import`，
 * `canon/export.rs` 复用同一契约（同一 payload 形状）发 `canon_export` /
 * `canon_restore`，仅以 `operation` 区分来源。所以 union 必须包含 canon 两值，
 * 否则类型在后端真实取值处撒谎（见 `scripts/check-consistency.mjs`）。
 */
export type BackupProgressOperation = "export" | "import" | "canon_export" | "canon_restore"

export interface BackupProgressPayload {
  operation: BackupProgressOperation
  stage: string
  current: number
  total: number
  message: string
}

/** 进度回调 */
export type BackupProgressCallback = (payload: BackupProgressPayload) => void

/** 项目备份范围盘点（只读，8 类项目内容，对齐 v2 全量书稿备份范围）。 */
export interface ProjectBackupScopeInventory {
  /** 正文与章节（QM/chapters 或 wiki/chapters） */
  chapters: number
  /** 大纲文件（QM/outlines 或 wiki/outlines） */
  outlines: number
  /** 设定与词条（QM/wiki 下除 chapters/outlines 外的其余文件） */
  settings: number
  /** 历史快照（.novel/snapshots/） */
  snapshots: number
  /** 待采纳草稿箱（.qm-drafts/） */
  qmDrafts: number
  /** 会话状态（.novel/status.json，0 或 1） */
  status: number
  /** 事实库（.niko-buddy/lancedb/） */
  canonLancedb: number
  /** 书魂与规范文档（顶层 soul.md / schema.md / purpose.md） */
  rootDocs: number
  /** 解析到的知识目录根（QM 优先于 wiki） */
  knowledgeRoot: "QM" | "wiki" | null
}
