/**
 * ISS-20260708-001：Settings 持久化端口抽象（依赖倒置）。
 *
 * 约束：`src/lib` 热路径只依赖本文件的抽象/类型，不得静态导入
 * `@/lib/project-store`（Settings 持久化具体实现）与
 * `@/lib/settings-model-list`（模型列表具体实现）。
 * 具体实现由组合根（`composition-root.ts`）或调用方经 `deps` 注入；
 * 缺省回退经动态 `import()` 懒加载，保持向后兼容且不把 Settings
 * 实现拉入 lib 启动热路径的静态依赖图。
 *
 * MIT License — independently implemented.
 */
import type { LlmConfig, ScheduledImportConfig } from "@/stores/wiki-store"
import type { LlmModelListResult } from "@/lib/settings-model-list"

/** 定时导入配置持久化端口（`project-store` 的抽象）。 */
export interface ScheduledImportConfigPort {
  loadScheduledImportConfig(projectPath: string): Promise<ScheduledImportConfig | null>
  saveScheduledImportConfig(projectPath: string, config: ScheduledImportConfig): Promise<void>
}

/** LLM 模型列表拉取端口（`settings-model-list` 的抽象）。 */
export interface LlmModelListPort {
  fetchLlmModelList(config: LlmConfig): Promise<LlmModelListResult>
}

/** 懒加载缺省端口：仅在未注入时动态导入具体实现（非静态依赖）。 */
export async function loadDefaultScheduledImportConfigPort(): Promise<ScheduledImportConfigPort> {
  const mod = await import("@/lib/project-store")
  return {
    loadScheduledImportConfig: mod.loadScheduledImportConfig,
    saveScheduledImportConfig: mod.saveScheduledImportConfig,
  }
}

/** 懒加载缺省模型列表端口。 */
export async function loadDefaultLlmModelListPort(): Promise<LlmModelListPort> {
  const mod = await import("@/lib/settings-model-list")
  return { fetchLlmModelList: mod.fetchLlmModelList }
}
