/**
 * 设置写入器注册表（方案 d23eb1df P1）。
 *
 * ## 为什么不能只写 localStorage
 *
 * 界面上的设置值来自两个地方：`localStorage`（store 初始化时读一次）与内存里的
 * `useWikiStore`。只 `localStorage.setItem` 而不动 store，界面**不会刷新**——
 * 这正是本阶段验收的硬要求（「界面即时反映」）。所以每个可写键都注册一个写入器，
 * 复用应用自己的 setter（`setUiFontSizeScale` / `setTheme` / `saveTheme` …），
 * 而不是另写一套原始存储写入。
 *
 * ## 为什么写入器是显式白名单而不是按 storage 分派
 *
 * 「能写」不等于「登记了」。真正能保证即时生效的键是少数（有 store setter /
 * 有副作用路径）；其余键即使登记在 catalog 里也保持 `scope: "read"`。
 * 白名单在这里和 catalog 的 `scope` 字段互为校验：catalog 说是 `write` 但这里
 * 没有写入器，就是登记错了——`assertWritersCoverWritableKeys` 会在模块加载时炸。
 */

import { useWikiStore } from "@/stores/wiki-store"
import {
  saveAiChatModel,
  saveDefaultLlmModel,
  saveTheme,
  saveUiFontSizeScale,
} from "@/lib/project-store"
import { applyTheme, type ThemeMode } from "@/lib/theme-utils"

import { SETTINGS_CATALOG, SETTINGS_BY_KEY, type SettingsEntry } from "./settings-catalog"

/** 单个键的读/写实现。`write` 返回**落盘后**的实际值（可能与传入不同，如钳制）。 */
export interface SettingWriter {
  read: () => unknown
  write: (value: unknown) => Promise<unknown>
}

function asBoolean(value: unknown): boolean {
  return value === true
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value)
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value)
}

/**
 * 可写键 → 写入器。
 *
 * 每个写入器都是「持久化 + 内存态」成对出现，缺一不可：
 * 只持久化则界面不刷新，只改内存则重启丢失。
 */
const WRITERS: ReadonlyMap<string, SettingWriter> = new Map<string, SettingWriter>([
  [
    "niko-buddy-ui-font-size-scale",
    {
      read: () => useWikiStore.getState().uiFontSizeScale,
      write: async (value) => {
        const scale = asNumber(value)
        // 与设置页保存路径一致：先落 app-state 镜像，再走 store setter
        // （后者同时写 localStorage 并更新内存态）。
        await saveUiFontSizeScale(scale)
        useWikiStore.getState().setUiFontSizeScale(scale)
        return useWikiStore.getState().uiFontSizeScale
      },
    },
  ],
  [
    "niko-buddy-focus-mode",
    {
      read: () => useWikiStore.getState().focusMode,
      write: async (value) => {
        useWikiStore.getState().setFocusMode(asBoolean(value))
        return useWikiStore.getState().focusMode
      },
    },
  ],
  [
    "niko-buddy-chat-dock-position",
    {
      read: () => useWikiStore.getState().chatDockPosition,
      write: async (value) => {
        useWikiStore.getState().setChatDockPosition(asString(value) as "bottom" | "right")
        return useWikiStore.getState().chatDockPosition
      },
    },
  ],
  [
    "niko-buddy-offline-mode",
    {
      read: () => useWikiStore.getState().offlineMode,
      write: async (value) => {
        useWikiStore.getState().setOfflineMode(asBoolean(value))
        return useWikiStore.getState().offlineMode
      },
    },
  ],
  [
    "theme",
    {
      read: () => useWikiStore.getState().theme,
      write: async (value) => {
        const theme = asString(value) as ThemeMode
        await saveTheme(theme)
        useWikiStore.getState().setTheme(theme)
        // 只改 store 不改 DOM 等于没生效——applyTheme 才是让界面真正换肤的那一步。
        applyTheme(theme)
        return useWikiStore.getState().theme
      },
    },
  ],
  [
    "defaultLlmModel",
    {
      read: () => useWikiStore.getState().defaultLlmModel,
      write: async (value) => {
        const model = asString(value)
        await saveDefaultLlmModel(model)
        useWikiStore.getState().setDefaultLlmModel(model)
        return useWikiStore.getState().defaultLlmModel
      },
    },
  ],
  [
    "aiChatModel",
    {
      read: () => useWikiStore.getState().aiChatModel,
      write: async (value) => {
        const model = asString(value)
        await saveAiChatModel(model)
        useWikiStore.getState().setAiChatModel(model)
        return useWikiStore.getState().aiChatModel
      },
    },
  ],
])

