/**
 * Vitest global setup: mock react-i18next so component specs see real Chinese
 * strings (looked up from src/i18n/zh.json) instead of raw keys.
 *
 * File-level `vi.mock("react-i18next", ...)` in individual specs still takes
 * precedence over this global mock, so specs with custom t behavior are
 * unaffected.
 *
 * t/i18n 为模块级单例（同一引用）：避免组件 effect 依赖 [.., t] 因每次
 * useTranslation() 返回新闭包而误重跑（mermaid render 2 次类问题）。
 */
import { vi } from "vitest"
import zh from "../i18n/zh.json"

vi.mock("react-i18next", () => {
  // 工厂内自包含：vi.mock 工厂会被 hoist，不可引用外部 lookup。
  function lookupInner(key: string): string | undefined {
    let o: unknown = zh
    for (const p of key.split(".")) {
      if (o == null || typeof o !== "object") return undefined
      o = (o as Record<string, unknown>)[p]
    }
    return typeof o === "string" ? o : undefined
  }
  type TOptions = { defaultValue?: string; message?: string } | string
  const t = (key: string, opts?: TOptions) => {
    const base =
      lookupInner(key) ?? (typeof opts === "string" ? opts : opts?.defaultValue) ?? key
    if (opts && typeof opts === "object") {
      let s: string = base
      for (const [k, v] of Object.entries(opts)) {
        s = s.split(`{{${k}}}`).join(String(v))
      }
      return s
    }
    return base
  }
  const shared = {
    t,
    i18n: { language: "zh", changeLanguage: () => Promise.resolve("zh") },
  }
  return {
    initReactI18next: { type: "3rdParty", init: () => {} },
    useTranslation: () => shared,
    Trans: ({ children }: { children?: unknown }) => children,
    I18nextProvider: ({ children }: { children?: unknown }) => children,
  }
})
