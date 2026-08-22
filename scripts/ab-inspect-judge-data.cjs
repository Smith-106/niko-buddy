#!/usr/bin/env node
// ab-inspect-judge-data.cjs — 检查评审数据质量
const fs = require('fs')

const secret = JSON.parse(fs.readFileSync('docs/p6/ab-evidence/secret-mapping.json','utf-8'))
const j1 = JSON.parse(fs.readFileSync('docs/p6/ab-evidence/judges/judge-1-scores.json','utf-8'))
const j2 = JSON.parse(fs.readFileSync('docs/p6/ab-evidence/judges/judge-2-scores.json','utf-8'))
const j1p = JSON.parse(fs.readFileSync('docs/p6/ab-evidence/judges/judge-1-preferences.json','utf-8'))
const j2p = JSON.parse(fs.readFileSync('docs/p6/ab-evidence/judges/judge-2-preferences.json','utf-8'))

const secretItems = secret.items || secret
const j1Scores = j1.scores || j1
const j2Scores = j2.scores || j2
const j1Prefs = j1p.preferences || j1p
const j2Prefs = j2p.preferences || j2p

// 验证 ID 完整性
const j1Ids = new Set(j1Scores.map(s => s.id))
const j2Ids = new Set(j2Scores.map(s => s.id))
const secretIds = new Set(secretItems.map(s => s.id))

console.log('Secret IDs:', secretIds.size)
console.log('J1 scored IDs:', j1Ids.size, 'missing:', [...secretIds].filter(id => !j1Ids.has(id)).join(',') || 'none')
console.log('J2 scored IDs:', j2Ids.size, 'missing:', [...secretIds].filter(id => !j2Ids.has(id)).join(',') || 'none')

// 验证偏好 ID 完整性
const prefPairs = j1Prefs.map(p => `${p.textA_id}:${p.textB_id}`)
console.log('J1 preference pairs:', prefPairs.length)
const prefPairs2 = j2Prefs.map(p => `${p.textA_id}:${p.textB_id}`)
console.log('J2 preference pairs:', prefPairs2.length)

// 构建 ID→臂 映射
const idToArm = {}
for (const item of secretItems) {
  idToArm[item.id] = item.arm
}

// 检查 J1 偏好分布
console.log('\n=== J1 偏好分布 ===')
const j1PrefCount = { A: 0, B: 0, tie: 0 }
for (const p of j1Prefs) {
  j1PrefCount[p.preference] = (j1PrefCount[p.preference] || 0) + 1
  // 验证：A 是否对应基线
  const aArm = idToArm[p.textA_id]
  const bArm = idToArm[p.textB_id]
  if (p.preference === 'A' && aArm !== 'baseline') console.log(`WARN: J1 pref A but textA=${p.textA_id} is ${aArm}`)
  if (p.preference === 'B' && bArm !== 'premium') console.log(`WARN: J1 pref B but textB=${p.textB_id} is ${bArm}`)
}
console.log('A(baseline):', j1PrefCount.A, 'B(premium):', j1PrefCount.B, 'tie:', j1PrefCount.tie)

console.log('\n=== J2 偏好分布 ===')
const j2PrefCount = { A: 0, B: 0, tie: 0 }
for (const p of j2Prefs) {
  j2PrefCount[p.preference] = (j2PrefCount[p.preference] || 0) + 1
  const aArm = idToArm[p.textA_id]
  const bArm = idToArm[p.textB_id]
  if (p.preference === 'A' && aArm !== 'baseline') console.log(`WARN: J2 pref A but textA=${p.textA_id} is ${aArm}`)
  if (p.preference === 'B' && bArm !== 'premium') console.log(`WARN: J2 pref B but textB=${p.textB_id} is ${bArm}`)
}
console.log('A(baseline):', j2PrefCount.A, 'B(premium):', j2PrefCount.B, 'tie:', j2PrefCount.tie)

// 检查配对标签是否正确
console.log('\n=== 配对标签验证 ===')
const pairIndex = JSON.parse(fs.readFileSync('docs/p6/ab-evidence/pair-index.json','utf-8'))
const pairs = pairIndex.pairs || pairIndex
for (const p of pairs) {
  const aArm = idToArm[p.labelA]
  const bArm = idToArm[p.labelB]
  if (aArm !== 'baseline' || bArm !== 'premium') {
    console.log(`WARN: pair ${p.bookId}-ch${p.chapterIndex}: labelA=${p.labelA} is ${aArm}, labelB=${p.labelB} is ${bArm}`)
  }
}
console.log('Pair label verification: done')

// 评分分布
console.log('\n=== J1 overall 分布 ===')
const j1Ov = j1Scores.map(s => s.scores.overall).sort((a,b)=>a-b)
console.log('Min:', j1Ov[0], 'Max:', j1Ov[j1Ov.length-1], 'Median:', j1Ov[Math.floor(j1Ov.length/2)])
console.log('Values:', j1Ov.join(','))

console.log('\n=== J2 overall 分布 ===')
const j2Ov = j2Scores.map(s => s.scores.overall).sort((a,b)=>a-b)
console.log('Min:', j2Ov[0], 'Max:', j2Ov[j2Ov.length-1], 'Median:', j2Ov[Math.floor(j2Ov.length/2)])
console.log('Values:', j2Ov.join(','))