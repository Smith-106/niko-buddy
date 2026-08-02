#!/usr/bin/env node
/**
 * check-emotion-density.mjs
 * 
 * 检测文本中的情感状态词密度（Show-Don-Tell 指标）
 * 用于验证 Phase 0-A v2.0 的集成效果
 * 
 * Usage: node scripts/check-emotion-density.mjs <file.md>
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 情感状态词正则模式
const EMOTION_TELL_PATTERNS = [
  /\b(生气 | 愤怒 | 悲伤 | 快乐 | 开心 | 恐惧 | 紧张 | 焦虑 | 兴奋)\b/g,
  /\b(孤独 | 无聊 | 沮丧 | 绝望 | 满足 | 平静 | 困惑 | 惊讶 | 得意)\b/g,
  /\b(嫉妒 | 羞耻 | 愧疚 | 骄傲 | 轻蔑 | 厌恶 | 感激 | 爱 | 恨)\b/g
]

/**
 * 计算情感密度
 * @param {string} text - 要分析的文本
 * @returns {{
 *  tellCount: number,
 *  charCount: number,
 *  density: number,
 *  rating: string,
 *  suggestions: string
 * }}
 */
export function checkEmotionDensity(text) {
  let tellCount = 0
  
  for (const pattern of EMOTION_TELL_PATTERNS) {
    const matches = text.match(pattern)
    if (matches) tellCount += matches.length
  }
  
  const charCount = text.replace(/\s/g, '').length
  const density = charCount > 0 ? tellCount / charCount : 0
  
  const rating = density > 0.03 
    ? '较差（大量告知，建议删除至少 50% 的情感状态词）'
    : density > 0.02 
      ? '一般（需改进，替换部分抽象情感为具体动作）'
      : density > 0.01 
        ? '良好（基本达标，可继续优化）'
        : '优秀（沉浸感强，展示技法运用得当）'
  
  const suggestions = density > 0.03
    ? '1. Ctrl+F 搜索情感状态词\n2. 对每个结果问："如果用动作/环境展示会怎样？"\n3. 参考 de-ai-skill.md 第 13 节快速转换表'
    : ''
  
  return {
    tellCount,
    charCount,
    density: parseFloat(density.toFixed(4)),
    rating,
    suggestions
  }
}

/**
 * 命令行入口
 */
function main() {
  const args = process.argv.slice(2)
  
  if (args.length === 0) {
    console.error('Usage: node scripts/check-emotion-density.mjs <file.md>')
    console.error('\nExample:')
    console.error('  node scripts/check-emotion-density.mjs QMAI/.novel/chapters/chapter-1.md')
    process.exit(1)
  }
  
  const filePath = args[0]
  const absolutePath = path.isAbsolute(filePath) 
    ? filePath 
    : path.join(process.cwd(), filePath)
  
  try {
    const content = fs.readFileSync(absolutePath, 'utf-8')
    const result = checkEmotionDensity(content)
    
    console.log('\n' + '='.repeat(60))
    console.log('📊 Show-Don\'t-Tell 情感密度检测报告')
    console.log('='.repeat(60))
    console.log(`文件：${path.basename(absolutePath)}`)
    console.log(`字数：${result.charCount.toLocaleString()} (不含空格)`);
    console.log(`情感词计数：${result.tellCount}`)
    console.log(`密度比：${result.density}`)
    console.log(`评级：${result.rating}`)
    
    if (result.suggestions) {
      console.log('\n💡 优化建议:')
      console.log(result.suggestions)
    }
    
    console.log('='.repeat(60) + '\n')
    
    // 返回 Exit Code
    process.exit(result.density > 0.03 ? 2 : 0)
    
  } catch (error) {
    console.error(`❌ 读取文件失败：${error.message}`)
    process.exit(1)
  }
}

main()

