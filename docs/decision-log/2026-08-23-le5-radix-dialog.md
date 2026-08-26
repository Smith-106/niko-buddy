# A-34 决策日志 — LE-5 Radix Dialog 完整迁移

```yaml
date: 2026-08-23
task_id: TASK-LE-5
decision_type: refactor
wave: W1-launch
model: ox-alpha-free（迁移）+ deepseek-v4-flash（回归修复）
verified: tsc 0 错 + vitest 9387 passed / 9390（2 skipped 基线）+ eslint 0 错
```

## 决策

1. **依赖**：`@radix-ui/react-dialog@1.1.19`（新增）。scroll lock 由 react-remove-scroll-bar 注入 `body[data-scroll-locked]`，替代手写 overflow hidden。
2. **迁移模式**：`DialogRoot + DialogOverlay(asChild 包裹自定义 backdrop) + DialogContent(asChild)`——Overlay 必须显式存在，否则 RemoveScroll 不渲染、scroll lock 失效（chapter-selection-panel / search-view Lightbox 首轮遗漏已补）。
3. **关闭语义**：Esc / onOpenChange(false) 走 Radix；自定义 backdrop 补 `onPointerDown` 兜底保证 jsdom 与真实浏览器一致。
4. **a11y**：关闭按钮补 aria-label；aria-modal 由 Radix 接管（aria-hidden 对兄弟节点生效，测试需 `{ hidden: true }` 查询被遮罩元素）。
5. **SSR 安全**：组件体 `document.activeElement` 访问加 `typeof document !== "undefined"` 守卫。

## 回归修复清单（9 个测试）

- chapter-selection-panel：Overlay 缺失致 data-scroll-locked 不出现 → 组件修复 + waitFor 断言。
- snapshot-viewer ×3：DiffModal backdrop pointerDown 兜底 + 关闭按钮 aria-label。
- snapshot-viewer.diff SSR 冒烟：document 守卫。
- search-view lightbox ×3：同 Overlay 模式 + hidden textbox 查询。
- review-view readFile 兜底：未 mock 的 loadEmotionLedger 消费了 mockRejectedValueOnce → 补 emotion-ledger mock。

## 影响范围

- 后续新模态一律走 Radix Dialog 模式；禁止再手写 overlay/overflow 管理。
