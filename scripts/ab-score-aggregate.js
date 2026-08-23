#!/usr/bin/env node
/**
 * ab-score-aggregate.js — T36 真实补验轮统计计算
 * 
 * ESM 入口，委托给 .cjs 实现。
 * 用法：node scripts/ab-score-aggregate.js
 */

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
require('./ab-score-aggregate.cjs')