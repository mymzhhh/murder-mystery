# -*- coding: utf-8 -*-
"""量化 A1 语料 v2 —— 只数**源剧本真实具备**的东西。

v1 的教训（2026-10-19，同一个坑踩了三次）：
  我用「地点字段」「开场白」「img:」这些**我方流水线的产物**去数源剧本，结果全是 0。
  源剧本的真实情况：
    · 没有结构化"地点"字段 —— 线索是按**人物**分组的（"唐·何塞 1. … 2. …"）
    · 没有"开场白"标题 —— DM 开场就是手册里的一段散文
    · 没有图片引用 —— 图片是独立的 jpg 文件，正文里不写
  另外 `\\bAP\\b` 在中文旁不生效（中文算 word char），导致 344 的「11点AP」漏检。
  → 指标必须只数"源文本里客观存在"的模式，并且每个指标都报**覆盖率**。
"""
import csv
import io
import os
import re
import sys
import statistics

DIR = r"C:\cluade code\ppt\text-gen-agent\data\corpus\a1"
if "--dir" in sys.argv:
    _i = sys.argv.index("--dir")
    if _i + 1 < len(sys.argv):
        DIR = sys.argv[_i + 1]
OUT_CSV = os.path.join(DIR, "_metrics.csv")
CENSUS_CSV = r"C:\cluade code\ppt\text-gen-agent\docs\剧本语料-合格清单.csv"

ACT_RE = re.compile(r"【第\s*([一二三四五六七八九十\d]+)\s*幕")
TIME_RE = re.compile(r"(\d{1,2}\s*[:：]\s*\d{2})|(\d{1,2}\s*点\s*(半|\d{1,2}\s*分)?)|([上下]午\s*\d{1,2}\s*点)")
NUM_ITEM = re.compile(r"^\s*(\d{1,3})\s*[.、)]\s*\S", re.M)
ROUND_RE = re.compile(r"第\s*([一二三四五六七八九十\d]+)\s*轮")
HIDDEN_RE = re.compile(r"发现隐藏线索|深入调查|隐藏线索|隐藏剧情|支线线索|特殊线索|可深挖")
# AP：中文紧邻时 \b 不生效，改用 ASCII 边界
AP_RE = re.compile(r"(?<![A-Za-z])AP(?![A-Za-z])|行动点|搜证次数|搜查次数")

MANUAL_KW = ("手册", "组织者", "主持人", "游戏说明", "规则", "公共信息", "背景")
CLUE_KW = ("线索", "证据")
TRUTH_KW = ("真相", "复盘", "解析", "答案", "供词")


def classify(name):
    if any(k in name for k in TRUTH_KW):
        return "truth"
    if any(k in name for k in CLUE_KW):
        return "clue"
    if any(k in name for k in MANUAL_KW):
        return "manual"
    return "role"


def split_sections(md):
    parts = re.split(r"^## 文件：(.+)$", md, flags=re.M)
    return [(parts[i].strip(), parts[i + 1] if i + 1 < len(parts) else "")
            for i in range(1, len(parts), 2)]


def chars_of(s):
    return len(re.sub(r"\s+", "", s))


def clue_groups(clue_text):
    """线索按**人物/场所**分组：短标题行（无编号）后面紧跟编号条目。
    返回分组名列表。这是源剧本最普遍的组织方式。"""
    lines = [l.strip() for l in clue_text.split("\n")]
    groups = []
    for i, l in enumerate(lines[:-1]):
        if not l or len(l) > 14:
            continue
        if NUM_ITEM.match(l) or l.startswith("|"):
            continue
        # 下一非空行是编号条目 → 本行是分组标题
        j = i + 1
        while j < len(lines) and not lines[j]:
            j += 1
        if j < len(lines) and NUM_ITEM.match(lines[j]):
            groups.append(l)
    return groups


def manual_truth_chars(manual):
    """手册里"真相/复盘/解析"之后的部分算作真相篇幅（很多本没有独立真相文件）"""
    if not manual:
        return 0
    m = None
    for kw in ("真相", "复盘", "案件解析", "解析"):
        m = re.search(r"^[^\n]{0,20}" + kw + r"[^\n]*$", manual, flags=re.M)
        if m:
            break
    if not m:
        return 0
    return chars_of(manual[m.start():])

