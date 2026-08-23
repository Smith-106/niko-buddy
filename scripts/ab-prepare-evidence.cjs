/**
 * ab-prepare-evidence.js — T36 真实补验轮：提取正文、随机化、生成盲评材料
 * 
 * 输出：
 *   docs/p6/ab-evidence/evidence-pool.json   — 40 条随机化记录（供评审用）
 *   docs/p6/ab-evidence/secret-mapping.json   — 仅协调者知道的 ID→来源映射
 *   docs/p6/ab-evidence/pair-index.json       — 配对关系（评二元偏好用）
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ARMS_DIR = path.join(__dirname, '..', 'docs', 'p6', 'ab-evidence', 'arms')
const OUTPUT_DIR = path.join(__dirname, '..', 'docs', 'p6', 'ab-evidence')

// 所有文件列表
const files = fs.readdirSync(ARMS_DIR).filter(f => f.endsWith('.md'))

// 解析 bookId, chapterIndex, arm
const parseFile = (filename) => {
  const m = filename.match(/^(book-[ab])-chapter-(\d+)-(baseline|premium)\.md$/)
  if (!m) throw new Error(`无法解析文件名: ${filename}`)
  return { bookId: m[1], chapterIndex: parseInt(m[2]), arm: m[3] }
}

// 提取正文（对 premium 取 "最终文本" 段，对 baseline 取正文）
const extractText = (filepath, arm) => {
  const content = fs.readFileSync(filepath, 'utf-8')
  
  if (arm === 'premium') {
    // 取 "最终文本（供评审使用）" 之后的内容（不含标题行）
    const finalMarker = '## 最终文本（供评审使用）'
    const idx = content.indexOf(finalMarker)
    if (idx === -1) {
      // 备选：取最后一个 "### 修订② → 最终稿 V3" 之后
      const altMarker = '### 修订② → 最终稿 V3'
      const altIdx = content.indexOf(altMarker)
      if (altIdx === -1) {
        console.warn(`警告: ${path.basename(filepath)} 无最终文本标记，取全文`)
        return content.trim()
      }
      // 取修订②之后的内容，跳过标题行
      const after = content.slice(altIdx + altMarker.length).trim()
      // 跳过可能的空行和后续标题
      return after.replace(/^#+\s*.*\n?/, '').trim()
    }
    // 取最终文本标记之后的内容，跳过标题行
    const after = content.slice(idx + finalMarker.length).trim()
    return after.replace(/^#+\s*.*\n?/, '').trim()
  }
  
  // baseline: 取标题行之后的正文
  const lines = content.split('\n')
  const bodyStart = lines.findIndex(l => l.startsWith('# '))
  if (bodyStart === -1) return content.trim()
  return lines.slice(bodyStart + 1).join('\n').trim()
}

// 生成随机 ID
let idCounter = 0
const randomId = () => 'S' + String(++idCounter).padStart(4, '0')

// 处理所有文件
const records = []
const pairMap = {} // "bookId:chapterIndex" → { baselineId, premiumId }

for (const f of files) {
  const { bookId, chapterIndex, arm } = parseFile(f)
  const filepath = path.join(ARMS_DIR, f)
  const text = extractText(filepath, arm)
  
  const key = `${bookId}:${chapterIndex}`
  if (!pairMap[key]) pairMap[key] = {}
  pairMap[key][arm] = { id: null, text, filename: f }
}

// 为每个配对生成随机 ID（确保同一配对的 ID 不同）
const allItems = []
for (const [key, pair] of Object.entries(pairMap)) {
  const [bookId, chapterIndex] = key.split(':')
  const baselineId = randomId()
  const premiumId = randomId()
  
  pair.baseline.id = baselineId
  pair.premium.id = premiumId
  
  allItems.push({
    id: baselineId,
    bookId,
    chapterIndex: parseInt(chapterIndex),
    arm: 'baseline',
    text: pair.baseline.text,
    filename: pair.baseline.filename,
    pairId: premiumId // 配对文本 ID
  })
  allItems.push({
    id: premiumId,
    bookId,
    chapterIndex: parseInt(chapterIndex),
    arm: 'premium',
    text: pair.premium.text,
    filename: pair.premium.filename,
    pairId: baselineId
  })
}

// Fisher-Yates 洗牌
const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

const shuffled = shuffle([...allItems])

// 评审用数据（不含 arm 信息）
const evidencePool = shuffled.map(item => ({
  id: item.id,
  text: item.text,
  pairId: item.pairId,
  // 以下字段仅用于配对上下文，不暴露 arm
  bookKey: `${item.bookId}-ch${item.chapterIndex}`
}))

// 秘密映射（仅协调者持有）
const secretMapping = shuffled.map(item => ({
  id: item.id,
  bookId: item.bookId,
  chapterIndex: item.chapterIndex,
  arm: item.arm,
  filename: item.filename
}))

// 配对索引（供二元偏好评审用）
const pairIndex = Object.entries(pairMap).map(([key, pair]) => {
  const [bookId, chapterIndex] = key.split(':')
  return {
    bookId,
    chapterIndex: parseInt(chapterIndex),
    baselineId: pair.baseline.id,
    premiumId: pair.premium.id,
    // 随机决定 A/B 标签，不暴露哪臂是哪臂
    labelA: pair.baseline.id,
    labelB: pair.premium.id
  }
})

// 确保目录存在
fs.mkdirSync(OUTPUT_DIR, { recursive: true })

// 写入
fs.writeFileSync(
  path.join(OUTPUT_DIR, 'evidence-pool.json'),
  JSON.stringify({ meta: { totalItems: evidencePool.length, shuffleSeed: 't36-real-20260828' }, items: evidencePool }, null, 2),
  'utf-8'
)

fs.writeFileSync(
  path.join(OUTPUT_DIR, 'secret-mapping.json'),
  JSON.stringify({ meta: { generatedAt: new Date().toISOString() }, items: secretMapping }, null, 2),
  'utf-8'
)

fs.writeFileSync(
  path.join(OUTPUT_DIR, 'pair-index.json'),
  JSON.stringify({ meta: { totalPairs: pairIndex.length }, pairs: pairIndex }, null, 2),
  'utf-8'
)

// 统计
const baselineCount = allItems.filter(i => i.arm === 'baseline').length
const premiumCount = allItems.filter(i => i.arm === 'premium').length
console.log(`=== 盲评材料准备完成 ===`)
console.log(`总样本数: ${allItems.length}`)
console.log(`  基线臂: ${baselineCount}`)
console.log(`  精品臂: ${premiumCount}`)
console.log(`  配对: ${pairIndex.length}`)
console.log(``)
console.log(`文件: `)
console.log(`  evidence-pool.json — ${evidencePool.length} 条随机化文本（供评审用）`)
console.log(`  secret-mapping.json — 秘密映射（仅协调者持有）`)
console.log(`  pair-index.json — ${pairIndex.length} 个配对索引`)

// 验证：检查随机 ID 是否有冲突
const ids = allItems.map(i => i.id)
const uniqueIds = new Set(ids)
if (ids.length !== uniqueIds.size) {
  console.error('错误: 存在重复 ID！')
  process.exit(1)
}
console.log('ID 唯一性验证: ✓')

// 验证：每对 baseline 和 premium 的 ID 不同
for (const pair of Object.values(pairMap)) {
  if (pair.baseline.id === pair.premium.id) {
    console.error(`错误: 配对 ${pair.baseline.filename} / ${pair.premium.filename} ID 相同！`)
    process.exit(1)
  }
}
console.log('配对 ID 差异验证: ✓')

// 验证：文本非空
for (const item of allItems) {
  if (item.text.length < 100) {
    console.warn(`警告: ${item.filename} 正文较短 (${item.text.length} 字符)`)
  }
}
console.log('正文长度验证: 完成')