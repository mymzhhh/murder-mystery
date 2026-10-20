#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成"语义评审包"：把打分需要的原文片段摊在一处，避免评审时来回翻。

配套 references/review-rubric.md 使用。它**不打分**，只做三件事：
  1. 把四个维度要用的原文抽出来（手法声明 / 时间线 / 线索清单 / 真相）；
  2. 跑自动可测的预标记（手法缺失或未落地、线索结论化措辞、隐藏线索配对）；
  3. 输出成一份 markdown，评审者按锚点打分并**逐项附引用**。

用法：
    python review_packet.py <剧本.md> [--out packet.md] [--max-clues 60]
"""
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "..", "references", "distribution.json")

TIME_RE = re.compile(r"(\d{1,2})\s*[:：]\s*(\d{2})")
CLUE_HEAD = re.compile(r"^#{3,4}\s*([ABC]\d{1,3})\s*[：:]\s*(.*)$", re.M)
NUM_ITEM = re.compile(r"^\s*(\d{1,3})\s*[.、)]\s*\S", re.M)
CONCLUSION = re.compile(r"说明|证明|表明|可见|因此|显然|毫无疑问")
# 父线索必须**在同一句里带括号标记**，不能在正文任意位置提到"深入调查"就算 ——
# 实测：宽匹配会把 5 个父线索数成 22 个（正文里到处都在提这个机制）
HIDDEN_PARENT = re.compile(r"[（(][^）)]{0,20}(?:发现隐藏线索|可深入调查|可深挖)[^）)]{0,20}[）)]")
HIDDEN_CHILD = re.compile(r"通过深入调查|隐藏线索\s*[：:]")
METHOD_KW = re.compile(r"击打|敲击|砸|刺|勒|捂|掐|推下|下毒|投毒|调快|调慢|换药|伪装|伪造|布置|锁定|上锁")
ROLE_HEAD = re.compile(r"^###\s*(?:玩家角色|NPC)\s*(\d+)\s*[：:]\s*(.+)$", re.M)

MANUAL_KW = ("手册", "组织者", "主持人", "游戏说明", "规则", "公共信息", "背景")
CLUE_KW = ("线索", "证据", "搜证")
TRUTH_KW = ("真相", "复盘", "解析", "答案", "供词")


def chars(s):
    return len(re.sub(r"\s+", "", s or ""))


def split_corpus(md):
    parts = re.split(r"^## 文件：(.+)$", md, flags=re.M)
    return [(parts[i].strip(), parts[i + 1] if i + 1 < len(parts) else "")
            for i in range(1, len(parts), 2)]


def split_generated(md):
    """生成格式：角色本 + 线索块 + 真相块"""
    secs = []
    heads = list(ROLE_HEAD.finditer(md))
    cut = len(md)
    for pat in (r"^##\s*第[一二三]轮线索", r"^#\s*第[三四]部分"):
        m = re.search(pat, md, flags=re.M)
        if m:
            cut = min(cut, m.start())
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(md)
        end = min(end, cut) if m.start() < cut else m.start()
        secs.append((m.group(2).strip(), md[m.end():end]))
    cm = re.search(r"^##\s*第[一二三]轮线索", md, flags=re.M)
    if cm:
        tail = md[cm.start():]
        stop = re.search(r"^#\s*第[三四]部分", tail[1:], flags=re.M)
        secs.append(("线索", tail[: stop.start() + 1] if stop else tail))
    tm = re.search(r"^#{1,4}\s*[^\n]*真相复盘[^\n]*$", md, flags=re.M)
    if tm:
        tail = md[tm.start():]
        stop = re.search(r"^#{1,3}\s*[^\n]*(QA|问答|注意|结局)", tail[1:], flags=re.M)
        secs.append(("真相", tail[: stop.start() + 1] if stop else tail))
    return secs


def timeline_of(text):
    out = []
    for line in (text or "").split("\n"):
        s = line.strip()
        m = TIME_RE.search(s)
        if not m:
            continue
        out.append(f"{int(m.group(1)):02d}:{m.group(2)}  {re.sub(r'^[-*•\\s]+', '', s)[:90]}")
    return out


def main():
    if len(sys.argv) < 2:
        print("用法: python review_packet.py <剧本.md> [--out x.md]")
        return 2
    path = sys.argv[1]
    md = io.open(path, encoding="utf-8").read()
    max_clues = 60
    if "--max-clues" in sys.argv:
        max_clues = int(sys.argv[sys.argv.index("--max-clues") + 1])

    is_corpus = bool(re.search(r"^## 文件：", md, flags=re.M))
    secs = split_corpus(md) if is_corpus else split_generated(md)

    if is_corpus:
        roles = [(n, t) for n, t in secs if not any(k in n for k in MANUAL_KW + CLUE_KW + TRUTH_KW)]
    else:
        roles = [(n, t) for n, t in secs if n not in ("线索", "真相")]
    clue_text = "\n".join(t for n, t in secs if any(k in n for k in CLUE_KW))
    truth = "\n".join(t for n, t in secs if any(k in n for k in TRUTH_KW))

    L = []
    A = L.append
    A(f"# 语义评审包：{os.path.basename(path)}")
    A("")
    A(f"> 格式：{'语料（## 文件：）' if is_corpus else '生成（### 玩家角色）'}｜全文 {chars(md)} 字")
    A(f"> 角色本 {len(roles)} 份｜线索 {chars(clue_text)} 字｜真相 {chars(truth)} 字")
    A("> 打分标准见 `references/review-rubric.md`，**每个分数必须附引用**。")
    A("")

    # ---------- 预标记 ----------
    A("## 零、自动预标记（不能代替判断）")
    A("")
    flags = []

    killer = None
    for n, t in roles:
        if re.search(r"凶手确认|你就是凶手|你是本案真凶|真凶", t):
            killer = (n, t)
            break
    if not killer and roles:
        killer = roles[0]

    method_claim, method_ok = "", None
    if killer:
        name, text = killer
        head = re.split(r"###\s*[^\n]*(?:凶手确认|作案过程|手法)[^\n]*\n", text)
        before = re.split(r"###\s*[^\n]*(?:时间线|时间轴)[^\n]*\n", text)[0]
        msec = head[1] if len(head) > 1 else before
        hits = [ln.strip() for ln in msec.split("\n") if TIME_RE.search(ln) and METHOD_KW.search(ln)]
        method_claim = hits[0] if hits else ""
        tl = timeline_of(text)
        if hits:
            t0 = TIME_RE.search(hits[0])
            key = f"{int(t0.group(1)):02d}:{t0.group(2)}"
            method_ok = any(key in x for x in tl)
        flags.append(("凶手（推定）", f"**{name}**"))
        has_method_sec = len(re.split(r"###\s*[^\n]*(?:凶手确认|作案过程|手法)[^\n]*\n", text)) > 1
        if method_claim:
            flags.append(("手法声明", method_claim[:100]))
            flags.append(("手法是否落在时间线", "✅ 有对应时刻" if method_ok else "❌ 未在时间线中找到对应时刻"))
        elif has_method_sec:
            flags.append(("手法声明", "**该角色有「凶手确认」段，但没有带时刻的手法声明**"))
            flags.append(("手法是否落在时间线", "❌ 无法核对"))
        else:
            flags.append(("手法声明", "该本没有「凶手确认/作案过程」段 → **无法核对**（不算缺陷，但诡计维度要人工判）"))
            flags.append(("手法是否落在时间线", "— 无法核对"))

    concl = []
    for m in CLUE_HEAD.finditer(clue_text):
        body = clue_text[m.end(): m.end() + 300]
        if CONCLUSION.search(body):
            word = CONCLUSION.search(body).group(0)
            concl.append(f"{m.group(1)}（出现「{word}」）")
    flags.append(("线索结论化措辞", "、".join(concl[:10]) if concl else "无（≤ 阈值）"))

    parents = set()
    for m in CLUE_HEAD.finditer(clue_text):
        # 必须**切到下一条线索标题为止**再判：否则窗口会跨到下一条的标记上，
        # 实测把 5 个父线索数成 18 个（119 那一本更夸张）。
        seg = re.split(r"^#{3,4}\s*[ABC]\d{1,3}", clue_text[m.end():], flags=re.M)[0][:400]
        if HIDDEN_PARENT.search(seg):
            parents.add(m.group(1))
    children = set(re.findall(r"通过深入调查\s*([ABC]\d{1,3})", clue_text))
    if parents or children:
        paired = parents & children
        flags.append(("隐藏线索配对", f"父 {len(parents)} 个、子 {len(children)} 个、"
                                    f"成对 {len(paired)} 对" +
                                    ("" if parents == children else "　⚠️ 存在不成对的父/子线索")))
    else:
        flags.append(("隐藏线索", "无（该本没有深入调查机制）"))

    A("| 项目 | 结果 |")
    A("|---|---|")
    for k, v in flags:
        A(f"| {k} | {v} |")
    A("")

    # ---------- 维度一素材 ----------
    A("## 一、诡计成立性 —— 素材")
    A("")
    if killer:
        A(f"**{killer[0]} 的手法声明段（原文）**")
        A("")
        msec = re.split(r"###\s*[^\n]*(?:凶手确认|作案过程|手法)[^\n]*\n", killer[1])
        body = (msec[1] if len(msec) > 1 else "").strip()
        A("```")
        A(body[:1200] if body else "（该角色本没有「凶手确认/作案过程」段）")
        A("```")
        A("")
        A(f"**{killer[0]} 的时间线（{len(timeline_of(killer[1]))} 条）**")
        A("")
        A("```")
        A("\n".join(timeline_of(killer[1])[:30]) or "（无时刻行）")
        A("```")
        A("")
    A("→ 逐步骤核对：每个手法步骤，能否在下面的线索清单里找到物证/观察支撑？")
    A("")

    # ---------- 维度二素材 ----------
    A("## 二、误导可证伪性 —— 素材")
    A("")
    A("线索清单（供成对标注「误导 X → 由线索 Y 排除」）：")
    A("")
    A("| 编号 | 内容（截断） | 结论化? |")
    A("|---|---|---|")
    entries = []
    for m in CLUE_HEAD.finditer(clue_text):
        cid = m.group(1)
        seg = clue_text[m.end(): m.end() + 400]
        body = re.split(r"^#{3,4}\s*[ABC]\d{1,3}", seg, flags=re.M)[0].strip()
        body = re.sub(r"\s+", " ", body)[:110]
        entries.append((cid, body, "⚠️" if CONCLUSION.search(body) else ""))
    if not entries:
        for i, m in enumerate(NUM_ITEM.finditer(clue_text), 1):
            seg = clue_text[m.end(): m.end() + 200].split("\n")[0]
            entries.append((f"#{i}", re.sub(r"\s+", " ", seg)[:110],
                            "⚠️" if CONCLUSION.search(seg) else ""))
    for cid, body, mark in entries[:max_clues]:
        A(f"| {cid} | {body} | {mark} |")
    A("")
    A(f"（共 {len(entries)} 条，此处最多列 {max_clues} 条）")
    A("")

    # ---------- 维度四素材 ----------
    A("## 四、唯一锁定 —— 素材")
    A("")
    A("真相里对线索的回扣（供判断「是否只有拿全证据才能定案」）：")
    A("")
    ids_in_truth = sorted(set(re.findall(r"\b([ABC]\d{1,3})\b", truth)))
    A(f"- 真相提到的线索编号：{len(ids_in_truth)} 个 —— {'、'.join(ids_in_truth[:40]) or '（无）'}")
    A(f"- 线索总数：{len(entries)}")
    A("")
    A("**真相原文（截断 2000 字）**")
    A("")
    A("```")
    A(truth.strip()[:2000] if truth.strip() else "（没有找到真相/复盘段）")
    A("```")
    A("")

    A("## 打分表（复制后填写）")
    A("")
    A("| 维度 | 分数 | 依据（线索编号 / 时刻 / 段落） |")
    A("|---|---|---|")
    A("| 一、诡计成立性 | /3 | |")
    A("| 二、误导可证伪性 | /3 | |")
    A("| 三、线索克制 | /3 | |")
    A("| 四、唯一锁定 | /3 | |")
    A("| **合计** | /12 | |")
    A("")

    out = "\n".join(L)
    if "--out" in sys.argv:
        io.open(sys.argv[sys.argv.index("--out") + 1], "w", encoding="utf-8").write(out)
        print(f"已写出评审包（{len(out)} 字符）")
    else:
        print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
