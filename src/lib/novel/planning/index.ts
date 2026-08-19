/**
 * Wave 3 计划模式 — canonical 公共出口。
 *
 * 主链/UI 只从本文件导入（耦合治理：与 user-memory/reference 同款分层纪律）。
 */

export {
  buildChapterPlanView,
  buildChapterPlan,
  type ChapterPlanInput,
} from "./aggregate"
export {
  buildPlanningPrefillBlock,
  appendPlanningBlockToTaskBrief,
  taskBriefHasPlanningBlock,
  PLANNING_BLOCK_MARKER,
  PLANNING_BLOCK_CAP,
} from "./prefill"
export type {
  ChapterPlanView,
  ChapterPlanOptions,
  CharacterPlanItem,
  PlanDimensionStatus,
} from "./types"
