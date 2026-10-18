// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 计划态视图登记表（单一真源）。
 *
 * 这些视图已经在 `activeView` 联合类型里（可被 setActiveView / 深链赋值），但功能
 * 尚未实现。此前它们既没有渲染分支、也没有占位页，点开/被赋值时会落到
 * content-area 的 `default`（聊天面板）——语义错误的页面。
 *
 * 现在：工作台的卡禁用态与 content-area 的占位渲染都从这张表派生，
 * 两边不可能再漂移；新增计划模块只改这里一处。
 */
export interface PlannedViewSpec {
  /** 视图 key，必须存在于 wiki-store 的 activeView 联合类型内。 */
  view: string
  /** 卡片标题 i18n key。 */
  labelKey: string
  /** 卡片描述 i18n key。 */
  descKey: string
}

export const PLANNED_VIEWS: readonly PlannedViewSpec[] = [
  // 生产链
  { view: "followUpCenter", labelKey: "wb.card.followUp", descKey: "wb.card.followUpDesc" },
  { view: "liveExecution", labelKey: "wb.card.live", descKey: "wb.card.liveDesc" },
  { view: "bookshelf", labelKey: "wb.card.bookshelf", descKey: "wb.card.bookshelfDesc" },
  { view: "creativeHub", labelKey: "wb.card.creativeHub", descKey: "wb.card.creativeHubDesc" },
  // 资产库
  { view: "worldLibrary", labelKey: "wb.card.worldLibrary", descKey: "wb.card.worldLibraryDesc" },
  { view: "genreLibrary", labelKey: "wb.card.genreLibrary", descKey: "wb.card.genreLibraryDesc" },
  { view: "storyModeLibrary", labelKey: "wb.card.storyMode", descKey: "wb.card.storyModeDesc" },
  { view: "titleStudio", labelKey: "wb.card.titleStudio", descKey: "wb.card.titleStudioDesc" },
  { view: "styleEngine", labelKey: "wb.card.styleEngine", descKey: "wb.card.styleEngineDesc" },
  { view: "antiAiRules", labelKey: "wb.card.antiAi", descKey: "wb.card.antiAiDesc" },
  // 配置
  { view: "modelRoutes", labelKey: "wb.card.modelRoutes", descKey: "wb.card.modelRoutesDesc" },
  { view: "mcpManager", labelKey: "wb.card.mcp", descKey: "wb.card.mcpDesc" },
  { view: "workflowEditor", labelKey: "wb.card.workflowEditor", descKey: "wb.card.workflowEditorDesc" },
  { view: "marketRadar", labelKey: "wb.card.marketRadar", descKey: "wb.card.marketRadarDesc" },
  { view: "help", labelKey: "wb.card.help", descKey: "wb.card.helpDesc" },
  // 数据
  { view: "exportCenter", labelKey: "wb.card.exportCenter", descKey: "wb.card.exportCenterDesc" },
] as const

const PLANNED_VIEW_BY_KEY = new Map(PLANNED_VIEWS.map((spec) => [spec.view, spec]))

/** 是否计划态视图（含类型收窄用）。 */
export function isPlannedView(view: string): boolean {
  return PLANNED_VIEW_BY_KEY.has(view)
}

/** 取计划态视图登记项；非计划态返回 undefined。 */
export function getPlannedView(view: string): PlannedViewSpec | undefined {
  return PLANNED_VIEW_BY_KEY.get(view)
}
