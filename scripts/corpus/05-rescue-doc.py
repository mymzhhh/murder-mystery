# -*- coding: utf-8 -*-
"""给普查 CSV 打补丁：把"仅 .doc 旧格式"从"不合格"里救回来，单独成一档。

为什么（2026-10-19 实测）：census2 用 python-docx 读 .docx，读不了 .doc（旧二进制格式），
于是 10 个剧本被判成"没有可用于提取正文的文件"——但它们**内容齐全**，
只是需要先转换（LibreOffice / antiword / word 另存）。把这类混进"不合格"会误杀语料。
"""
import csv
import io
from collections import Counter

CSV = r"C:\cluade code\ppt\text-gen-agent\docs\剧本语料-合格清单.csv"

rows = list(csv.DictReader(io.open(CSV, encoding="utf-8-sig")))
fields = list(rows[0].keys())

rescued = 0
for r in rows:
    if r["档位"] == "X" and int(r["doc"] or 0) > 0:
        r["档位"] = "A-"
        r["评分"] = str(int(r["评分"] or 0) + 30)
        r["判定理由"] = f"仅 .doc 旧格式（可救：转 docx 后即可统计）；" + r["判定理由"]
        rescued += 1

order = {"A": 0, "A-": 1, "B": 2, "C": 3, "D": 4, "X": 5}
rows.sort(key=lambda r: (order.get(r["档位"], 9), -int(r["评分"] or 0), r["标题"]))
for i, r in enumerate(rows, 1):
    r["序号"] = str(i)

with io.open(CSV, "w", encoding="utf-8-sig", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=fields)
    w.writeheader()
    w.writerows(rows)

tc = Counter(r["档位"] for r in rows)
print("救回 A-（仅 .doc）:", rescued)
print("\n=== 最终分档 ===")
for t in ("A", "A-", "B", "C", "D", "X"):
    print(f"  {t}: {tc.get(t, 0)}")
print("\n=== 仍不合格（X）===")
for r in rows:
    if r["档位"] == "X":
        print(f"  · {r['标题']} —— {r['判定理由']}")
