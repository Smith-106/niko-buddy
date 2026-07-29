/**
 * 最长公共子序列 (LCS) 差异计算 — 纯函数，零 IO / 零依赖。
 *
 * 按公共知识自实现（标准 DP），不拷贝任何上游代码（GPL-FENCE 约束）。
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
 * 相邻同类型块会被合并，降低 Change 数量。
 */
export function computeLcsDiff(original: string, replacement: string): DiffChange[] {
  const m = original.length
  const n = replacement.length

  // dp[i][j] = LCS(original[i..], replacement[j..]) 的长度
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
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

  const push = (type: DiffChangeType, text: string): void => {
    const last = changes[changes.length - 1]
    if (last && last.type === type) {
      last.text += text
    } else {
      changes.push({ type, text })
    }
  }

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
