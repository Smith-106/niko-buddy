# #97: 伏笔tracker对账 — planted项在 plantedChapter 之后正文是否真实出现
# 判定 233 个 overdue critical 是 tracker陈旧 还是 真实断更
# 运行：python3 scripts/quality-gate-97-reconcile.py
import json, re, glob

base = 'C:/QM-BOOK/身体都是租的，你让我修仙？'
d = json.load(open(base + '/.novel/foreshadowing-tracker.json', encoding='utf-8'))
items = d.get('items', [])

chaps = {}
for p in glob.glob(base + '/QM/chapters/chapter-*.md'):
    m = re.search(r'chapter-(\d+)\.md$', p)
    if not m:
        continue
    n = int(m.group(1))
    t = open(p, encoding='utf-8').read()
    body = re.sub(r'^---\n.*?\n---\n', '', t, flags=re.S)
    chaps[n] = body

def keywords(name):
    parts = re.split(r'[，。、；：？！「」『』（）()·…—\s/、｜|]+', name)
    kws = [p for p in parts if len(p) >= 2]
    return kws[:6]

recur = 0
dropped = 0
dropped_list = []
recur_list = []
for it in items:
    if it.get('status') != 'planted':
        continue
    pc = it.get('plantedChapter', 0) or 0
    name = it.get('name', '')
    kws = keywords(name)
    if not kws:
        dropped += 1
        dropped_list.append((it.get('id'), name, pc))
        continue
    hit_chs = []
    for n in range(pc + 1, 163):
        body = chaps.get(n, '')
        if any(k in body for k in kws):
            hit_chs.append(n)
    if hit_chs:
        recur += 1
        if len(recur_list) < 8:
            recur_list.append((it.get('id'), name, pc, hit_chs[:6]))
    else:
        dropped += 1
        if len(dropped_list) < 15:
            dropped_list.append((it.get('id'), name, pc))

print(json.dumps({
    'planted_total': sum(1 for it in items if it.get('status') == 'planted'),
    'recur_in_later_prose': recur,
    'never_recur_after_planted': dropped,
    'recur_examples': recur_list,
    'dropped_examples': dropped_list,
}, ensure_ascii=False, indent=1))
