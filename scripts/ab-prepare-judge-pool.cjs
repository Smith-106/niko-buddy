/**
 * T36 盲评协调器 — 为每位评审生成独立的评审材料 JSON
 * 
 * 每个评审收到：
 *   1. judge-{N}-pool.json — 40 条随机化文本（每条含 id, text, 六维评分槽）
 *   2. judge-{N}-pairs.json — 20 个配对二元偏好槽
 * 
 * 评审填写后保存为：
 *   docs/p6/ab-evidence/judges/judge-{N}-scores.json
 *   docs/p6/ab-evidence/judges/judge-{N}-preferences.json
 */

const fs = require('fs')
const path = require('path')

const EVIDENCE_DIR = path.join(__dirname, '..', 'docs', 'p6', 'ab-evidence')

const pool = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, 'evidence-pool.json'), 'utf-8'))
const pairs = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, 'pair-index.json'), 'utf-8'))

const SIX_DIMS = ['thrill', 'arc_consistency', 'hook_strength', 'salient_detail', 'rhythm', 'immersion']
const DIM_LABELS = {
  thrill: '爽点闭环（情节推进是否爽快、冲突解决是否令人满足）',
  arc_consistency: '弧光一致（人物动机与行为是否一致、弧光推进是否合理）',
  hook_strength: '钩子强度（章末悬念是否有力、是否驱动阅读欲望）',
  salient_detail: '显著细节（描写是否具体、有画面感、避免泛化）',
  rhythm: '节奏张弛（叙事节奏是否张弛有度、快慢交替合理）',
  immersion: '文笔沉浸（语言是否流畅优美、能否让读者沉浸其中）'
}

// 为两个评审生成材料（独立随机化顺序，确保 J1 和 J2 看到的顺序不同）
for (let judgeIdx = 1; judgeIdx <= 2; judgeIdx++) {
  // 对文本顺序做独立洗牌（基于固定 seed 但 judge 不同偏移）
  const shuffled = [...pool.items]
  // 使用确定性但 judge 间不同的顺序
  const seed = judgeIdx * 137
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = (seed + i * 31) % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  // 评审用评分槽
  const scoreSlots = shuffled.map((item, idx) => ({
    index: idx + 1,
    id: item.id,
    text: item.text.slice(0, 3000), // 截断以防过长
    // 空评分槽（评审填写）
    scores: {
      thrill: null,
      arc_consistency: null,
      hook_strength: null,
      salient_detail: null,
      rhythm: null,
      immersion: null,
      overall: null
    }
  }))

  // 配对偏好槽（shuffle 配对顺序，但不暴露臂标签）
  const pairSlots = pairs.pairs.map((p, idx) => ({
    index: idx + 1,
    textA_id: p.labelA,
    textB_id: p.labelB,
    // 评审填写：'A' 或 'B' 或 'tie'
    preference: null
  }))

  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'judges', `judge-${judgeIdx}-pool.json`),
    JSON.stringify({
      meta: {
        judgeId: `J${judgeIdx}`,
        totalItems: scoreSlots.length,
        sixDimensions: SIX_DIMS,
        dimLabels: DIM_LABELS,
        instruction: '请对每份文本按六维评分 0-10（整数），并给出 overall 分。0=极差，10=完美。先整体阅读文本，再逐维评分。'
      },
      items: scoreSlots
    }, null, 2),
    'utf-8'
  )

  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'judges', `judge-${judgeIdx}-pairs.json`),
    JSON.stringify({
      meta: {
        judgeId: `J${judgeIdx}`,
        totalPairs: pairSlots.length,
        instruction: '请对每个配对，比较 textA 和 textB 的质量，选择你更偏好哪一份。如果质量相当，选 tie。'
      },
      pairs: pairSlots
    }, null, 2),
    'utf-8'
  )

  console.log(`Judge ${judgeIdx}: ${scoreSlots.length} 评分项 + ${pairSlots.length} 配对项已生成`)
}

console.log('盲评材料准备完成！')