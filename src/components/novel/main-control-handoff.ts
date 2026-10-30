// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

// 章节页 → 主控的目标交接（UX 审计批次二·8）：章节页「生成本章草稿」只预填主控目标并跳转，
// 不自动执行；用户在主控点「开始执行」才真正调模型。仅内存，不落盘、不进 status.json。

let pendingGoal: string | null = null

/** 写入待交接的主控目标（覆盖上一次未取走的值）。 */
export function setMainControlGoalHandoff(goal: string): void {
  const trimmed = goal.trim()
  pendingGoal = trimmed ? trimmed : null
}

/** 只读不清空（供 useState 初始化；StrictMode 下初始化会跑两次）。 */
export function peekMainControlGoalHandoff(): string | null {
  return pendingGoal
}

/** 清空待交接目标（主控挂载后在 effect 里调用）。 */
export function clearMainControlGoalHandoff(): void {
  pendingGoal = null
}

/** 章节页默认目标文案：按章节标题生成一句作者语言的目标。 */
export function buildChapterDraftGoal(chapterTitle: string): string {
  const title = chapterTitle.trim()
  return title ? `为「${title}」生成本章草稿` : "生成下一章草稿"
}
