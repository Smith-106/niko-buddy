/**
 * mock-import-actual.ts — `vi.mock` partial-mock 统一封装（新增专用，不动存量）
 *
 * 背景（swarm ts-bloat-20261017「冲突/重复」指控）：仓内 `importOriginal` 用法
 * 有 `1666` 处引用 / `324` 个文件，写法三轨并存：
 *   · `async (importOriginal) => { const actual = await importOriginal<T>() ... }`
 *   · `async () => { const actual = await vi.importActual<T>(...) }`
 *   · 直接 `await vi.importActual(...)` 后再做断言
 * 本 helper 把「取 actual → 覆盖指定字段」这一最常见形态收敛为一条调用，
 * **仅供新增 spec 使用**；存量 1666 处保持原样，避免大面积语义漂移（ADR-49/50）。
 *
 * @license MIT © Niko Buddy
 */

/**
 * 生成 `vi.mock(path, factory)` 的工厂函数：先取模块 actual，再用 `overrides`
 * 覆盖指定字段（浅合并，actual 优先作为基底）。
 *
 * @example
 * ```ts
 * vi.mock("@/lib/source-watch-config", mockImportActual(() => ({
 *   loadSourceWatchConfig: vi.fn(),
 * })))
 * ```
 *
 * @param overrides 覆盖工厂；在 actual 取回后才调用，可安全使用 actual 值
 */
export function mockImportActual<TModule extends object>(
  overrides: (actual: TModule) => Partial<TModule> | Promise<Partial<TModule>>,
): (importOriginal: <T = TModule>() => Promise<T>) => Promise<TModule> {
  return async (importOriginal) => {
    const actual = await importOriginal<TModule>()
    return { ...actual, ...(await overrides(actual)) }
  }
}

/**
 * 直接取 actual 并浅合并覆盖（不经过 `vi.mock` 工厂），供需要显式 import 的场景。
 *
 * @param importActual `vi.importActual` 的绑定
 * @param overrides 覆盖工厂
 */
export async function mergeImportActual<TModule extends object>(
  importActual: <T = TModule>() => Promise<T>,
  overrides: (actual: TModule) => Partial<TModule> | Promise<Partial<TModule>>,
): Promise<TModule> {
  const actual = await importActual<TModule>()
  return { ...actual, ...(await overrides(actual)) }
}
