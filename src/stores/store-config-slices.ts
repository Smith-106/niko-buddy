// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * store-config-slices.ts — C6 上帝模块拆解契约（步骤①：契约 + 边界 lint，不迁代码）。
 *
 * ingest 编排/IO 拆解契约（同一文件 §ingest-contract，步骤①只立字据）：
 *   - 编排面（ingestChapter 主流程：novelMode 门控 → 双写 replay → 配置装配 →
 *     frontmatter 门控 → 章号门控 → failed 自愈 → extractSnapshotWithLLM → 写回链）：
 *     保留在 `chapter-ingest.ts`，是唯一对外编排名；其函数签名冻结
 *     `(projectPath, chapterPath, _reviewModel?, signal?, options: IngestChapterOptions)`，
 *     `IngestChapterOptions` 只增可选字段（DI 优先、缺省回退 store，见 IngestChapterOptions 注释）。
 *   - IO 面（readFile/writeFileAtomic/listDirectory/fileExists/createDirectory/deleteFile、
 *     snapshot 历史读写、memory 同步写回、community-summary 读写、双写 replay/hook）：
 *     全部经 `@/commands/fs` 与既有 *-store / *-ledger 模块进入，不得在编排函数体内
 *     直写新 IO 原语；新增 IO 面统一先落对应 store/ledger 模块再由编排调用。
 *   - store 反向依赖红线：`chapter-ingest.ts` 对 `useWikiStore.getState()` 的 15 处直连
 *     调用只允许经 `IngestChapterOptions` 可选字段收敛（已有 llmConfig/novelConfig/
 *     novelMode/embeddingConfig/onCommunitySummaryError/now 六字段），新增直连即违规，
 *     步骤②按字段逐个收敛；本步先立规（check-boundaries C6 用例覆盖契约层，ingest 红线
 *     由本注释 + spec 锁定，迁移时逐字段补用例）。
 *
 * 背景（PLAN C6 = P2-6）：`src/stores/wiki-store.ts`（1087 行，~40 导出）是
 * UI store 上帝模块——zustand `WikiState` 把「项目/文件树」「LLM/搜索/embedding/
 * rerank/multimodal/proxy/定时导入/source-watch 等全部配置」「novelConfig」
 * 「UI 偏好」「瞬态任务态（lint/review/final-save）」塞进单一 store + 单一文件。
 * 238 个生产文件 import 它，其中只有 ~20 个真的需要 `useWikiStore` 本体；
 * 其余 ~86 个只要 `LlmConfig` 类型、~20 个只要 `NovelConfig`，却被迫拖入整个
 * store 模块图（类型 → 运行时耦合）。
 *
 * 本文件是拆解的**契约面**（保守档：只新增，不删不改既有文件）：
 *   1. 三个只读配置切片类型（llm / search / source-watch）在此**重导出为 canonic 别名**，
 *      并冻结字段契约（`Readonly<>` 快照）：后续步骤②迁代码时，调用方改从这里取类型，
 *      `wiki-store.ts` 只保留 `import type ... from` 回指（类型单向，不形成运行时环）。
 *   2. 切片选择器契约：`selectLlmSlice / selectSearchSlice / selectSourceWatchSlice`
 *      声明“只读消费”形状——组件若只需要读配置，优先用这些选择器而非整 store 订阅
 *      （减少重渲染面；行为零变更，本步只落类型，不断言运行时）。
 *   3. 方向规则（由 `scripts/check-boundaries.mjs` C6 fixture 强制执行）：
 *      - `src/stores/store-config-slices.ts` 不得 import `wiki-store.ts`
 *       （契约层零运行时依赖，违者 lint 熔断）；
 *      - 步骤②完成后，`chapter-ingest.ts` 不得再直连 `useWikiStore.getState()`
 *       （走 `IngestChapterOptions` DI；本步先立规，迁移另行）。
 *
 * 验收（步骤①）：
 *   - `node scripts/check-boundaries.mjs` 含 C6 用例且全绿；
 *   - `npx tsc --build --force` 0 错误；
 *   - 本文件被接线门计为“有生产引用”（被 wiki-store 回指 + boundaries 脚本引用）。
 */

import type {
  EmbeddingConfig,
  LlmConfig,
  RerankConfig,
  SearchApiConfig,
  SourceWatchConfig,
} from "./wiki-store"

/** 只读 LLM 配置切片（canonic 别名；字段契约见 wiki-store `LlmConfig`）。 */
export type LlmConfigSlice = Readonly<LlmConfig>
/** 只读搜索配置切片（含 providerConfigs；字段契约见 wiki-store `SearchApiConfig`）。 */
export type SearchConfigSlice = Readonly<SearchApiConfig>
/** 只读 embedding 配置切片（字段契约见 wiki-store `EmbeddingConfig`）。 */
export type EmbeddingConfigSlice = Readonly<EmbeddingConfig>
/** 只读 rerank 配置切片（字段契约见 wiki-store `RerankConfig`）。 */
export type RerankConfigSlice = Readonly<RerankConfig>
/** 只读 source-watch 配置切片（字段契约见 wiki-store `SourceWatchConfig`）。 */
export type SourceWatchConfigSlice = Readonly<SourceWatchConfig>

/**
 * 最小可读 store 形状（结构类型，不导入运行时 store）。
 * 满足“能选出三切片”的最小面，供选择器契约使用。
 */
export interface ConfigSliceReadable {
  readonly llmConfig: LlmConfig
  readonly searchApiConfig: SearchApiConfig
  readonly embeddingConfig: EmbeddingConfig
  readonly sourceWatchConfig: SourceWatchConfig
}

/** 只读消费：取 LLM 切片（调用方不得经此句柄写回）。 */
export function selectLlmSlice(s: ConfigSliceReadable): LlmConfigSlice {
  return s.llmConfig
}

/** 只读消费：取搜索切片。 */
export function selectSearchSlice(s: ConfigSliceReadable): SearchConfigSlice {
  return s.searchApiConfig
}

/** 只读消费：取 source-watch 切片。 */
export function selectSourceWatchSlice(s: ConfigSliceReadable): SourceWatchConfigSlice {
  return s.sourceWatchConfig
}
