/**
 * 最长公共子序列（LCS）差异计算 — 纯函数，零 IO/零依赖。
 *
 * 按公共知识自实现标准动态规划算法（MIT licensed），不拷贝任何上游代码（GPL-FENCE 约束）。
 * 供 Monaco DiffEditor 轻量场景或测试断言使用；Monaco 自身也内置 diff，
 * 此函数用于无需加载编辑器的纯逻辑比对。
 */

export type DiffChangeType = "equal" | "insert" | "delete"

export interface DiffChange {
  type: DiffChangeType
  text: string
}

/**
 * 计算 original → replacement 的字符级差异序列。
 * 使用经典动态规划求解 LCS，然后回溯生成变化序列。
 * 相邻同类型块会被合并，降低 Change 数量。
 *
 * @param original - 原始文本
 * @param replacement - 替换后的文本
 * @returns 差异变化序列
 */
export function computeLcsDiff(original: string, replacement: string): DiffChange[] {
  const m = original.length
  const n = replacement.length

  // dp[i][j] = original[i..] 与 replacement[j..] 的 LCS 长度
  const dp: number[][] = Array.from({ length: m + 1 }, () => 
    new Array(n + 1).fill(0)
  )

  // 填充 DP 表（从后往前）
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (original[i] === replacement[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  const changes: DiffChange[] = []
  let i = 0
  let j = 0

  // 辅助函数：推送变化并合并相邻同类块
  const push = (type: DiffChangeType, text: string): void => {
    const last = changes[changes.length - 1]
    if (last && last.type === type) {
      last.text += text
    } else {
      changes.push({ type, text })
    }
  }

  // 回溯生成变化序列
  while (i < m && j < n) {
    if (original[i] === replacement[j]) {
      // 相等段：尽量延伸合并
      let k = i
      let l = j
      while (k < m && l < n && original[k] === replacement[l]) {
        k += 1
        l += 1
      }
      push("equal", original.slice(i, k))
      i = k
      j = l
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // 从 original 删除一个字符（LCS 走 original 侧）
      push("delete", original[i])
      i += 1
    } else {
      // 从 replacement 插入一个字符（LCS 走 replacement 侧）
      push("insert", replacement[j])
      j += 1
    }
  }

  while (i < m) {
    push("delete", original[i])
    i += 1
  }
  while (j < n) {
    push("insert", replacement[j])
    j += 1
  }

  return changes
}
