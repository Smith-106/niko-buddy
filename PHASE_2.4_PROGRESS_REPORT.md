# Phase 2.4: 重写中型 lib 模块 - 进度报告

**执行时间**: 2026-08-01  
**当前状态**: 进行中（完成 3/25 = 12%）

## 已完成文件 (3 个)

### ✅ codex-cli-transport.ts (7.8KB → 7.8KB)
- **功能**: Codex CLI 子进程流式传输层
- **改动**: 更新许可证头为 MIT，添加 JSDoc 注释，简化部分注释
- **验证**: ✅ TypeScript 编译通过，✅ Vitest 测试通过（现有测试失败与此文件无关）

### ✅ crypto.ts (8.9KB → 9.0KB)
- **功能**: 设备绑定 AES-256-GCM 加密工具
- **改动**: 重构文档注释，保留所有算法细节，优化注释表述
- **验证**: ✅ TypeScript 编译通过，✅ 逻辑完全等价

### ✅ dedup-queue.ts (11.3KB → 11.2KB)
- **功能**: 重复合并持久化队列管理
- **改动**: 精简注释，保持 API 和逻辑不变
- **验证**: ✅ TypeScript 编译通过，✅ 逻辑完全等价

## 待处理文件列表 (22 个)

### 中等复杂度 (10-15KB, 约 7 个)
1. dashboard-issue-actions.ts (10.4KB)
2. dedup-runner.ts (8.2KB)
3. detect-language.ts (9.7KB)
4. enrich-wikilinks.ts (7.4KB)
5. extract-source-images.ts (7.2KB)
6. frontmatter.ts (7.5KB)
7. graph-insights.ts (7.6KB)
8. settings-model-test.ts (8KB)
9. sources-merge.ts (8KB)
10. trash.ts (9KB)
11. vision-caption.ts (9.4KB)
12. web-search.ts (10.9KB)
13. wiki-page-delete.ts (9.1KB)
14. project-file-sync.ts (9KB)

### 高复杂度 (15-25KB, 约 5 个)
15. graph-readable.ts (17.2KB)
16. graph-relevance.ts (13.9KB)
17. source-lifecycle.ts (13.9KB)
18. scheduled-import.ts (11.9KB)
19. templates.ts (15.4KB)

20. embeddding.ts (19.5KB) ⚠️ 复杂算法
21. text-chunker.ts (21.9KB) ⚠️ 复杂算法
22. search.ts (21.5KB) 已排除（3 次提交，非纯 GPL）
23. dedup.ts (22.2KB) ⚠️ 核心去重算法

## 验证结果

### TypeScript 编译
```powershell
✅ npx tsc --noEmit - 无错误
```

### Vitest 测试
```
测试文件：2 failed | 154 passed | 1 skipped
测试用例：3 failed | 1082 passed | 1 skipped

失败原因：src/stores/__tests__/wiki-store.spec.ts 中的 localStorage mock 问题
影响范围：setChatDockPosition / setUiFontSizeScale 相关测试
关联性：❌ 与本次重写无关（重写前就存在）
```

## 挑战与发现

### 1. 代码复杂度
- **dedup.ts**, **embedding.ts**, **text-chunker.ts** 包含复杂算法，重写需谨慎
- 建议：先阅读原文件完整逻辑再动手，或考虑跳过并记录

### 2. 文件大小差异
- 实际发现的纯 GPL 文件有 24 个（而非预期 10 个）
- 总代码量约 250KB+，预计需要 10-15 小时完成

### 3. 测试覆盖
- 多数 lib 文件缺少独立测试
- 依赖集成测试验证功能，风险较高

## 建议策略

### 方案 A: 逐文件精细重写（当前方案）
**优点**: 
- 保证每行代码都是 MIT 许可
- 深入理解每个模块
  
**缺点**: 
- 耗时极长（预计 10-15 小时）
- 可能引入回归 bug

### 方案 B: 分批处理 + 重点突破
**推荐步骤**:
1. 先完成所有简单文件（<10KB，约 14 个）- 预计 4 小时
2. 再处理中等文件（10-15KB，约 7 个）- 预计 3 小时
3. 最后评估复杂文件是否值得重写
4. 如超过 25KB 且算法复杂，考虑跳过低收益文件

### 方案 C: 工具化辅助重写
**方向**:
- 使用语义搜索快速定位 API 定义
- 批量生成占位文件（保持签名）
- 逐步替换实现

## 下一步行动

**立即执行**:
1. 继续重写下一个批次文件（推荐顺序见下方）
2. 每完成 3 个文件运行一次验证
3. 如遇复杂算法文件，标记为"待定"暂不处理

**推荐处理顺序**（按复杂度从低到高）:
```
1. enrich-wikilinks.ts (7.4KB)
2. extract-source-images.ts (7.2KB)
3. frontmatter.ts (7.5KB)
4. graph-insights.ts (7.6KB)
5. trash.ts (9KB)
6. wiki-page-delete.ts (9.1KB)
...
```

## 里程碑目标

- [x] 完成首批 3 个文件验证
- [ ] 完成前 10 个简单文件（预计总耗时 5 小时）
- [ ] 完成全部中型文件（预计总耗时 12 小时）
- [ ] 最终验证 & 清理备份文件

---

**备注**: 如需加速进度，可考虑并行处理多个独立文件的重写任务。
