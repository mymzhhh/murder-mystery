# -*- coding: utf-8 -*-
"""补齐 A2 的线索文本：从 docx / 小 PDF 里取，不用 OCR。

2026-10-20 实测：A2 的线索材料有四种形态，我第一版只认了第四种：
  ① 名为「搜证.docx」「公开线索.docx」的 docx   ← 关键词漏了"搜证/公开线索/道具"
  ② 名字随意的 PDF（"争吵.pdf""江国虎符.pdf"）   ← 每张线索卡一个 PDF
  ③ 名为「线索」的子目录里放 1.jpg 2.jpg        ← 已在 17 脚本里处理
  ④ 文件名含"线索/证据"的图片                    ← 17 脚本处理

本脚本处理 ①②：把检测到的线索类 docx 直接抽文本；线索类 PDF 记录到清单，
交回给 MinerU 批处理（它们通常只有 1–5 页，很快）。

用法：python 18-extract-a2-clue-docx.py
"""
import csv
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _census_lib import read_docx  # 复用 docx 读取（段落 + 表格）

ROOT = r"D:\play game\剧本杀剧本资源合集"
A2_DIR = r"C:\cluade code\ppt\text-gen-agent\data\corpus\a2"
CSV = r"C:\cluade code\ppt\text-gen-agent\docs\剧本语料-合格清单.csv"

# 线索类关键词（比第一版宽 —— 漏了"搜证"就漏掉整类剧本）
CLUE_KW = re.compile(r"线索|证据|搜证|公开线索|线索卡|道具|物品")
# 排除：剧本/手册/真相 这类非线索文件
NOT_CLUE = re.compile(r"人物剧本|个人剧本|角色|剧本\.|手册|组织者|主持人|规则|说明|真相|复盘|解析|答案|背景|封面")

HEAD = "## 文件：线索（docx/PDF 直取）"


def safe_name(s):
    s = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", s)
    return re.sub(r"\s+", " ", s).strip()[:80]


def resolve_dir(group, title):
    p = os.path.join(ROOT, group, title)
    if os.path.isdir(p):
        return p
    m = re.match(r"^(\d{2,3})", title)
    if not m:
        return None
    pre = m.group(1)
    for g in os.listdir(ROOT):
        base = os.path.join(ROOT, g)
        if not os.path.isdir(base):
            continue
        for e in os.listdir(base):
            if e.startswith(pre + "-") or e.startswith(pre + " ") or e.startswith(pre + "."):
                q = os.path.join(base, e)
                if os.path.isdir(q):
                    return q
    return None


def main():
    rows = list(csv.DictReader(io.open(CSV, encoding="utf-8-sig")))
    targets = [r for r in rows if r["档位"] == "A" and int(r["线索文件字数"] or 0) == 0]
    print(f"A2 目标: {len(targets)} 本")

    total_docx = 0
    pdf_report = []
    for i, r in enumerate(targets, 1):
        title = r["标题"]
        md_path = os.path.join(A2_DIR, safe_name(title) + ".md")
        if not os.path.exists(md_path):
            continue
        body = io.open(md_path, encoding="utf-8").read()
        if HEAD in body:
            continue
        d = resolve_dir(r["分组"], title)
        if not d:
            continue

        docx_hits, pdf_hits = [], []
        for dp, _dn, fn in os.walk(d):
            if "__MACOSX" in dp:
                continue
            for f in fn:
                stem, ext = os.path.splitext(f)
                if not CLUE_KW.search(f) or NOT_CLUE.search(f):
                    continue
                p = os.path.join(dp, f)
                if ext.lower() == ".docx":
                    docx_hits.append(p)
                elif ext.lower() == ".pdf":
                    try:
                        if os.path.getsize(p) / 1048576 <= 25:
                            pdf_hits.append(p)
                    except OSError:
                        pass

        chunk = [HEAD, ""]
        for p in sorted(docx_hits)[:12]:
            n, text = read_docx(p)
            if n < 30:
                continue
            chunk.append(f"### {os.path.splitext(os.path.basename(p))[0]}")
            chunk.append("")
            chunk.append(text.strip())
            chunk.append("")
            total_docx += 1
        if len("\n".join(chunk)) > 120:
            io.open(md_path, "w", encoding="utf-8").write(body.rstrip() + "\n\n" + "\n".join(chunk))
            chars = len(re.sub(r"\s+", "", "\n".join(chunk)))
            print(f"  [{i}/{len(targets)}] {title[:28]:<30} docx {len(docx_hits)} 个 → {chars} 字")
        if pdf_hits:
            pdf_report.append((title, len(pdf_hits), pdf_hits[:3]))

    print(f"\ndocx 线索文件共抽取 {total_docx} 个")
    if pdf_report:
        print(f"\n还有 {len(pdf_report)} 本的线索是 PDF（共 "
              f"{sum(x[1] for x in pdf_report)} 个文件），需要走 MinerU：")
        for title, n, sample in pdf_report[:15]:
            print(f"  · {title[:30]}  {n} 个 PDF，例如 {os.path.basename(sample[0])}")


if __name__ == "__main__":
    main()
