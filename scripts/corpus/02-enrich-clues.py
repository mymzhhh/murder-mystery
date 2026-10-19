# -*- coding: utf-8 -*-
"""给 A 档补两列更通用的线索信号（因为"编号列表"只覆盖一种排版）。

实测教训（2026-10-19）：
  · 344 的《线索.docx》是「按人物分组 + 1. 2. 3. 编号列表」→ 条目数能数出来；
  · 039-愤怒的葡萄 的《秘密线索和指控表.docx》是「第N轮的秘密线索 ——— 按这条线折叠 ———」
    的分页式排版 → 编号行数 = 0，但线索显然是齐全的。
所以补：
  · 线索文件字数        —— 有线索文件且字数够，就说明线索齐全（与排版无关）
  · 线索轮次数          —— "第N轮…线索" 出现几种轮次（真本 2 轮；有的本 6 轮秘密线索）
  · 隐藏线索标记        —— 「发现隐藏线索」次数（能否对标"深入调查"）
"""
import csv
import io
import os
import re

CSV = r"C:\cluade code\ppt\text-gen-agent\docs\剧本语料-合格清单.csv"
ROOT = r"D:\play game\剧本杀剧本资源合集"

import sys
sys.path.insert(0, r"C:\cluade code\ppt\text-gen-agent\_verify")
from census2 import read_docx

ROUND_RE = re.compile(r"第\s*([一二三四五六七八九十\d]+)\s*轮")
HIDDEN_RE = re.compile(r"发现隐藏线索|深入调查")

rows = list(csv.DictReader(io.open(CSV, encoding="utf-8-sig")))
fields = list(rows[0].keys())
for c in ("线索文件数", "线索文件字数", "线索轮次数"):
    if c not in fields:
        fields.insert(fields.index("线索条目数") + 1, c)

# 标题 → 目录
dir_map = {}
for r in ("_文本型剧本（86个）", "_精筛_中位3000+线索（8个）", "剧本杀剧本资源合集"):
    base = os.path.join(ROOT, r)
    if not os.path.isdir(base):
        continue
    for e in os.listdir(base):
        p = os.path.join(base, e)
        if os.path.isdir(p):
            dir_map[e] = p

targets = [r for r in rows if r["档位"] == "A"]
print(f"要补的 A 档: {len(targets)}")

for i, r in enumerate(targets, 1):
    d = dir_map.get(r["标题"])
    r["线索文件数"], r["线索文件字数"], r["线索轮次数"] = "0", "0", "0"
    if not d:
        continue
    clue_files = []
    for dp, _dn, fn in os.walk(d):
        for f in fn:
            if f.lower().endswith(".docx") and ("线索" in f or "证据" in f):
                clue_files.append(os.path.join(dp, f))
    if not clue_files:
        continue
    chars = 0
    rounds = set()
    for p in clue_files[:6]:
        n, text = read_docx(p)
        chars += n
        for m in ROUND_RE.finditer(text):
            rounds.add(m.group(1))
    r["线索文件数"] = str(len(clue_files))
    r["线索文件字数"] = str(chars)
    r["线索轮次数"] = str(len(rounds))
    if i % 15 == 0:
        print(f"  ...{i}/{len(targets)}")

with io.open(CSV, "w", encoding="utf-8-sig", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=fields, restval="")
    w.writeheader()
    w.writerows(rows)

have = [r for r in targets if int(r["线索文件字数"] or 0) > 0]
print(f"\nA 档里有线索文件且非空: {len(have)}/{len(targets)}")
print("线索文件字数中位:", sorted(int(r["线索文件字数"]) for r in have)[len(have) // 2] if have else 0)
print("\n样例：")
for r in have[:8]:
    print(f"  {r['标题'][:26]:<28} 线索文件{r['线索文件数']}个 {r['线索文件字数']:>5}字 轮次{r['线索轮次数']}")
