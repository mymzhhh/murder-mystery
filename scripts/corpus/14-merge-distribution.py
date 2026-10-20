# -*- coding: utf-8 -*-
"""合并 A1(19 本) 与 A2(45 本) 的量化结果，做**样本外复核**并更新基线。

为什么要做（2026-10-20）：
  A1 只有 19 本（且是按"线索也是 docx"筛过的，有选择偏差）。
  拿 A2 的 45 本（线索是图片/PDF，但角色本/真相/手册齐全）单独算一遍，
  如果核心指标（角色本中位、时间线、真相）与 A1 接近，说明结论不是小样本假象。

口径（重要，别混用）：
  · 角色本 / 时间线 / 真相 / 手册  → 用 **A1+A2 共 64 本**（样本大、无 A1 的线索偏差）
  · 线索条数 / 线索字数 / 隐藏线索  → 只用 **A1 的 19 本**（A2 没有线索文件，混进来全是 0）
"""
import csv
import io
import json
import os
import statistics

BASE = r"C:\cluade code\ppt\text-gen-agent\data\corpus"
SKILL_REF = r"C:\cluade code\ppt\text-gen-agent\skills\murder-mystery-distill\references"
HOLDOUT = {"152-绝命阳光号（4人封闭）", "134-致命喷泉（4人封闭）"}

A1_ONLY = ["线索条数", "线索分组数", "线索轮数", "线索字数", "隐藏线索标记"]
COMBINED = ["总字数", "角色本数", "角色本中位", "角色本最长", "角色本最短",
            "时间线时刻数", "真相字数", "手册字数", "手册首段字数", "分幕数", "图片文件数"]


def load(tier):
    p = os.path.join(BASE, tier, "_metrics.csv")
    if not os.path.exists(p):
        return []
    return [r for r in csv.DictReader(io.open(p, encoding="utf-8-sig"))]


def vals(rows, key):
    return sorted(int(r[key]) for r in rows if r.get(key) not in (None, ""))


def stats(v):
    if not v:
        return {"n": 0, "nz": 0, "min": 0, "p50": 0, "max": 0}
    return {
        "n": len(v),
        "nz": sum(1 for x in v if x > 0),
        "min": v[0],
        "p50": int(statistics.median(v)),
        "max": v[-1],
    }


def main():
    a1 = [r for r in load("a1") if r["剧本"] not in HOLDOUT]
    a2 = load("a2")
    both = a1 + a2

    print(f"A1（训练）{len(a1)} 本 ｜ A2 {len(a2)} 本 ｜ 合并 {len(both)} 本\n")
    print(f"{'指标':<14}{'A1中位':>8}{'A2中位':>8}{'合并中位':>10}{'合并最小':>9}{'合并最大':>9}{'有值':>8}")
    print("-" * 68)
    for k in COMBINED:
        s1, s2, sc = stats(vals(a1, k)), stats(vals(a2, k)), stats(vals(both, k))
        print(f"{k:<14}{s1['p50']:>8}{s2['p50']:>8}{sc['p50']:>10}{sc['min']:>9}{sc['max']:>9}"
              f"{str(sc['nz']) + '/' + str(sc['n']):>8}")

    # 更新 distribution.json（角色/时间线/真相用合并样本，线索用 A1）
    dist = {"sample_role": len(both), "sample_clue": len(a1),
            "holdout": sorted(HOLDOUT), "metrics": {}}
    for k in COMBINED:
        v = vals(both, k)
        if v:
            dist["metrics"][k] = {"values": v, "min": v[0], "max": v[-1],
                                  "source": f"A1+A2（{len(v)} 本）"}
    for k in A1_ONLY:
        v = vals(a1, k)
        if v:
            dist["metrics"][k] = {"values": v, "min": v[0], "max": v[-1],
                                  "source": f"仅 A1（{len(v)} 本，A2 无线索文件）"}

    io.open(os.path.join(SKILL_REF, "distribution.json"), "w", encoding="utf-8").write(
        json.dumps(dist, ensure_ascii=False, indent=1))
    print(f"\n已更新 distribution.json（角色类 {len(both)} 本 / 线索类 {len(a1)} 本）")


if __name__ == "__main__":
    main()
