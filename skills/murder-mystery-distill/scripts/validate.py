#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""剧本验收：结构不变量 + 与真实语料分布的百分位比对。

用法：
    python validate.py <剧本.md> [--json]

支持两种输入：
  · 语料格式：`## 文件：<文件名>` 分节（scripts/corpus/10-extract-a1.py 的产物）
  · 生成格式：`### 玩家角色 N：<名字>` / `## 第N轮线索` / `### 四、真相复盘`

输出：
  ✅ 通过 / ⚠️ 偏离分布 / ❌ 违反结构不变量
"""
import io
import json
import os
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DIST_PATH = os.path.join(HERE, "..", "references", "distribution.json")

ACT_RE = re.compile(r"【第\s*([一二三四五六七八九十\d]+)\s*幕")
TIME_RE = re.compile(r"(\d{1,2}\s*[:：]\s*\d{2})|(\d{1,2}\s*点\s*(半|\d{1,2}\s*分)?)|([上下]午\s*\d{1,2}\s*点)")
NUM_ITEM = re.compile(r"^\s*(\d{1,3})\s*[.、)]\s*\S", re.M)
ROUND_RE = re.compile(r"第\s*([一二三四五六七八九十\d]+)\s*轮")
HIDDEN_RE = re.compile(r"发现隐藏线索|深入调查")
AP_RE = re.compile(r"(?<![A-Za-z])AP(?![A-Za-z])|行动点|搜证次数|搜查次数")
ROLE_HEAD = re.compile(r"^###\s*玩家角色\s*\d+\s*[：:]\s*\S", re.M)
NPC_HEAD = re.compile(r"^###\s*NPC\s*\d+\s*[：:]\s*\S", re.M)

MANUAL_KW = ("手册", "组织者", "主持人", "游戏说明", "规则", "公共信息", "背景")
CLUE_KW = ("线索", "证据")
TRUTH_KW = ("真相", "复盘", "解析", "答案", "供词")


def chars_of(s):
    return len(re.sub(r"\s+", "", s))


def split_corpus(md):
    parts = re.split(r"^## 文件：(.+)$", md, flags=re.M)
    return [(parts[i].strip(), parts[i + 1] if i + 1 < len(parts) else "")
            for i in range(1, len(parts), 2)]


def split_generated(md):
    """生成格式：按 `### 玩家角色 N：` 切角色本；线索按 `## 第一轮线索` 等切。"""
    secs = []
    heads = list(ROLE_HEAD.finditer(md)) + list(NPC_HEAD.finditer(md))
    heads.sort(key=lambda m: m.start())
    # 角色本必须在"线索/手册"开始处截断，否则最后一个角色本会把后文全吞进去
    cut = len(md)
    # 注意：不能用 `^#\s+\S` —— 它会命中文档标题那一行，把所有段截成 0 字
    # 只认"线索系统/手册"这一级的边界：`^# 第N部分` 若用 [一二三四] 会命中"第一部分"，
    # 把前面所有角色本都截成 0 字（这个 bug 真踩过）。所以只认 3/4 部分或线索轮次标题。
    for pat in (r"^##\s*第[一二三]轮线索", r"^#\s*第[三四]部分", r"^#\s*[^\n]*DM\s*手册"):
        m = re.search(pat, md, flags=re.M)
        if m:
            cut = min(cut, m.start())
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(md)
        end = min(end, cut) if m.start() < cut else m.start()
        name = m.group(0).split("：")[-1].split(":")[-1].strip()
        secs.append((name, md[m.end():end]))
    # 线索整块：从第一个「## 第N轮线索」到下一个一级标题（DM 手册）
    cm = re.search(r"^##\s*第[一二三]轮线索", md, flags=re.M)
    if cm:
        tail = md[cm.start():]
        stop = re.search(r"^#\s*第[一二三四]部分|^#\s*[^\n]*DM\s*手册", tail[1:], flags=re.M)
        secs.append(("线索", tail[: stop.start() + 1] if stop else tail))
    # DM 手册：从「# 第四部分」或含「DM 手册」的一级标题到结尾
    dm = (re.search(r"^#\s*[^\n]*DM\s*手册[^\n]*$", md, flags=re.M)
          or re.search(r"^#\s*第四部分[^\n]*$", md, flags=re.M))
    if dm:
        secs.append(("主持人手册", md[dm.start():]))
    # 真相
    tm = re.search(r"^#{1,4}\s*[^\n]*真相复盘[^\n]*$", md, flags=re.M)
    if tm:
        tail = md[tm.start():]
        stop = re.search(r"^#{1,3}\s*[^\n]*(QA|问答|注意|结局)", tail[1:], flags=re.M)
        secs.append(("真相", tail[: stop.start() + 1] if stop else tail))
    return secs


def clue_groups(clue_text):
    """线索按人物/场所分组：短标题行（无编号）后紧跟编号条目"""
    lines = [l.strip() for l in clue_text.split("\n")]
    groups = []
    for i, l in enumerate(lines[:-1]):
        if not l or len(l) > 14 or NUM_ITEM.match(l) or l.startswith("|"):
            continue
        j = i + 1
        while j < len(lines) and not lines[j]:
            j += 1
        if j < len(lines) and NUM_ITEM.match(lines[j]):
            groups.append(l)
    return groups

def percentile(values, x):
    if not values:
        return None
    below = sum(1 for v in values if v < x)
    return round(100 * below / len(values))


def main():
    if len(sys.argv) < 2:
        print("用法: python validate.py <剧本.md> [--json]")
        return 2
    path = sys.argv[1]
    md = io.open(path, encoding="utf-8").read()

    dist = {}
    if os.path.exists(DIST_PATH):
        dist = json.load(io.open(DIST_PATH, encoding="utf-8")).get("metrics", {})

    is_corpus = bool(re.search(r"^## 文件：", md, flags=re.M))
    secs = split_corpus(md) if is_corpus else split_generated(md)

    role = [t for n, t in secs if is_corpus and not any(k in n for k in TRUTH_KW + CLUE_KW + MANUAL_KW)]
    if not is_corpus:
        role = [t for n, t in secs if n not in ("线索", "真相", "主持人手册")]
    clue = "".join(t for n, t in secs if any(k in n for k in CLUE_KW))
    truth = "".join(t for n, t in secs if any(k in n for k in TRUTH_KW))
    manual = "".join(t for n, t in secs if any(k in n for k in MANUAL_KW))

    role_lens = sorted((chars_of(t) for t in role), reverse=True)
    metrics = {
        "总字数": chars_of(md),
        "角色本数": len(role),
        "角色本中位": int(statistics.median(role_lens)) if role_lens else 0,
        "角色本最长": role_lens[0] if role_lens else 0,
        "角色本最短": role_lens[-1] if role_lens else 0,
        "时间线时刻数": sum(len(TIME_RE.findall(t)) for t in role),
        # 生成格式的线索是 `### A1：…` 标题，不是编号行；两种都要认
        "线索条数": (len(NUM_ITEM.findall(clue)) if is_corpus
                    else len(re.findall(r"^#{3,4}\s*[ABC]\d{1,3}\s*[：:]", clue, re.M))),
        "线索分组数": len(clue_groups(clue)),
        "线索轮数": len(set(ROUND_RE.findall(clue))),
        "线索字数": chars_of(clue),
        "隐藏线索标记": len(HIDDEN_RE.findall(clue)),
        "真相字数": chars_of(truth),
        # 手册里含真相复盘 → 算手册时要扣掉，否则和"真相字数"重复计算（会把手册推到 100 分位以上）
        "手册字数": max(0, chars_of(manual) - chars_of(truth)),
        "手册首段字数": 0,  # 生成格式下不统计
        "分幕数": len({m for t in role for m in ACT_RE.findall(t)}),
        # 这里数的是正文里的图片引用（我方机制）；语料是独立 jpg 文件，故口径不同，不参与比对
    }

    print(f"剧本: {os.path.basename(path)}")
    print(f"格式: {'语料（## 文件：）' if is_corpus else '生成（### 玩家角色）'}｜{metrics['总字数']} 字\n")
    print(f"{'指标':<14}{'本剧本':>9}{'P50':>9}{'区间':>18}{'百分位':>8}  判定")
    print("-" * 68)
    warns, fails = 0, 0
    for k, m in metrics.items():
        d = dist.get(k)
        if not d:
            continue
        p50 = d["values"][len(d["values"]) // 2]
        pc = percentile(d["values"], m)
        ok = d["min"] <= m <= d["max"]
        v = "✅" if ok else ("⚠️" if m > d["min"] else "⚠️")
        if not ok:
            warns += 1
        print(f"{k:<14}{m:>9}{p50:>9}{str(d['min']) + '–' + str(d['max']):>18}{str(pc) + '%':>8}  {v}")

    # 结构不变量
    print("\n结构不变量：")
    checks = [
        ("至少 3 个角色本", len(role) >= 3),
        ("有线索内容", chars_of(clue) > 0),
        ("有真相/复盘内容", chars_of(truth) > 0),
        ("线索不含结论化表述（『说明/证明』出现在线索里 ≤2 次）",
         len(re.findall(r"说明|证明|表明", clue)) <= 2),
        ("时间线时刻 ≥ 8（预测凶手手法需要）", metrics["时间线时刻数"] >= 8),
    ]
    for label, ok in checks:
        print(f"  {'✅' if ok else '❌'} {label}")
        if not ok:
            fails += 1

    ap = bool(AP_RE.search(manual + clue))
    print(f"  {'✅' if ap else '⚠️'} 写了 AP/搜证规则")

    print(f"\n结论：{fails} 项结构不合规，{warns} 项超出语料分布区间")
    if fails:
        print("→ 先修结构不变量，再谈分布。")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
