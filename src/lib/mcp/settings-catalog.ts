/**
 * 设置目录 catalog —— 「所有选项和设置」的可枚举真源（方案 d23eb1df P0）。
 *
 * 为什么要这个文件：应用设置散落三处，且此前**没有任何统一描述**。
 * - `localStorage`：20 个键（`niko-buddy-*` / `lk-*`），只在 WebView 里
 * - `app-state.json`：tauri-plugin-store 管理的全局状态
 * - Rust 凭据库：API key 等，设备绑定加密
 *
 * 没有目录就没法对外暴露，也没法保证「桥不变成任意 localStorage 读写通道」。
 * 因此本文件是**白名单的唯一真源**：`state-bridge.ts` 只放行这里登记过的键。
 *
 * 本任务（P0）只登记已核实的事实：键名、存储归属、权限域。类型/默认值/展示文案
 * 由后续任务补齐——故意留空而不是猜，猜出来的默认值会变成对外暴露的错误契约。
 */

/** 设置项落在哪个存储。 */
export type SettingsStorage = "localStorage" | "appState" | "secretRef"

/**
 * 权限域。P0 全部为 `read`——只读投影锁定
 * （`architecture-constraints-400`：控制台=只读投影，不改账本写入与 status 真源）。
 */
export type SettingsScope = "read" | "write"

export interface SettingsEntry {
  /** 存储中的实际键名（对 `localStorage` 即 localStorage key）。 */
  key: string
  storage: SettingsStorage
  scope: SettingsScope
}

/**
 * 全部已登记的 `localStorage` 键。
 *
 * 来源：对 `src/` 全量 grep `"niko-buddy-*"` / `"lk-*"` 去重后人工核对，
 * 剔除了三个非设置用途的临时键（`lk-1` / `lk-new` / `lk-cache`）。
 */
export const SETTINGS_CATALOG: readonly SettingsEntry[] = [
  // ── 界面与布局 ──────────────────────────────────────────────────────────
  { key: "niko-buddy-ui-font-size-scale", storage: "localStorage", scope: "read" },
  { key: "niko-buddy-focus-mode", storage: "localStorage", scope: "read" },
  { key: "niko-buddy-chat-dock-position", storage: "localStorage", scope: "read" },
  { key: "niko-buddy-nav-collapsed-groups", storage: "localStorage", scope: "read" },
  { key: "niko-buddy-recent-views", storage: "localStorage", scope: "read" },
  { key: "lk-sidebar-collapsed", storage: "localStorage", scope: "read" },
  { key: "lk-chat-height", storage: "localStorage", scope: "read" },
  { key: "lk-chat-right-width", storage: "localStorage", scope: "read" },

  // ── 关系图显示 ──────────────────────────────────────────────────────────
  { key: "lk-graph-label-display-mode", storage: "localStorage", scope: "read" },
  { key: "lk-graph-edge-color", storage: "localStorage", scope: "read" },
  { key: "lk-graph-edge-strength-v2", storage: "localStorage", scope: "read" },
  { key: "lk-graph-edge-style", storage: "localStorage", scope: "read" },
  { key: "lk-graph-edge-labels-always", storage: "localStorage", scope: "read" },

  // ── 行为开关 ────────────────────────────────────────────────────────────
  { key: "niko-buddy-offline-mode", storage: "localStorage", scope: "read" },
  { key: "niko-buddy-deep-chapter-draft", storage: "localStorage", scope: "read" },
  { key: "niko-buddy-novel-session-debug", storage: "localStorage", scope: "read" },
  { key: "niko-buddy-context-usage", storage: "localStorage", scope: "read" },
  { key: "niko-buddy-usage-guide-prompt-dismissed", storage: "localStorage", scope: "read" },

  // ── 其它 ────────────────────────────────────────────────────────────────
  { key: "niko-buddy-local", storage: "localStorage", scope: "read" },
  { key: "niko-buddy-skill", storage: "localStorage", scope: "read" },
]

/** 键 → 条目索引，供 O(1) 白名单判定。 */
export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingsEntry> = new Map(
  SETTINGS_CATALOG.map((entry) => [entry.key, entry]),
)

/**
 * 状态桥是否允许操作该键。
 *
 * 未登记的键一律拒绝——这是桥不被滥用成「任意 localStorage 读写通道」的唯一保证。
 * 不做前缀匹配：`niko-buddy-` / `lk-` 前缀下的键并非都可暴露，逐键登记才可控。
 */
export function isBridgeAllowedKey(key: string): boolean {
  return SETTINGS_BY_KEY.has(key)
}
