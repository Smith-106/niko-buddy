// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 草稿对比/采纳异步对话框请求代际守卫：
 * 每次打开 Diff 或触发采纳确认前递增代际令牌；
 * 当切换项目、关闭弹窗、取消操作或组件卸载时调用 invalidate()，
 * 拦截过期的异步返回，杜绝旧草稿内容覆盖当前弹窗或触发误采纳。
 */
export interface DraftDialogGuard {
  /** 开启新一代异步请求并返回当前代际令牌。 */
  begin(): number
  /** 判断传入令牌是否仍是最新有效代际。 */
  isCurrent(token: number): boolean
  /** 立即作废全部在途请求。 */
  invalidate(): void
  /** 读取当前代际序号（便于诊断与测试）。 */
  currentToken(): number
}

export function createDraftDialogGuard(): DraftDialogGuard {
  let current = 0
  return {
    begin(): number {
      current += 1
      return current
    },
    isCurrent(token: number): boolean {
      return token > 0 && token === current
    },
    invalidate(): void {
      current += 1
    },
    currentToken(): number {
      return current
    },
  }
}
