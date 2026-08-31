// ts-resolve-hook.mjs — Node 24 原生 TS type-stripping 的扩展名补全 hook
// 生产 TS 源码使用 extensionless imports；Node ESM 默认需要显式扩展名。
// 本 hook 在解析失败时尝试补全 .ts / .tsx / /index.ts。
import { existsSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

export async function resolve(specifier, context, nextResolve) {
  // 先走默认解析
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw err
    const base = fileURLToPath(new URL(specifier, context.parentURL))
    const candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
    for (const c of candidates) {
      if (existsSync(c)) {
        return nextResolve(pathToFileURL(c).href, { ...context, parentURL: context.parentURL })
      }
    }
    throw err
  }
}
