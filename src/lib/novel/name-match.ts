/**
 * 中文人名命中判定（共享工具）。
 *
 * 中文没有词边界，名字判定只能靠**最长匹配优先**：
 * 命中的位置若被某个更长的已知名字覆盖（正文「王府」、已知名含「王府」），
 * 这次出现就不算「王」。这比「邻字边界」可靠——「王站在门外」后面紧跟汉字却是真命中。
 *
 * 已知名的来源由调用方决定（wiki 实体名、角色状态名、关系条目的对端名）；
 * 覆盖不到更长的未知名字（已知名只有「李四」、正文写「李四光」）时仍会命中，
 * 这是本口径的已知边界：调用方必须用 N/A 文案说清「单字/短名判定不可靠」，
 * 而不是把不确定当结论。
 */

/** 码点序比较（避免 UTF-16 代理对排序错乱，也避免 `localeCompare` 的环境依赖）。 */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  const size = Math.min(left.length, right.length)
  for (let i = 0; i < size; i += 1) {
    const diff = (left[i] as string).codePointAt(0)! - (right[i] as string).codePointAt(0)!
    if (diff !== 0) return diff
  }
  return left.length - right.length
}

export function nameAppears(text: string, name: string, knownNames: readonly string[]): boolean {
  if (!name) return false
  if (Array.from(name).length > 1) return text.includes(name)
  let from = 0
  for (;;) {
    const index = text.indexOf(name, from)
    if (index < 0) return false
    const absorbed = knownNames.some((other) => {
      if (other.length <= name.length || !other.includes(name)) return false
      const start = Math.max(0, index - other.length + 1)
      const at = text.indexOf(other, start)
      return at >= 0 && at <= index && index + name.length <= at + other.length
    })
    if (!absorbed) return true
    from = index + 1
  }
}

/** 单字名无法可靠判人：调用方应把这类名字记 N/A，而不是拿它下结论。 */
export function isUnreliableName(name: string): boolean {
  return Array.from(name).length <= 1
}
