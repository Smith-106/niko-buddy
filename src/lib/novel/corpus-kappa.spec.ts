import { describe, it, expect } from 'vitest'
import {
  buildConfusionMatrix,
  computeCohenKappa,
  kappaLevel,
  isGoldQualified,
  toLabelPairs,
  isFullyLabeled,
  GOLD_QUALIFIED_KAPPA,
  type LabelPair,
  type BlindSample,
} from './corpus-kappa'

describe('corpus-kappa — T01b Cohen κ 盲标质量门', () => {
  describe('buildConfusionMatrix', () => {
    it('空数组 → 全零矩阵', () => {
      expect(buildConfusionMatrix([])).toEqual({ n00: 0, n01: 0, n10: 0, n11: 0 })
    })

    it('混合标注正确计数', () => {
      const pairs: LabelPair[] = [
        { docId: 'a', labelA: 0, labelB: 0 },
        { docId: 'b', labelA: 0, labelB: 1 },
        { docId: 'c', labelA: 1, labelB: 0 },
        { docId: 'd', labelA: 1, labelB: 1 },
        { docId: 'e', labelA: 0, labelB: 0 },
      ]
      expect(buildConfusionMatrix(pairs)).toEqual({ n00: 2, n01: 1, n10: 1, n11: 1 })
    })
  })

  describe('computeCohenKappa', () => {
    it('全一致 (κ=1.0): 两标注者完全相同', () => {
      const pairs: LabelPair[] = [
        { docId: 'a', labelA: 0, labelB: 0 },
        { docId: 'b', labelA: 0, labelB: 0 },
        { docId: 'c', labelA: 1, labelB: 1 },
        { docId: 'd', labelA: 1, labelB: 1 },
      ]
      const r = computeCohenKappa(pairs)
      expect(r.kappa).toBeCloseTo(1.0, 10)
      expect(r.po).toBeCloseTo(1.0, 10)
      expect(r.n).toBe(4)
      expect(r.agreement).toBe('almost-perfect')
    })

    it('随机一致基线 (κ≈0): 两独立标注者各标一半', () => {
      // 大样本下, 两标注者各自独立随机 50/50 标注 → Po≈Pe → κ≈0
      const pairs: LabelPair[] = []
      for (let i = 0; i < 1000; i++) {
        pairs.push({
          docId: `d${i}`,
          labelA: (i % 2) as 0 | 1,
          labelB: ((i + Math.floor(i / 500)) % 2) as 0 | 1,
        })
      }
      const r = computeCohenKappa(pairs)
      // 此构造 Po 与 Pe 非常接近 → κ 接近 0
      expect(Math.abs(r.kappa)).toBeLessThan(0.1)
    })

    it('全分歧 (κ<0): 两标注者系统性相反', () => {
      const pairs: LabelPair[] = [
        { docId: 'a', labelA: 0, labelB: 1 },
        { docId: 'b', labelA: 0, labelB: 1 },
        { docId: 'c', labelA: 1, labelB: 0 },
        { docId: 'd', labelA: 1, labelB: 0 },
      ]
      const r = computeCohenKappa(pairs)
      expect(r.kappa).toBeLessThan(0)
      expect(r.agreement).toBe('poor')
    })

    it('小样本边界 (N=1): 一致 → κ=1', () => {
      const pairs: LabelPair[] = [{ docId: 'only', labelA: 1, labelB: 1 }]
      const r = computeCohenKappa(pairs)
      expect(r.n).toBe(1)
      expect(r.po).toBeCloseTo(1.0, 10)
    })

    it('小样本边界 (N=1): 不一致 → Po=0', () => {
      const pairs: LabelPair[] = [{ docId: 'only', labelA: 0, labelB: 1 }]
      const r = computeCohenKappa(pairs)
      expect(r.po).toBe(0)
      expect(r.n).toBe(1)
    })

    it('空数组抛错: κ 对空集无定义', () => {
      expect(() => computeCohenKappa([])).toThrow(/empty/)
    })

    it('Pe=1 退化 (两标注者分布完全相同, 分母=0) → κ 约定 1', () => {
      // A 和 B 各标 2 个 0 + 2 个 1, 且完全一致 → Pe=(2*2+2*2)/16=0.5, 非退化
      // 真正退化: 全标 0 或全标 1 (单一边际) → Pe=1
      const pairs: LabelPair[] = [
        { docId: 'a', labelA: 0, labelB: 0 },
        { docId: 'b', labelA: 0, labelB: 0 },
        { docId: 'c', labelA: 0, labelB: 0 },
      ]
      const r = computeCohenKappa(pairs)
      // 全标 0: Po=1, Pe=1 → 分母 0 → 约定 κ=1
      expect(r.kappa).toBe(1.0)
      expect(r.po).toBe(1.0)
      expect(r.pe).toBe(1.0)
    })
  })

  describe('kappaLevel (Landis-Koch 1977)', () => {
    it('各级别边界正确', () => {
      expect(kappaLevel(-0.5)).toBe('poor')
      expect(kappaLevel(0.0)).toBe('slight')
      expect(kappaLevel(0.2)).toBe('slight')
      expect(kappaLevel(0.21)).toBe('fair')
      expect(kappaLevel(0.4)).toBe('fair')
      expect(kappaLevel(0.41)).toBe('moderate')
      expect(kappaLevel(0.6)).toBe('moderate')
      expect(kappaLevel(0.61)).toBe('substantial')
      expect(kappaLevel(0.8)).toBe('substantial')
      expect(kappaLevel(0.81)).toBe('almost-perfect')
      expect(kappaLevel(1.0)).toBe('almost-perfect')
    })
  })

  describe('isGoldQualified', () => {
    it('κ=0.7 正好达标', () => {
      expect(isGoldQualified({ kappa: 0.7, po: 0, pe: 0, n: 1, agreement: 'substantial' })).toBe(true)
    })

    it('κ=0.69 未达标', () => {
      expect(isGoldQualified({ kappa: 0.69, po: 0, pe: 0, n: 1, agreement: 'moderate' })).toBe(false)
    })

    it('GOLD_QUALIFIED_KAPPA 常量 = 0.7', () => {
      expect(GOLD_QUALIFIED_KAPPA).toBe(0.7)
    })
  })

  describe('BlindSample ↔ LabelPair 转换', () => {
    const fullyLabeled: BlindSample = {
      docId: 'a',
      layer: 'human',
      genre: '言情',
      filePath: 'docs/p0/corpus/human/a.txt',
      labelA: 0,
      labelB: 0,
    }
    const halfLabeled: BlindSample = {
      docId: 'b',
      layer: 'ai',
      genre: '玄幻',
      filePath: 'docs/p0/corpus/ai/b.txt',
      labelA: 1,
    }

    it('isFullyLabeled 正确判定', () => {
      expect(isFullyLabeled(fullyLabeled)).toBe(true)
      expect(isFullyLabeled(halfLabeled)).toBe(false)
    })

    it('toLabelPairs 跳过未完成标注', () => {
      const pairs = toLabelPairs([fullyLabeled, halfLabeled])
      expect(pairs).toHaveLength(1)
      expect(pairs[0].docId).toBe('a')
      expect(pairs[0].labelA).toBe(0)
      expect(pairs[0].labelB).toBe(0)
    })
  })
})
