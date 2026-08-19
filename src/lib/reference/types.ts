/**
 * Wave 2 @引用系统 — 纯类型定义（零 IO、零依赖）。
 */

/** 引用实体类型：角色 / 章节 / 设定 */
export type ReferenceKind = "character" | "chapter" | "setting"

/** 从输入文本解析出的 @ 引用 token */
export interface ReferenceToken {
  /** 原始 token 文本（不含 @，如 "林墨" / "第3章"） */
  raw: string
  /** 完整匹配文本（含 @，如 "@林墨"），用于替换/标注 */
  full: string
  /** 解析出的类型（章节数字通道可提前判定；其余为 undefined 待候选匹配） */
  kind?: ReferenceKind
}

/** 候选实体（来自三类 provider 的候选装载） */
export interface ReferenceCandidate {
  id: string
  kind: ReferenceKind
  name: string
  /** 别名（角色 aura bindings / 章节标题等） */
  aliases?: string[]
  /** 命中分数（精确 100 > 别名 90 > 前缀 70 > 拼音 50 > 简繁 40） */
  score: number
  /** 来源摘要（≤40 字，供候选列表展示） */
  source?: string
}

/** 解析结果（含歧义信息） */
export interface ResolvedReference {
  token: ReferenceToken
  kind: ReferenceKind
  id: string
  name: string
  score: number
  /** 歧义：top-2 分差 < 15 时为 true，携带 top-3 候选 */
  ambiguity: boolean
  candidates?: ReferenceCandidate[]
}

/** 引用检索结果（携带 refId 归属） */
export interface ReferenceSearchHit {
  refId: string
  kind: ReferenceKind
  name: string
  type: "keyword" | "vector" | "graph" | "recent_chapter"
  path: string
  title: string
  snippet: string
  relevance: number
}

/** buildReferenceContext 选项 */
export interface ReferenceContextOptions {
  chapterNumber?: number
  /** 引用段字符上限（默认 2000，与 relatedChapters 同量级） */
  sectionCap?: number
  /** 每条 snippet 上限（默认 300） */
  snippetCap?: number
  /** 每引用检索 topK（默认 3） */
  topK?: number
  /** 是否注入用户记忆偏好原文（PR6 通道，默认 true） */
  includeUserMemory?: boolean
}
