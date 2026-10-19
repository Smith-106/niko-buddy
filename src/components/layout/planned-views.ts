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
  // WaveC 毕业后登记表已清空：全部 15 个灰卡视图均已落地为真视图。
  // 注册表与 isPlannedView/getPlannedView 保留（空表恒返回 false/undefined），
  // content-area 的占位分支与 workbench 的置灰逻辑随之自然退役（无分支改动）。
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
