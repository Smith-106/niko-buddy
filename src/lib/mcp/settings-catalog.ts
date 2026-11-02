/**
 * 设置目录 catalog —— 「所有选项和设置」的可枚举真源（方案 d23eb1df P0）。
 *
 * ## 为什么需要它
 *
 * 应用设置散落三处且此前**没有任何统一描述**：
 * - `localStorage`：只在 WebView 里，Rust 进程读不到（需经状态桥）
 * - `app-state.json`：`tauri-plugin-store` 的自由键值库
 * - Rust 凭据库：API key 等，设备绑定加密
 *
 * 没有目录就既没法对外暴露，也没法保证「状态桥不变成任意 localStorage 读写通道」。
 * 因此本文件是**白名单的唯一真源**：`state-bridge.ts` 只放行这里登记过的键。
 *
 * ## 为什么 label 是普通字符串而不是 i18n key
 *
 * 本目录的消费者是**外部 Agent**（Claude Code / PI 读 `settings.schema` 的返回），
 * 不是界面。给它一个 `settings.mcp.catalog.lk-chat-height` 这样的 i18n key，它无法
 * 解析、也就不知道这个键是干什么的；给一句人话描述才有用。界面上若需要展示，
 * 由界面自己按 key 查 i18n，不经过本目录。
 *
 * ## 只登记已核实事实
 *
 * 每个键的类型与默认值都来自**代码实际读取处**（见每项的 `verifiedAt` 注释），
 * 不是从键名猜的。曾经按 grep 字面量枚举出 20 个「键」，逐个核对后发现 5 个是
 * 假阳性并已剔除 —— 详见文件末尾的「已剔除的假阳性」注释。猜出来的键会变成对外
 * 暴露的错误契约。
 */

/** 设置项落在哪个存储。 */
export type SettingsStorage = "localStorage" | "appState" | "secretRef"

/**
 * 存储值的表示类型。
 *
 * `boolean` 一律以 `"1"` / `"0"`（少数用 `"true"`）字符串形式落盘——`localStorage`
 * 只能存字符串。`json` 表示 JSON.stringify 后的数组/对象。
 */
export type SettingsValueKind = "string" | "number" | "boolean" | "json" | "enum"

/**
 * 权限域。P0 全部为 `read`——只读投影锁定
 * （`architecture-constraints-400`：控制台=只读投影，不改账本写入与 status 真源）。
 */
export type SettingsScope = "read" | "write"

export interface SettingsEntry {
  /** 存储中的实际键名。 */
  key: string
  storage: SettingsStorage
  scope: SettingsScope
  kind: SettingsValueKind
  /** 代码里的默认值（未设置时读取方返回的值）。`null` = 读取方无显式默认。 */
  defaultValue: string | number | boolean | null
  /** `kind === "enum"` 时的合法取值。 */
  enumValues?: readonly string[]
  /** 面向外部 Agent 的一句话说明。 */
  label: string
  /** 该键类型/默认值的代码出处（便于复核，不参与运行）。 */
  verifiedAt: string
}

/**
 * 全部已登记的 `localStorage` 设置键（15 个）。
 *
 * 分组只为可读性；顺序不影响行为（白名单按 key 精确匹配）。
 */
