# -*- coding: utf-8 -*-
"""语料去重：按「文件名+大小」指纹找出重复剧本。

实测（2026-10-19）：144-万灵血（6人封闭）与 197-万灵血（6人开放）是同一份内容
（10 个文件完全同名同大小），只是编号和"开放/封闭"标注不同。
重复本会污染分布统计（同一本被计两次），必须先找出来。
"""
import hashlib
import io
import os
import sys

ROOT = r"D:\play game\剧本杀剧本资源合集"
ROOTS = ["_文本型剧本（86个）", "_精筛_中位3000+线索（8个）", "剧本杀剧本资源合集"]
OUT = r"C:\cluade code\ppt\text-gen-agent\docs\剧本语料-重复本.csv"


def fingerprint(d):
    items = []
    for dp, _dn, fn in os.walk(d):
        if "__MACOSX" in dp:
            continue
        for f in fn:
            p = os.path.join(dp, f)
            try:
                items.append(f"{f}:{os.path.getsize(p)}")
            except OSError:
                pass
    if not items:
        return None, 0
    items.sort()
    h = hashlib.md5("\n".join(items).encode("utf-8")).hexdigest()
    return h, len(items)


groups = {}
for r in ROOTS:
    base = os.path.join(ROOT, r)
    if not os.path.isdir(base):
        continue
    for e in sorted(os.listdir(base)):
        p = os.path.join(base, e)
        if not os.path.isdir(p):
            continue
        h, n = fingerprint(p)
        if not h:
            continue
        groups.setdefault(h, []).append((e, r, n))

dups = {h: v for h, v in groups.items() if len(v) > 1}
rows = []
for h, v in dups.items():
    keep = v[0][0]
    for name, root, n in v:
        rows.append({
            "指纹": h[:10], "剧本": name, "分组": root, "文件数": n,
            "建议": "保留" if name == keep else "重复（可跳过）",
        })

import csv
with io.open(OUT, "w", encoding="utf-8-sig", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=["指纹", "剧本", "分组", "文件数", "建议"])
    w.writeheader()
    w.writerows(rows)

print(f"剧本总数: {sum(len(v) for v in groups.values())}")
print(f"唯一指纹: {len(groups)}")
print(f"重复组: {len(dups)}  → 涉及 {len(rows)} 个剧本，可跳过 {len(rows) - len(dups)} 个")
for h, v in list(dups.items())[:15]:
    print("  " + " == ".join(x[0][:26] for x in v))
print("\n明细:", OUT)
