#!/usr/bin/env node
/**
 * clean-vector-hygiene.mjs — 向量资产审计与临时垃圾安全清理工具
 * 
 * 安全纪律（对齐用户硬核核验反思）：
 * 1. 向量去重审计为【严格只读】：绝对禁止单边修改 embedding.zvec.meta.json，
 *    防止元数据 contentHashes 与底层二进制 embedding-index.bin 发生指针脱钩造成炸库！
 * 2. 临时文件清理 (--fix)：仅清理 .workflow/ 下的瞬态垃圾 (tmp-*.json/err)，
 *    且必须执行前置备份归档到 .workflow/backups/，杜绝硬删！
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const hubRoot = resolve(__dirname, '..', '..');
const workflowDir = resolve(hubRoot, '.workflow');
const backupsDir = resolve(workflowDir, 'backups');

const isFix = process.argv.includes('--fix');

console.log('======================================================');
console.log(`   向量资产与工作区卫生审计 (${isFix ? '临时垃圾安全清理 --fix' : '只读审计模式 --check'})`);
console.log('======================================================\n');

// 1. 临时垃圾文件检查与安全归档清理
const allFiles = readdirSync(workflowDir);
const tmpFiles = allFiles.filter(f => f.startsWith('tmp-') && (f.endsWith('.json') || f.endsWith('.err') || f.endsWith('.txt')));

console.log(`[步骤 1/2] 瞬态临时文件扫描: 发现 ${tmpFiles.length} 个遗留临时垃圾文件`);
if (tmpFiles.length > 0) {
  if (isFix) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveTarget = resolve(backupsDir, `tmp-archive-${timestamp}`);
    if (!existsSync(archiveTarget)) {
      mkdirSync(archiveTarget, { recursive: true });
    }
    tmpFiles.forEach(f => {
      const src = resolve(workflowDir, f);
      const dst = resolve(archiveTarget, f);
      copyFileSync(src, dst);
      unlinkSync(src);
    });
    console.log(`  [OK] 已安全备份并清理 ${tmpFiles.length} 个临时文件！归档路径: ${archiveTarget}`);
  } else {
    console.warn(`  [WARN] 存在 ${tmpFiles.length} 个未清理文件 (示例: ${tmpFiles.slice(0, 5).join(', ')}...)`);
    console.log('    运行 node scripts/clean-vector-hygiene.mjs --fix 可安全归档并清扫。');
  }
} else {
  console.log('  [OK] 临时文件极为整洁 (0 垃圾)');
}

// 2. 向量库元数据重复 hash 审计 (只读断言，绝对禁止单边写 meta)
console.log('\n[步骤 2/2] 向量元数据 contentHashes 重复率只读审计...');
const zvecMetaPath = resolve(workflowDir, 'embedding.zvec.meta.json');
if (!existsSync(zvecMetaPath)) {
  console.log('  - 未发现 embedding.zvec.meta.json，跳过');
} else {
  const meta = JSON.parse(readFileSync(zvecMetaPath, 'utf8'));
  const totalHashes = meta.contentHashes ? meta.contentHashes.length : 0;
  const uniqueHashes = new Set(meta.contentHashes || []);
  const duplicateCount = totalHashes - uniqueHashes.size;

  console.log(`  -> 向量总条目: ${totalHashes}`);
  console.log(`  -> 物理唯一条目: ${uniqueHashes.size}`);
  console.log(`  -> 重复脏 chunk 数量: ${duplicateCount} (重复率: ${totalHashes > 0 ? ((duplicateCount / totalHashes) * 100).toFixed(1) : 0}%)`);

  if (duplicateCount > 0) {
    console.warn(`  [WARN] 存在严重重复堆叠污染！`);
    console.log('  [INFO] [安全保护触发]：向量元数据绝不单边截断（防止与 embedding-index.bin 指针错位炸库）。');
    console.log('     真正去重须在后续通过官方重建管道 (maestro kg / vectorstore sync) 全量重编。');
  } else {
    console.log('  [OK] 向量条目 100% 纯净，无重复脏 chunk！');
  }
}

console.log('\n======================================================');
console.log('   向量与工作区卫生审计完成');
console.log('======================================================');
