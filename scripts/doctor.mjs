#!/usr/bin/env node
/**
 * doctor.mjs — QMAI / Niko Buddy 项目健康体检 CLI 工具
 *
 * 对应 QMAI/src/lib/novel/doctor.ts 契约，提供无头 CLI 诊断：
 * 1. 动态扫描 src-tauri/src 中的 #[tauri::command] 声明并与 src-tauri/src/lib.rs 的 generate_handler![...] 注册 1:1 比对
 * 2. 检查父目录 .workflow/ 下的临时文件残留与工地板房卫生（无 .workflow 时 INFO 跳过）
 * 3. 检查父目录 .workflow/ledgers/ 分片账本健康度（无 .workflow 时 INFO 跳过）
 * 4. 检查全局 TypeScript 编译状态 (npm run typecheck)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const qmaiRoot = resolve(__dirname, '..');
const hubRoot = resolve(qmaiRoot, '..');

function walkRsFiles(dir, list = []) {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      walkRsFiles(full, list);
    } else if (entry.endsWith('.rs')) {
      list.push(full);
    }
  }
  return list;
}

function scanRustCommands(rustSrcDir) {
  const declared = new Set();
  let commentRefs = 0;
  for (const file of walkRsFiles(rustSrcDir)) {
    const code = readFileSync(file, 'utf8');
    for (const line of code.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (
        trimmed.includes('#[tauri::command') &&
        (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*'))
      ) {
        commentRefs++;
      }
    }
    for (const attr of code.matchAll(/^[ \t]*#\[tauri::command[^\]]*\]/gm)) {
      const rest = code.slice(attr.index + attr[0].length);
      const fnMatch = rest.match(
        /^((?:\s*(?:\/\/[^\n]*|\/\/![^\n]*|#\[[^\]]*\])\r?\n|\s)*)\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
      );
      if (fnMatch) {
        declared.add(fnMatch[2]);
      }
    }
  }
  return { declared, commentRefs };
}

function parseGenerateHandler(libRsPath) {
  const lib = readFileSync(libRsPath, 'utf8');
  const block = lib.match(/generate_handler!\s*\[([\s\S]*?)\]/);
  if (!block) return null;
  return block[1]
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split('::').pop().trim());
}

console.log('======================================================');
console.log('   QMAI / Niko Buddy 项目健康体检 (Doctor CLI)');
console.log('======================================================\n');

let findings = [];

// 1. 动态扫描 Rust #[tauri::command] 并与 lib.rs generate_handler![...] 比对
console.log('[体检项 1/4] 扫描后端 Rust Tauri 命令声明与 lib.rs 注册一致性...');
try {
  const rustSrcDir = resolve(qmaiRoot, 'src-tauri', 'src');
  const libRsPath = resolve(rustSrcDir, 'lib.rs');
  const { declared, commentRefs } = scanRustCommands(rustSrcDir);
  const registered = parseGenerateHandler(libRsPath);
  console.log(
    `  -> 源码实测声明 #[tauri::command]: ${declared.size} 个真实命令函数 (另有 ${commentRefs} 处注释引用，非命令)`,
  );
  if (registered === null) {
    findings.push({ severity: 'error', message: 'src-tauri/src/lib.rs 未找到 generate_handler![...] 注册清单' });
  } else {
    const registeredSet = new Set(registered);
    const unregistered = [...declared].filter((name) => !registeredSet.has(name));
    const undeclared = [...registeredSet].filter((name) => !declared.has(name));
    if (unregistered.length === 0 && undeclared.length === 0) {
      console.log(`  [OK] Tauri 真实命令声明 (${declared.size}) 与 lib.rs generate_handler! (${registered.length}) 严格 1:1 对齐`);
    } else {
      if (unregistered.length > 0) {
        findings.push({
          severity: 'error',
          message: `已声明 #[tauri::command] 但未在 lib.rs 注册 (${unregistered.length}): ${unregistered.join(', ')}`,
        });
      }
      if (undeclared.length > 0) {
        findings.push({
          severity: 'error',
          message: `已在 lib.rs 注册但未找到 #[tauri::command] 声明 (${undeclared.length}): ${undeclared.join(', ')}`,
        });
      }
    }
  }
} catch (e) {
  findings.push({ severity: 'error', message: 'Tauri 命令扫描失败: ' + e.message });
}

// 2. 检查工地板房卫生 (tmp-* 临时文件)
console.log('\n[体检项 2/4] 检查 .workflow 临时文件残留...');
const workflowDir = resolve(hubRoot, '.workflow');
if (!existsSync(workflowDir)) {
  console.log('  [INFO] 未检测到父目录 .workflow，跳过工地临时文件检查');
} else {
  const allWorkflowFiles = readdirSync(workflowDir);
  const tmpFiles = allWorkflowFiles.filter(f => f.startsWith('tmp-') && (f.endsWith('.json') || f.endsWith('.err') || f.endsWith('.txt')));
  if (tmpFiles.length > 0) {
    findings.push({ severity: 'warn', message: `存在 ${tmpFiles.length} 个未清理的临时调试文件 (tmp-*)` });
    console.warn(`  [WARN] 发现 ${tmpFiles.length} 个未清理临时文件，建议运行 clean-vector-hygiene.mjs 清理`);
  } else {
    console.log('  [OK] 无临时残留文件 (0 垃圾)');
  }
}

// 3. 检查分片账本状态
console.log('\n[体检项 3/4] 检查分片账本 (Sharded Ledgers)...');
const indexJsonPath = resolve(hubRoot, '.workflow', 'ledgers', 'index.json');
if (!existsSync(workflowDir)) {
  console.log('  [INFO] 未检测到父目录 .workflow，跳过分片账本检查');
} else if (existsSync(indexJsonPath)) {
  const indexData = JSON.parse(readFileSync(indexJsonPath, 'utf8'));
  console.log(`  -> 分片总任务: ${indexData.overall.totalTasks}，已完成: ${indexData.overall.completedTasks}`);
  console.log('  [OK] 分片账本索引结构完好');
} else {
  findings.push({ severity: 'error', message: '分片账本 index.json 不存在' });
}

// 4. 类型检查体检
console.log('\n[体检项 4/4] 快速类型检查 (npm run typecheck)...');
try {
  execSync('npm run typecheck', { cwd: qmaiRoot, stdio: 'pipe' });
  console.log('  [OK] TypeScript 0 错误');
} catch (e) {
  findings.push({ severity: 'error', message: 'TypeScript 类型检查报错' });
}

console.log('\n======================================================');
console.log('   Doctor 体检报告汇总');
console.log('======================================================');
if (findings.length === 0) {
  console.log('[PASS] 恭喜！系统全部体检项健康，无任何告警！');
} else {
  findings.forEach(f => {
    console.log(`[${f.severity.toUpperCase()}] ${f.message}`);
  });
}
console.log('======================================================');
if (findings.some((f) => f.severity === 'error')) {
  process.exitCode = 1;
}
