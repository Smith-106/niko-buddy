/**
 * 旧「写作模型」配置被丢弃时的留痕登记表（DEBT-20261104-residual-04）。
 *
 * 为什么单独成模块：这个登记表既要被 `src/lib/project-store.ts`（检测旧键时写入）用，
 * 也要被设置页（告知用户）读。放在 `project-store.ts` 里会让任何 `vi.mock("@/lib/project-store")`
 * 的既有 spec 因为缺导出而红——已有 `novel-section.spec.tsx` 等多处局部 mock 该模块。
 * 独立成叶模块后，两侧都只依赖它，不再扩大 `project-store` 的对外面。
 *
 * 为什么需要留痕：`TASK-009` 真删除该字段后，旧配置里的**非空**值会被静默丢弃
 * （原实现只打一条 console 日志，用户在应用里看不到）。真实项目里确实存在这样的非空值，
 * 写作会从原来的配置模型切到 AI 会话当前模型——这是对用户有意义的行为变化。
 * 字段本身不复活（DEC-R2=A 不变），只把「丢弃了什么」留住并告知。
 *
 * 存储只取进程内 Map：这是「告知」的展示来源，不是状态真源（`status.json` 仍是唯一会话真源），
 * 也不落盘，避免为一次性提示引入新配置项或 schema 字段。
 *
 * @license MIT © Niko Buddy
 */

/** 一次「旧写作模型配置被丢弃」的记录。 */
export interface DiscardedWritingConfigNotice {
  /** 作用域：项目文件路径 / 项目 ID / 全局。 */
  scope: string
  /** 旧配置里该键的原始值；`null` 表示值不是可展示的原始类型。 */
  value: string | null
  /** 首次观察到的时间戳。 */
  discardedAt: number
}

const notices = new Map<string, DiscardedWritingConfigNotice>()

/** 记录一次丢弃（同一作用域保留首次观察，不刷屏）。 */
export function noteDiscardedWritingConfig(scope: string, raw: unknown): void {
  if (notices.has(scope)) return
  const value =
    typeof raw === "string" ? raw : raw === undefined || raw === null ? null : JSON.stringify(raw)
  notices.set(scope, { scope, value, discardedAt: Date.now() })
}

/** 读取某作用域被丢弃的旧值；没有则 `null`。 */
export function getDiscardedWritingConfig(scope: string): DiscardedWritingConfigNotice | null {
  return notices.get(scope) ?? null
}

/** 全部留痕（诊断 / 用户支持用）。 */
export function listDiscardedWritingConfigs(): DiscardedWritingConfigNotice[] {
  return [...notices.values()]
}

/** 仅供测试：清空留痕。 */
export function __resetDiscardedWritingConfigForTest(): void {
  notices.clear()
}
