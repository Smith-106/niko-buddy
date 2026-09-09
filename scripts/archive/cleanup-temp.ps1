# Niko Buddy 临时文件清理脚本
# 执行时间：2026-08-02

Write-Host "=== QMAI 临时文件清理 ===" -ForegroundColor Cyan

# 1. 删除临时 TypeScript 文件
$tempFiles = @(
    "temp-chapter-ingest-part1.ts",
    "temp-original-frontmatter.ts",
    "temp-original-knowledge-tree.tsx"
)

foreach ($file in $tempFiles) {
    if (Test-Path $file) {
        Remove-Item $file -Force
        Write-Host "[OK] 已删除：$file" -ForegroundColor Green
    }
}

# 2. 删除参考文件（已整合到主代码）
$refFiles = @(
    "chapter-ingest-reference.ts",
    "character-aura-reference.ts",
    "deep-chapter-generation-reference.ts",
    "chapter-ingest-refactored.ts"
)

foreach ($file in $refFiles) {
    if (Test-Path $file) {
        Remove-Item $file -Force
        Write-Host "[OK] 已删除参考文件：$file" -ForegroundColor Green
    }
}

# 3. 删除日志文件
$logFiles = @(
    "build-portable.log",
    "dev-server.log",
    "test-mocks-task8.log",
    "test-mocks.log",
    "typecheck.log",
    "tsc-errors.txt"
)

foreach ($file in $logFiles) {
    if (Test-Path $file) {
        Remove-Item $file -Force
        Write-Host "[OK] 已删除日志：$file" -ForegroundColor Green
    }
}

# 4. 删除备份目录
if (Test-Path "src/lib/__backups__") {
    Remove-Item "src/lib/__backups__" -Recurse -Force
    Write-Host "[OK] 已删除备份目录：src/lib/__backups__" -ForegroundColor Green
}

# 5. 删除测试报告（可选，保留最近的）
$testReports = @(
    "test-mocks-feature-report.json",
    "test-mocks-master-report.json",
    "test-mocks-report.json"
)

foreach ($file in $testReports) {
    if (Test-Path $file) {
        Remove-Item $file -Force
        Write-Host "[OK] 已删除测试报告：$file" -ForegroundColor Green
    }
}

# 6. 删除其他临时文件
$otherTemp = @(
    "diff_chapter.txt",
    "staged-files.txt",
    "验证修复.js",
    "test-api-403.js",
    "test-api.js"
)

foreach ($file in $otherTemp) {
    if (Test-Path $file) {
        Remove-Item $file -Force
        Write-Host "[OK] 已删除：$file" -ForegroundColor Green
    }
}

Write-Host "`n=== 清理完成 ===" -ForegroundColor Cyan
Write-Host "提示：请检查 git status 确认清理结果" -ForegroundColor Yellow
