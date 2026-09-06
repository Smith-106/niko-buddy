/**
 * Wave 3 计划模式 — canonical 公共出口。
 *
 * 主链/UI 只从本文件导入（耦合治理：与 user-memory/reference 同款分层纪律）。
 */

export {
  buildChapterPlanView,
  buildChapterPlan,
  PLAN_DIMENSION_TOP_N,
  PLAN_DIMENSION_CHAR_BUDGET,
  PLAN_STATE_DELTA_CHAPTERS,
  type ChapterPlanInput,
  type PlanSource,
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
  // P2-IMP-11 四新维类型面
  PlanDimensionSlice,
  StateDeltaPlanItem,
  ParticlePlanItem,
} from "./types"
