# T33 — model-resolver/provider 注册表 + 角色化绑定 + ModelPort

> **date**: 2026-08-28
> **task_id**: TASK-P6-33
> **decision_type**: 技术债条目 / 裁决人

## 一、决策摘要

实现 provider-registry（add-only 注册表，与现有 switch 并存）、model-resolver（五角色绑定 + fallback 链 + NovelError 三分类）、model-port（execute/stream 薄封装）。只建层不改主链行为。

## 二、设计决策

### 2.1 ProviderRegistry: 类实例而非模块级 Map

- **决策**: 使用 `ProviderRegistry` 类，测试可创建独立实例，避免全局状态污染
- **理由**: 测试需要隔离状态；`defaultRegistry` 同时提供全局单例
- **备选否决**: 模块级 `Map` + `registerProvider()` 函数（测试无法隔离，`vi.resetModules` 成本高）

### 2.2 resolveRoleModel: 字符降级链而非 fallback 到默认模型

- **决策**: `resolveRoleModel(role, config)` 优先级：角色专属字段 → writingModel → 空字符串
- **理由**: 保持纯函数属性；调用方自行决定默认值处理
- **备选否决**: 硬编码默认模型名（破坏纯函数，违反向后兼容）

### 2.3 NovelError 三分类: 继承 Error 的子类链

- **决策**: `RetryableError` / `ContentError` / `FatalError` 继承自 `NovelError`，`kind` 属性为 "retryable" | "content" | "fatal"
- **理由**: `instanceof` 链完整；`classifyError()` 可统一分类任意错误
- **备选否决**: 单一 `NovelError` + `kind` 字段（失去 `instanceof` 区分能力）

### 2.4 ModelPort: 薄封装而非重写

- **决策**: `ModelPort.execute()` 和 `stream()` 直接调用 `streamChat`，不改变传输行为
- **理由**: 任务要求"只建层不改主链行为"；后续接线在 deep-chapter-generation.ts 中完成
- **备选否决**: 重写 `streamChat` 逻辑（破坏现有行为，不必要）

### 2.5 Fallback 链: 纯函数不持有状态

- **决策**: `resolveFallbackChain(attemptIndex, chain)` 纯函数，调用方维护 `attemptIndex`
- **理由**: 保持可测试性；调用方（编排层）管理重试循环
- **备选否决**: 有状态 `FallbackChain` 类（引入可变状态，测试复杂）

## 三、文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/lib/llm/provider-registry.ts` | 新 | ProviderRegistry 类 + defaultRegistry 单例 |
| `src/lib/llm/model-resolver.ts` | 新 | 五角色绑定 + TaskTier + fallback + NovelError |
| `src/lib/llm/model-port.ts` | 新 | ModelPort execute/stream + defaultModelPort |
| `src/lib/llm/provider-registry.spec.ts` | 新 | 46 测试，覆盖 registry/resolve/error/fallback/port |

## 四、验证结果

```
npx vitest run provider-registry → 46 passed (582ms)
npx tsc --noEmit              → 0 errors in llm/ files
```

## 五、债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20260828-t33-01 | provider-registry 尚未收编 llm-providers.ts 的 switch 分支（现有 `getProviderConfig` 仍为 fallback）。收编后需移除 `legacyGetProviderConfig` 调用，使 `ProviderRegistry` 成为唯一路由。 | 全部 7+ provider 分支已注册到 registry | T33 后续迭代或 P7 |
| DEBT-20260828-t33-02 | ModelPort 尚未接入 deep-chapter-generation.ts 等现有调用点。接线归后续任务，但期间 ModelPort 与 streamChat 并存，增加维护成本。 | 首个调用点迁移完成 | P7 接线任务 |
| DEBT-20260828-t33-03 | `resolveRoleModel` 的 critic/reviser/arbiter/judge 默认绑定 writingModel 或 reviewModel，未提供独立覆盖字段。独立角色模型选择需在 NovelConfig 中新增字段。 | 用户需求指定角色独立模型时 | P7 增强 |