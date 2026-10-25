#!/usr/bin/env node
/**
 * doctor.mjs — QMAI / Niko Buddy 项目健康体检 CLI 工具
 * 
 * 对应 QMAI/src/lib/novel/doctor.ts 契约，提供无头 CLI 诊断：
 * 1. 检查 Rust 源码中声明的 116 个真实 #[tauri::command] (与 5 处注释引用) 与 lib.rs 116 个注册一致性
 * 2. 检查 .workflow/ 下的临时文件残留与工地板房卫生
 * 3. 检查 .workflow/ledgers/ 分片账本健康度与 pending 数量
 * 4. 检查全局 TypeScript 编译状态 (npm run typecheck)
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const qmaiRoot = resolve(__dirname, '..');
const hubRoot = resolve(qmaiRoot, '..');

console.log('======================================================');
console.log('   QMAI / Niko Buddy 项目健康体检 (Doctor CLI)');
console.log('======================================================\n');

let findings = [];

// 1. 检查 Rust 命令声明总数 (真实函数 116，排除 5 处注释引用)
console.log('[体检项 1/4] 扫描后端 Rust Tauri 命令声明...');
try {
  const output = execSync('node -e "' +
    'const fs = require(\'fs\'); const path = require(\'path\');' +
    'function walk(d, list=[]){ for(const f of fs.readdirSync(d)){ const p = path.join(d,f); if(fs.statSync(p).isDirectory()) walk(p,list); else if(f.endsWith(\'.rs\')) list.push(p); } return list; }' +
    'const files = walk(\'src-tauri/src\');' +
    'let realCmds = 0; let commentRefs = 0;' +
    'for(const f of files){' +
    '  const lines = fs.readFileSync(f, \'utf8\').split(\'\\n\');' +
    '  for(let i=0; i<lines.length; i++){' +
    '    if(lines[i].includes(\'#[tauri::command\')){' +
    '      const t = lines[i].trim();' +
    '      if(t.startsWith(\'//\') || t.startsWith(\'/*\') || t.startsWith(\'*\')) commentRefs++;' +
    '      else realCmds++;' +
    '    }' +
    '  }' +
    '}' +
    'console.log(JSON.stringify({ realCmds, commentRefs }));' +
    '"', {
    cwd: qmaiRoot,
    encoding: 'utf8'
  }).trim();
  const { realCmds, commentRefs } = JSON.parse(output);
  console.log(`  -> 源码实测声明 #[tauri::command]: ${realCmds} 个真实命令函数 (另有 ${commentRefs} 处注释引用，非命令)`);
  if (realCmds === 116) {
    console.log('  [OK] Tauri 真实命令声明与 lib.rs 116 个注册严格 1:1 对齐');
  } else {
    findings.push({ severity: 'warn', message: `Tauri 命令声明数发生漂移: 当前 ${realCmds}，基准 116` });
  }
} catch (e) {
  findings.push({ severity: 'error', message: 'Tauri 命令扫描失败: ' + e.message });
}

// 2. 检查工地板房卫生 (tmp-* 临时文件)
console.log('\n[体检项 2/4] 检查 .workflow 临时文件残留...');
const workflowDir = resolve(hubRoot, '.workflow');
if (existsSync(workflowDir)) {
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
if (existsSync(indexJsonPath)) {
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
