# -*- coding: utf-8 -*-
"""把训练集分布导出成 JSON，供 skill 的 validate.py 直接比对（不依赖 data/ 目录）。"""
import csv
import io
import json
import os

CSV = r"C:\cluade code\ppt\text-gen-agent\data\corpus\a1\_metrics.csv"
OUT = r"C:\cluade code\ppt\text-gen-agent\skills\murder-mystery-distill\references\distribution.json"
HOLDOUT = {"152-绝命阳光号（4人封闭）", "134-致命喷泉（4人封闭）"}

KEYS = ["总字数", "角色本数", "角色本中位", "角色本最长", "角色本最短", "时间线时刻数",
        "线索条数", "线索分组数", "线索轮数", "线索字数", "隐藏线索标记",
        "真相字数", "手册字数", "手册首段字数", "分幕数", "图片文件数"]

rows = [r for r in csv.DictReader(io.open(CSV, encoding="utf-8-sig")) if r["剧本"] not in HOLDOUT]
dist = {"sample": len(rows), "holdout": sorted(HOLDOUT), "metrics": {}}
for k in KEYS:
    vals = sorted(int(r[k]) for r in rows)
    dist["metrics"][k] = {"values": vals, "min": vals[0], "max": vals[-1]}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
io.open(OUT, "w", encoding="utf-8").write(json.dumps(dist, ensure_ascii=False, indent=1))
print("已写出:", OUT, f"（{len(rows)} 本）")
for k in ("角色本中位", "时间线时刻数", "真相字数", "线索字数"):
    v = dist["metrics"][k]["values"]
    print(f"  {k}: min={v[0]} p50={v[len(v)//2]} max={v[-1]}")