def main():
    # 语料普查里的图片数，按标题 join 进来（源剧本的图片是独立文件）
    img_map = {}
    try:
        for r in csv.DictReader(io.open(CENSUS_CSV, encoding="utf-8-sig")):
            img_map[r["标题"]] = int(r["图片"] or 0)
    except FileNotFoundError:
        pass

    rows = []
    for fn in sorted(f for f in os.listdir(DIR) if f.endswith(".md")):
        md = io.open(os.path.join(DIR, fn), encoding="utf-8").read()
        title = fn[:-3]
        secs = split_sections(md)
        if not secs:
            continue

        role = [t for n, t in secs if classify(n) == "role"]
        clue = [t for n, t in secs if classify(n) == "clue"]
        truth = [t for n, t in secs if classify(n) == "truth"]
        manual = "".join(t for n, t in secs if classify(n) == "manual")

        role_lens = sorted((chars_of(t) for t in role), reverse=True)
        acts = set()
        for t in role:
            acts.update(ACT_RE.findall(t))
        timeline_lines = sum(len(TIME_RE.findall(t)) for t in role)

        clue_text = "\n".join(clue)
        groups = clue_groups(clue_text)

        # 手册首段（DM 开场通常就是第一段散文）
        first_para = 0
        for para in re.split(r"\n\s*\n", manual):
            if chars_of(para) >= 60:
                first_para = chars_of(para)
                break

        rows.append({
            "剧本": title,
            "总字数": chars_of(md),
            "文件数": len(secs),
            "角色本数": len(role),
            "角色本总字": sum(role_lens),
            "角色本中位": int(statistics.median(role_lens)) if role_lens else 0,
            "角色本最长": role_lens[0] if role_lens else 0,
            "角色本最短": role_lens[-1] if role_lens else 0,
            "分幕数": len(acts),
            "时间线时刻数": timeline_lines,
            "线索条数": len(NUM_ITEM.findall(clue_text)),
            # 线索段落数：散文式线索文档没有 1./2. 编号，用"有实体内容的段落数"当条目数代理
            "线索段落数": len([p for p in re.split(r"\n\s*\n", clue_text) if len(re.sub(r"\s+", "", p)) >= 12]),
            "线索分组数": len(groups),
            "线索轮数": len(set(ROUND_RE.findall(clue_text))),
            "线索字数": chars_of(clue_text),
            "隐藏线索标记": len(HIDDEN_RE.findall(clue_text + "\\n" + "\\n".join(role))),
            # 真相：优先独立文件；很多本没有独立"真相.docx"，真相写在手册里
            # → 回退成"手册里从「真相/复盘/解析」那一行开始到结尾"的字数
            "真相字数": max(
                max((chars_of(t) for t in truth), default=0),
                manual_truth_chars(manual),
            ),
            "手册字数": chars_of(manual),
            "手册首段字数": first_para,
            "有AP规则": 1 if AP_RE.search(manual + clue_text) else 0,
            "图片文件数": img_map.get(title, 0),
        })

    with io.open(OUT_CSV, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    print(f"量化完成 {len(rows)} 本 → {OUT_CSV}\n")
    keys = ["总字数", "角色本数", "角色本中位", "角色本最长", "分幕数", "时间线时刻数",
            "线索条数", "线索段落数", "线索分组数", "线索轮数", "线索字数", "隐藏线索标记",
            "真相字数", "手册字数", "手册首段字数", "图片文件数"]
    print(f"{'指标':<14}{'有值':>5}{'最小':>8}{'中位':>8}{'最大':>8}")
    print("-" * 45)
    for k in keys:
        vals = [int(r[k]) for r in rows]
        nz = [v for v in vals if v > 0]
        print(f"{k:<14}{len(nz):>5}{min(vals):>8}{int(statistics.median(vals)):>8}{max(vals):>8}")
    print(f"\n{'有AP规则':<14} 命中 {sum(int(r['有AP规则']) for r in rows)}/{len(rows)}")

    for r in rows:
        if r["剧本"].startswith("344"):
            print("\n=== 基线 344 ===")
            for k, v in r.items():
                print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
