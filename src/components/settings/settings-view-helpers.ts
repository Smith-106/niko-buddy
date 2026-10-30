// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

/** settings-view 的纯函数：草稿与 store 基线的比较与合并。 */
import type { SettingsDraft } from "./settings-types"
import { SETTINGS_DOMAIN_DRAFT_KEYS, type SettingsDomain } from "./settings-nav-config"

/** 结构相等（与键顺序无关）。草稿值只含 JSON 可表示的数据。 */
export function settingsValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => settingsValueEqual(v, b[i]))
  }
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)])
  for (const k of keys) {
    // 缺失键与 undefined 视为相同，避免可选字段的展开差异被当作改动
    if (!settingsValueEqual(ra[k], rb[k])) return false
  }
  return true
}

/**
 * store 基线变化时合并草稿：
 * 某字段的草稿值仍等于旧基线（用户没改过）就采用新基线；
 * 已偏离旧基线（用户改过、尚未保存）就保留草稿值。
 * 这样自动保存的设置变化不会冲掉其它页还没保存的改动。
 *
 * adoptKeys：刚保存的域。其中基线确实变了的字段一律采用新基线，
 * 让保存时的规范化 / 夹值结果（trim、clamp、补默认值）回到草稿，界面显示的就是实际存下的值。
 */
export function mergeResyncedDraft(
  draft: SettingsDraft,
  prevBase: SettingsDraft,
  nextBase: SettingsDraft,
  adoptKeys?: ReadonlySet<keyof SettingsDraft>,
): SettingsDraft {
  const out = { ...nextBase }
  for (const key of Object.keys(nextBase) as (keyof SettingsDraft)[]) {
    if (adoptKeys?.has(key) && !settingsValueEqual(prevBase[key], nextBase[key])) continue
    if (!settingsValueEqual(draft[key], prevBase[key])) {
      ;(out as Record<string, unknown>)[key] = draft[key]
    }
  }
  return out
}

/** 已改动且与基线不同的域。touched 为用户经 setDraft 改过的键。 */
export function dirtySettingsDomains(
  draft: SettingsDraft,
  base: SettingsDraft,
  touched: ReadonlySet<keyof SettingsDraft>,
): Set<SettingsDomain> {
  const dirty = new Set<SettingsDomain>()
  for (const domain of Object.keys(SETTINGS_DOMAIN_DRAFT_KEYS) as SettingsDomain[]) {
    if (SETTINGS_DOMAIN_DRAFT_KEYS[domain].some((k) => touched.has(k) && !settingsValueEqual(draft[k], base[k]))) {
      dirty.add(domain)
    }
  }
  return dirty
}
