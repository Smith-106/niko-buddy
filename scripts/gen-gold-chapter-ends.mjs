#!/usr/bin/env node
/**
 * gen-gold-chapter-ends.mjs — 黄金集章末标注（T01b-2：P0 批次 30 条）
 *
 * 共识：章末 200 分批推进（P0 50 → 200）；本批 30 条（gufeng/xuanhuan/yanqing 各 8 + dushi/xuanyi 各 3）
 * 字段：chapter_id / hook_type(悬念|情绪|承诺|信息缺口) / strength(1-5) / evidence(原文引用) / dimension
 * annotator: ai-assisted-pending-human（模型辅助预标，人工确认后升级为正式黄金集）
 * 输出：docs/p0/corpus/gold/batch-20260826-t01b-chapter-ends/{genre}-end-NNN.json
 *
 * 用法：node scripts/gen-gold-chapter-ends.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"

const OUT = resolve("docs/p0/corpus/gold/batch-20260826-t01b-chapter-ends")

// [genre, 文件名, hook_type, strength, evidence]
const ANNOTATIONS = [
  ["gufeng", "gufeng-001", "悬念", 4, "女童闻言身子一颤，吓得脸色唰的一下都白了……嘴唇翕动（危险逼近，拨浪鼓动作制造紧张）"],
  ["gufeng", "gufeng-002", "悬念", 4, "前方草丛一阵青光乱晃下，一下射出五六条青色长蛇……（青蛇袭击+符箓防御，战斗悬念）"],
  ["gufeng", "gufeng-003", "悬念", 3, "此妖擅使木属性幻术，在这片草丛中可谓如鱼得水，贸然追进去怕是不妥（追捕决策之争）"],
  ["gufeng", "gufeng-004", "信息缺口", 3, "若能活捉此妖狐，不仅可成为内堂弟子，还能获一枚叱血丹和一千灵石（任务奖励披露）"],
  ["gufeng", "gufeng-005", "悬念", 4, "草丛中蓦然窜出一个娇小身影，赫然正是此前遁入草丛的那个女童（猎物现身，合围在即）"],
  ["gufeng", "gufeng-006", "情绪", 3, "山野穷小子，今日纵横三界的韩老魔，一切，皆有可能！（少年志气独白）"],
  ["gufeng", "gufeng-007", "情绪", 2, "被人起了个二愣子的绰号……这些名字也不见得比二愣子好听到哪里去（人物闲笔，塑造代入）"],
  ["gufeng", "gufeng-008", "悬念", 5, "并不知道家中已经来了一位，会改变他一生命运的客人（经典命运转折钩子）"],
  ["xuanhuan", "xuanhuan-001", "悬念", 4, "萧炎，斗之力，三段！级别：低级！……人群嘲讽（废柴开局，反差铺垫）"],
  ["xuanhuan", "xuanhuan-002", "情绪", 2, "稚气未脱的小脸蕴含淡淡的妩媚，清纯与妩媚矛盾集合，全场瞩目的焦点（惊艳描写）"],
  ["xuanhuan", "xuanhuan-003", "情绪", 3, "萧媚脑中浮现三年前那意气风发的少年……家族百年最年轻的斗者（今昔对比）"],
  ["xuanhuan", "xuanhuan-004", "悬念", 3, "这名紫裙少女，论起美貌与气质，比先前的萧媚还要更胜上几分（新角色登场）"],
  ["xuanhuan", "xuanhuan-005", "情绪", 4, "我现在还有资格让你怎么叫么？望着已经成长为家族最璀璨明珠的少女，萧炎苦涩的道（落魄自嘲）"],
  ["xuanhuan", "xuanhuan-006", "情绪", 4, "兽神？现在我们魂兽，恐怕就剩下眼前这些了吧。我还做谁的神？（族群没落独白）"],
  ["xuanhuan", "xuanhuan-007", "悬念", 5, "结束了、结束了、结束了……低沉的声音毫无预兆地徘徊，大地龟裂，湖水倒灌（大事件前兆）"],
  ["xuanhuan", "xuanhuan-008", "信息缺口", 4, "主上，现在的人类，已经太过强大……我们无法抗衡（世界观冲突披露）"],
  ["yanqing", "yanqing-001", "悬念", 4, "正当人们以为这名小儿即将血溅神武大街时，太子微微扬首，纵身一跃，接住了他（舍身相救）"],
  ["yanqing", "yanqing-002", "悬念", 4, "太子夜夜守在桥头，终于，在一夜遇到了作祟的鬼魂（守候者终遇目标）"],
  ["yanqing", "yanqing-003", "信息缺口", 2, "即便等来了天劫，过不了这一关也要死了，不死也废了（修行世界观铺陈）"],
  ["yanqing", "yanqing-004", "情绪", 3, "掉下来还砸着了一位路过的神官……再来看那边那座金殿（插科打诨喜剧节奏）"],
  ["yanqing", "yanqing-005", "情绪", 3, "一个人蹲在仙京大街边头痛了半天……他飞升快三天了，还没进通灵阵（落魄反差萌）"],
  ["yanqing", "yanqing-006", "悬念", 4, "这声音乍听十分舒服，可细听便会发觉，嗓子冷淡得很，情绪也冷淡得很（不知是敌是友）"],
  ["yanqing", "yanqing-007", "情绪", 3, "烂摊子都自己走了，便赶紧的也跑了（主角逃避狼狈，喜剧收尾）"],
  ["yanqing", "yanqing-008", "信息缺口", 2, "越是有钱人越敬畏神鬼之事……这里说的，明显就是第一类人（信众分类设定）"],
  ["dushi", "dushi-001", "情绪", 3, "算命的说我能活到七十八岁……这样算下来你并不亏（老少斗嘴，日常幽默）"],
  ["dushi", "dushi-002", "悬念", 3, "可他想不通怎么到了第六步，自己明明吃了对方的马，却突然陷入了颓势（棋局伏笔）"],
  ["dushi", "dushi-003", "悬念", 4, "他顺着少年的目光看去，正巧看到胡同外有一对夫妻牵着一个小男孩走来（身份线索引出）"],
  ["xuanyi", "xuanyi-001", "悬念", 4, "逃脱了被玷污命运的少女，捂着自己衣服畏惧地躲在李火旺身后（危机暂解，余波未平）"],
  ["xuanyi", "xuanyi-002", "悬念", 4, "那个头破血流的胖子顿时露出幸灾乐祸的表情：哈哈！你完撩！！（新威胁登场）"],
  ["xuanyi", "xuanyi-003", "悬念", 4, "丹炉的阴影直接淹没过了自己……还有在丹炉前的一道背影（压抑感+身份谜团）"],
]

mkdirSync(OUT, { recursive: true })
let n = 0
for (const [genre, src, hookType, strength, evidence] of ANNOTATIONS) {
  n++
  const gold = {
    gold_id: `gold-${genre}-end-${String(n).padStart(3, "0")}`,
    batch_id: "batch-20260826-t01b-chapter-ends",
    source_file: `human/batch-20260826-t01b1-human/${src}.txt`,
    layer: "gold",
    genre,
    type: "chapter_end",
    annotator: "ai-assisted-pending-review",
    annotation_date: "2026-08-26",
    chapter_id: src,
    hook_type: hookType,
    strength,
    evidence,
    pending: true,
  }
  writeFileSync(join(OUT, `${src}-end.json`), JSON.stringify(gold, null, 2), "utf8")
}
console.log(`[gen-gold] 章末标注 ${n} 条 → ${OUT}（annotator=ai-assisted-pending-human，待人工确认）`)
