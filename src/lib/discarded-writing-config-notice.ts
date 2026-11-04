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
 * **key 契约（曾在这里踩过坑，勿再分裂）**：登记的 key 与查询的 key 必须是同一个函数算出来的。
 * 上一版写侧用「项目文件 <path>」这类人类可读作用域串做 key，读侧用裸项目路径查，两两不可能
 * 相等，`getDiscardedWritingConfig` 恒返回 null，横幅在生产环境一次都不会渲染。
 * 现在 key 一律由 `noticeKeyForProject()` 产出（归一化项目路径，或全局哨兵），
 * 人类可读作用域串降级为登记里的 `label` 字段，仅用于诊断展示。
 *
 * 存储只取进程内 Map：这是「告知」的展示来源，不是状态真源（`status.json` 仍是唯一会话真源），
 * 也不落盘，避免为一次性提示引入新配置项或 schema 字段。Map 之上的版本号让 UI 能订阅变化，
 * 而不是靠父组件偶然重渲染。
 *
 * @license MIT © Niko Buddy
 */

/** 无项目路径时的归一化 key。 */
export const GLOBAL_NOTICE_KEY = "__global__"

/** 一次「旧写作模型配置被丢弃」的记录。 */
export interface DiscardedWritingConfigNotice {
  /** 归一化 key（与 `noticeKeyForProject` 同源）。 */
  key: string
  /** 人类可读作用域（项目文件路径 / 项目 ID / 全局），仅用于诊断展示。 */
  label: string
  /** 旧配置里该键的原始值；`null` 表示值不是可展示的原始类型。 */
  value: string | null
  /** 首次观察到的时间戳。 */
  discardedAt: number
}

/**
 * 把项目路径归一化成登记 key。
 *
 * 归一化只做与平台无关的等价化：反斜杠转正斜杠、折叠重复分隔符、去掉尾部斜杠、
 * 去掉首尾空白。不做大小写折叠——Windows 上大小写不同可能是不同路径，
 * 而误合并比漏合并更难查。
 */
export function noticeKeyForProject(projectPath: string | null | undefined): string {
  if (typeof projectPath !== "string") return GLOBAL_NOTICE_KEY
  const normalized = projectPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
  return normalized.length > 0 ? normalized : GLOBAL_NOTICE_KEY
}

const notices = new Map<string, DiscardedWritingConfigNotice>()
const listeners = new Set<() => void>()
let revision = 0

function emit(): void {
  revision += 1
  for (const listener of listeners) listener()
}

/**
 * 记录一次丢弃（同一 key 保留首次观察，不刷屏）。
 *
 * 刻意用**具名对象**而不是位置参数：上一版签名是 `(projectPath, raw, label)`，
 * 第一参与第三参同为 `string`，把 `(projectPath, discarded, scope)` 误写成
 * `(scope, discarded, scope)` 时 TypeScript 完全不报错，运行时静默退化成全局哨兵 ——
 * 正是那个「告知横幅永不渲染」的缺陷本身。改成具名后这种误传无法通过类型检查。
 */
export function noteDiscardedWritingConfig(input: {
  /** 项目文件路径；缺省/空则登在全局哨兵下。 */
  projectPath: string | null | undefined
  /** 旧配置里该键的原始值。 */
  raw: unknown
  /** 人类可读作用域，仅用于诊断展示。 */
  label?: string
}): void {
  const key = noticeKeyForProject(input.projectPath)
  if (notices.has(key)) return
  const raw = input.raw
  const value =
    typeof raw === "string" ? raw : raw === undefined || raw === null ? null : JSON.stringify(raw)
  notices.set(key, { key, label: input.label ?? "未知作用域", value, discardedAt: Date.now() })
  emit()
}

/** 读取某项目被丢弃的旧值；没有则 `null`。 */
export function getDiscardedWritingConfig(
  projectPath: string | null | undefined,
): DiscardedWritingConfigNotice | null {
  return notices.get(noticeKeyForProject(projectPath)) ?? null
}

/**
 * 订阅留痕变化。UI 用 `useSyncExternalStore` 接它，这样留痕晚于首次渲染写入时
 * 横幅也能出现（上一版直接读 Map，靠父组件偶然重渲染生效）。
 */
export function subscribeDiscardedWritingConfig(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 当前留痕版本号，配合 `subscribeDiscardedWritingConfig` 给 `useSyncExternalStore` 用。 */
export function getDiscardedWritingConfigRevision(): number {
  return revision
}

/** 仅供测试：清空留痕。 */
export function __resetDiscardedWritingConfigForTest(): void {
  notices.clear()
  emit()
}
