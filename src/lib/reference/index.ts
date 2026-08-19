/**
 * Wave 2 @引用系统 — canonical 公共出口。
 *
 * 主链/UI 只从本文件导入（耦合治理：与 user-memory 同款分层纪律）。
 */

export {
  parseReferences,
  resolveReferences,
  scoreCandidate,
  chineseNumberToInt,
} from "./resolve"
export {
  characterProvider,
  chapterProvider,
  settingProvider,
  ALL_REFERENCE_PROVIDERS,
  loadAllReferenceCandidates,
  type ReferenceProvider,
} from "./providers"
export {
  searchReferences,
  buildReferenceContext,
  formatReferenceSection,
  clearReferenceCache,
  REFERENCE_SECTION_CAP,
  REFERENCE_SNIPPET_CAP,
  REFERENCE_TOP_K,
  REFERENCE_CONCURRENCY_LIMIT,
} from "./search"
export type {
  ReferenceKind,
  ReferenceToken,
  ReferenceCandidate,
  ResolvedReference,
  ReferenceSearchHit,
  ReferenceContextOptions,
} from "./types"
