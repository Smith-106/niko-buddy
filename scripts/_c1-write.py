import sys, json, re
# 用法: python scripts/_c1-write.py <genre> <start> <json-file>  — 校验并写入，报告所有违规
genre, start, jf = sys.argv[1], int(sys.argv[2]), sys.argv[3]
texts = json.load(open(jf, encoding='utf-8'))
BAD = re.compile(r'(www\.|http|\.com|\.net|笔趣阁|首发|本章未完|点击|最新章节|GCR|最终稿|（本段|本段为)')
ok, bad = 0, []
for i, t in enumerate(texts):
    n = start + i
    name = f"{genre}-{n:03d}"
    body = t.strip()
    core = re.sub(r'\s+', '', body)
    errs = []
    if not (350 <= len(core) <= 500): errs.append(f"len={len(core)}")
    if BAD.search(body): errs.append("bad-pattern")
    if errs:
        bad.append(f"{name}: {','.join(errs)}")
    else:
        open(f"docs/p0/corpus/_staging-ai-c1/{genre}/{name}.txt", 'w', encoding='utf-8').write(body)
        ok += 1
print(f"{genre}: wrote {ok}/{len(texts)}")
if bad:
    print("VIOLATIONS:"); [print(' ', b) for b in bad]