export const SETTINGS_CATALOG: readonly SettingsEntry[] = [
  // ── 界面与布局 ──────────────────────────────────────────────────────────
  {
    key: "niko-buddy-ui-font-size-scale",
    storage: "localStorage",
    scope: "read",
    kind: "number",
    defaultValue: 1,
    label: "界面字号缩放倍数，读取时钳制在 0.85–1.3",
    verifiedAt: "wiki-store-config.ts readStoredUiFontSizeScale",
  },
  {
    key: "niko-buddy-focus-mode",
    storage: "localStorage",
    scope: "read",
    kind: "boolean",
    defaultValue: false,
    label: "写作专注模式，落盘为 \"1\"/\"0\"",
    verifiedAt: "wiki-store.ts FOCUS_MODE_KEY 读写处",
  },
  {
    key: "niko-buddy-chat-dock-position",
    storage: "localStorage",
    scope: "read",
    kind: "enum",
    defaultValue: "bottom",
    enumValues: ["bottom", "right"],
    label: "聊天停靠位置：底部或右侧",
    verifiedAt: "wiki-store-config.ts readStoredChatDockPosition",
  },
  {
    key: "niko-buddy-nav-collapsed-groups",
    storage: "localStorage",
    scope: "read",
    kind: "json",
    defaultValue: "[]",
    label: "侧栏折叠的分组 id 数组（JSON 字符串）",
    verifiedAt: "wiki-store.ts 写入处 JSON.stringify([])",
  },
  {
    key: "niko-buddy-recent-views",
    storage: "localStorage",
    scope: "read",
    kind: "json",
    defaultValue: "[]",
    label: "最近访问的视图 id 数组（JSON 字符串）",
    verifiedAt: "wiki-store.ts 写入处 JSON.stringify([...])",
  },
  {
    key: "lk-sidebar-collapsed",
    storage: "localStorage",
    scope: "read",
    kind: "boolean",
    defaultValue: false,
    label: "侧栏是否折叠，落盘为 \"1\"/\"0\"",
    verifiedAt: "app-layout.tsx 读写处",
  },
  {
    key: "lk-chat-height",
    storage: "localStorage",
    scope: "read",
    kind: "number",
    defaultValue: 260,
    label: "底部聊天面板高度（px）",
    verifiedAt: "writing-workspace.tsx Number(getItem ?? \"260\")",
  },
  {
    key: "lk-chat-right-width",
    storage: "localStorage",
    scope: "read",
    kind: "number",
    defaultValue: 360,
    label: "右侧聊天面板宽度（px）",
    verifiedAt: "writing-workspace.tsx Number(getItem ?? \"360\")",
  },

  // ── 关系图显示 ──────────────────────────────────────────────────────────
  {
    key: "lk-graph-label-display-mode",
    storage: "localStorage",
    scope: "read",
    kind: "enum",
    defaultValue: "all",
    enumValues: ["all", "auto", "focused"],
    label: "关系图节点标签显示策略",
    verifiedAt: "wiki-store-config.ts readStoredGraphLabelDisplayMode",
  },
  {
    key: "lk-graph-edge-color",
    storage: "localStorage",
    scope: "read",
    kind: "string",
    defaultValue: "#7f8ea3",
    label: "关系图边颜色（6 位十六进制，读取时校验格式）",
    verifiedAt: "wiki-store-config.ts readStoredGraphEdgeColorHex",
  },
  {
    key: "lk-graph-edge-strength-v2",
    storage: "localStorage",
    scope: "read",
    kind: "number",
    defaultValue: 100,
    label: "关系图边宽百分比，读取时钳制在 40–200",
    verifiedAt: "wiki-store-config.ts readStoredGraphEdgeStrengthPercent",
  },
  {
    key: "lk-graph-edge-style",
    storage: "localStorage",
    scope: "read",
    kind: "enum",
    defaultValue: "curve",
    enumValues: ["curve", "arrow", "line"],
    label: "关系图连线样式",
    verifiedAt: "wiki-store-config.ts readStoredGraphEdgeStyle",
  },
  {
    key: "lk-graph-edge-labels-always",
    storage: "localStorage",
    scope: "read",
    kind: "boolean",
    defaultValue: false,
    label: "是否始终显示边标签，落盘为 \"true\"",
    verifiedAt: "wiki-store-config.ts readStoredGraphEdgeLabelsAlways",
  },

  // ── 行为开关 ────────────────────────────────────────────────────────────
  {
    key: "niko-buddy-offline-mode",
    storage: "localStorage",
    scope: "read",
    kind: "boolean",
    defaultValue: false,
    label: "离线模式，落盘为 \"1\"/\"0\"",
    verifiedAt: "wiki-store.ts getItem(OFFLINE_MODE_KEY) === \"1\"",
  },
  {
    key: "niko-buddy-usage-guide-prompt-dismissed",
    storage: "localStorage",
    scope: "read",
    kind: "boolean",
    defaultValue: false,
    label: "使用引导提示是否已被关闭，落盘为 \"1\"",
    verifiedAt: "usage-guide 组件 getItem === \"1\"",
  },
]

/** 键 → 条目索引，供 O(1) 白名单判定。 */
export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingsEntry> = new Map(
  SETTINGS_CATALOG.map((entry) => [entry.key, entry]),
)

/**
 * `app-state.json` 的存储说明。
 *
 * 它**没有固定 schema**：`tauri-plugin-store` 的自由键值库，键由运行时写入
 * （备份恢复路径 `commands/backup.rs` 直接 `store.set(key, value)`）。
 * 因此这里不列具体键，P1 需要时按运行时实际内容枚举。
 */
export const APP_STATE_STORAGE_NOTE =
  "app-state.json 是自由键值库，无固定 schema；键在运行时产生，需按实际内容枚举。"

/**
 * 凭据类别（`secretRef`）。
 *
 * **只登记类别，永不登记值**——这是 C-009「凭据不出应用边界」在 catalog 层的落实。
 * 任何试图从这里读到明文密钥的调用都必须失败。
 */
export const SECRET_REF_CATEGORIES: readonly { key: string; label: string }[] = [
  { key: "applock:passphrase", label: "应用锁口令派生值（非明文口令）" },
  { key: "mcp-server:bearer-token", label: "MCP 控制面 bearer token" },
  { key: "github", label: "GitHub 访问凭据" },
]

/**
 * 状态桥是否允许操作该键。
 *
 * 未登记的键一律拒绝——这是桥不被滥用成「任意 localStorage 读写通道」的唯一保证。
 * 不做前缀匹配：`niko-buddy-` / `lk-` 前缀下的键并非都可暴露，逐键登记才可控。
 */
export function isBridgeAllowedKey(key: string): boolean {
  return SETTINGS_BY_KEY.has(key)
}

/**
 * 已剔除的假阳性（保留记录，防止后来者再按字面量 grep 把它们加回来）。
 *
 * 这些字符串在 `src/` 里出现过，但**不是** `localStorage` 设置键：
 * - `niko-buddy-deep-chapter-draft` → 章节正文里的 HTML 注释标记
 *   （`MANAGED_DEEP_CHAPTER_DRAFT_RE`），不是存储键
 * - `niko-buddy-novel-session-debug` → 同上，HTML 注释标记
 * - `niko-buddy-context-usage` → 同上，HTML 注释标记
 *   （`MANAGED_CONTEXT_USAGE_RE`）
 * - `niko-buddy-skill` → 技能包导出 JSON 里的标识字段
 *   （`user-skill-store.ts` exportSkillToJson）
 * - `niko-buddy-local` → 技能包来源标识，仅出现在 spec 里
 * - `lk-1` / `lk-new` / `lk-cache` → 非设置用途的临时键
 */
export const EXCLUDED_FALSE_POSITIVES: readonly string[] = [
  "niko-buddy-deep-chapter-draft",
  "niko-buddy-novel-session-debug",
  "niko-buddy-context-usage",
  "niko-buddy-skill",
  "niko-buddy-local",
  "lk-1",
  "lk-new",
  "lk-cache",
]
