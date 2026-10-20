# -*- coding: utf-8 -*-
"""把 A1 档的剧本 docx 抽成统一 markdown（蒸馏语料）。

产物落在 data/corpus/a1/（gitignored —— 第三方剧本原件不进仓库）。

设计要点：
1. **保留原文顺序与层级**：每个 docx 变成 `## 文件：<名字>` 一节，段落按原序输出，
   表格转成 markdown 表格。蒸馏要看的是"作者怎么组织内容"，所以不能打乱。
2. **文件排序有意义**：主持人手册 → 角色本（按文件名）→ 线索 → 真相 → 其他。
   这样人读和程序读都符合剧本的自然顺序。
3. **同时产出 manifest.json**：记录每个文件的字数，方便后续量化时核对。
"""
import csv
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROOT = r"D:\play game\剧本杀剧本资源合集"
CSV = r"C:\cluade code\ppt\text-gen-agent\docs\剧本语料-合格清单.csv"
DUP_CSV = r"C:\cluade code\ppt\text-gen-agent\docs\剧本语料-重复本.csv"
OUT_DIR = r"C:\cluade code\ppt\text-gen-agent\data\corpus\a1"

ORDER_KW = [
    ("公共信息", 0), ("背景", 1), ("主持人", 2), ("组织者", 3), ("手册", 4), ("游戏说明", 5),
    ("角色", 20), ("人物剧本", 21), ("剧本", 22),
    # 线索/真相排在角色本之后：读本时先看"玩家拿到什么"，再看"公开了什么证据"
    ("线索", 70), ("证据", 71), ("供词", 75),
    ("真相", 80), ("复盘", 81), ("解析", 82), ("答案", 83),
]


def safe_name(s):
    s = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:80]


def docx_to_md(path):
    """返回 markdown 文本（段落 + 表格，保留顺序）"""
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    d = docx.Document(path)
    out = []
    body = d.element.body
    for child in body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            p = Paragraph(child, d)
            t = p.text.rstrip()
            if not t:
                continue
            style = (p.style.name or "").lower()
            if "heading 1" in style or "标题 1" in style:
                out.append("#### " + t)
            elif "heading 2" in style or "标题 2" in style:
                out.append("##### " + t)
            else:
                out.append(t)
        elif tag == "tbl":
            tb = Table(child, d)
            rows = []
            for r in tb.rows:
                cells = [c.text.replace("\n", " ").strip() for c in r.cells]
                rows.append("| " + " | ".join(cells) + " |")
            if rows:
                out.append("")
                out.extend(rows)
                out.append("")
    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text, len(re.sub(r"\s+", "", text))


def order_key(fname):
    stem = os.path.splitext(os.path.basename(fname))[0]
    best = 50
    for kw, w in ORDER_KW:
        if kw in stem:
            best = min(best, w)
    return (best, stem)


def main():
    rows = list(csv.DictReader(io.open(CSV, encoding="utf-8-sig")))
    skip = set()
    try:
        for d in csv.DictReader(io.open(DUP_CSV, encoding="utf-8-sig")):
            if d["建议"].startswith("重复"):
                skip.add(d["剧本"])
    except FileNotFoundError:
        pass

    targets = [
        r for r in rows
        if r["档位"] == "A" and int(r["线索文件字数"] or 0) > 0 and r["标题"] not in skip
    ]
    print(f"A1 目标: {len(targets)} 个")

    os.makedirs(OUT_DIR, exist_ok=True)
    manifest = []

    for idx, r in enumerate(targets, 1):
        title = r["标题"]
        d = os.path.join(ROOT, r["分组"], title)
        if not os.path.isdir(d):
            print(f"  ! 目录不存在: {title}")
            continue

        docx_files = []
        for dp, _dn, fn in os.walk(d):
            if "__MACOSX" in dp:
                continue
            for f in fn:
                if f.lower().endswith(".docx") and not f.startswith("~$"):
                    docx_files.append(os.path.join(dp, f))
        if not docx_files:
            print(f"  ! 无 docx: {title}")
            continue
        docx_files.sort(key=order_key)

        parts = [f"# 剧本：{title}", ""]
        files_meta = []
        for p in docx_files:
            stem = os.path.splitext(os.path.basename(p))[0]
            try:
                md, chars = docx_to_md(p)
            except Exception as e:
                print(f"  ! 解析失败 {stem}: {e}")
                continue
            if not chars:
                continue
            parts.append(f"## 文件：{stem}")
            parts.append("")
            parts.append(md)
            parts.append("")
            files_meta.append({"file": stem, "chars": chars})

        body = "\n".join(parts)
        total = len(re.sub(r"\s+", "", body))
        out_path = os.path.join(OUT_DIR, safe_name(title) + ".md")
        io.open(out_path, "w", encoding="utf-8").write(body)

        manifest.append({
            "title": title,
            "path": out_path,
            "chars": total,
            "files": files_meta,
            "tier": "A1",
        })
        print(f"  [{idx}/{len(targets)}] {title[:30]:<32} {len(files_meta)} 文件 {total} 字")

    io.open(os.path.join(OUT_DIR, "_manifest.json"), "w", encoding="utf-8").write(
        json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"\n完成 {len(manifest)} 本 → {OUT_DIR}")
    tot = sum(m["chars"] for m in manifest)
    print(f"合计 {tot} 字（平均 {tot // max(1, len(manifest))} 字/本）")


if __name__ == "__main__":
    main()