/** 取某个键的写入器；未注册返回 `null`（调用方据此拒绝）。 */
export function getWriter(key: string): SettingWriter | null {
  return WRITERS.get(key) ?? null
}

/** 校验失败的统一形态：消息直接给调用方看，必须说清「哪个值、为什么不行」。 */
export class SettingsValidationError extends Error {}

/**
 * 按 catalog 的 kind/enumValues/min/max 校验传入值。
 *
 * **越界一律拒绝，不静默钳制**：钳制会让调用方以为自己写成功了，实际落盘的是
 * 另一个值——那是最难查的一类不一致。宁可报错。
 */
export function validateValue(entry: SettingsEntry, value: unknown): void {
  switch (entry.kind) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new SettingsValidationError(
          `${entry.key} 需要有限数字，收到 ${JSON.stringify(value)}`,
        )
      }
      if (entry.min !== undefined && value < entry.min) {
        throw new SettingsValidationError(`${entry.key} 不得小于 ${entry.min}，收到 ${value}`)
      }
      if (entry.max !== undefined && value > entry.max) {
        throw new SettingsValidationError(`${entry.key} 不得大于 ${entry.max}，收到 ${value}`)
      }
      return
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw new SettingsValidationError(
          `${entry.key} 需要布尔值 true/false，收到 ${JSON.stringify(value)}`,
        )
      }
      return
    }
    case "enum": {
      const allowed = entry.enumValues ?? []
      if (typeof value !== "string" || !allowed.includes(value)) {
        throw new SettingsValidationError(
          `${entry.key} 只接受 ${allowed.map((v) => `"${v}"`).join(" / ")}，收到 ${JSON.stringify(value)}`,
        )
      }
      return
    }
    case "json": {
      // json 类键的落盘形态是 JSON 字符串；这里接受字符串或任意可序列化值。
      if (typeof value === "string") {
        try {
          JSON.parse(value)
        } catch {
          throw new SettingsValidationError(`${entry.key} 需要合法 JSON 字符串，收到无法解析的值`)
        }
        return
      }
      if (value === null || typeof value !== "object") {
        throw new SettingsValidationError(`${entry.key} 需要 JSON 数组/对象或 JSON 字符串`)
      }
      return
    }
    case "string": {
      if (typeof value !== "string") {
        throw new SettingsValidationError(
          `${entry.key} 需要字符串，收到 ${JSON.stringify(value)}`,
        )
      }
      return
    }
  }
}

/**
 * 模块加载时自检：catalog 里每个 `scope: "write"` 的键都必须有写入器。
 *
 * 反向（有写入器但 catalog 是 read）同样算登记错误——那意味着某个键能被写，
 * 但 schema 对外声称它只读。
 */
function assertWritersCoverWritableKeys(): void {
  const writable = SETTINGS_CATALOG.filter((e) => e.scope === "write").map((e) => e.key)
  const missing = writable.filter((key) => !WRITERS.has(key))
  const extra = [...WRITERS.keys()].filter((key) => {
    const entry = SETTINGS_BY_KEY.get(key)
    return !entry || entry.scope !== "write"
  })
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `settings-writers 与 catalog 不一致：缺少写入器 [${missing.join(", ")}]，` +
        `多余写入器 [${extra.join(", ")}]`,
    )
  }
}

assertWritersCoverWritableKeys()
