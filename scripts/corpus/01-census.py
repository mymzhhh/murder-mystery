# -*- coding: utf-8 -*-
"""剧本语料普查 v2 —— 给合集里的每个剧本打分分档，产出「合格清单」。

v1 的教训（2026-10-19 实测）：我原来用"A1/B1 线索编号"当质量信号，结果全是 0。
查了 344 的源 docx 才发现：**源剧本里没有编号** —— 344 的《线索.docx》是按人物分组的
"1. 2. 3." 列表，`A1` 是我自己的导入脚本编出来的。所以判据必须换成语料本身具备的信号：

  ① 角色本文件数与中位字数（最硬的信号：真本 344 是 4 个角色本、中位 5900 字）
  ② 线索条目数（《线索.docx》里的 "1." "2." 行数、"（发现隐藏线索" 出现次数）
  ③ 是否有 组织者/主持人/DM 手册
  ④ 是否有 真相/复盘/案件解析（决定能不能做"真相复盘"对标）
  ⑤ 角色本是否分幕（【第一幕】这类标记）—— 决定能不能做分幕解锁

分档：
  A  docx 文本本（可直接精确统计）
  B  文本型 PDF（能抽中文）
  C  扫描 PDF（需 OCR）
  D  纯图片（需 OCR，多半是线索卡碎片）
  X  不合格（缺角色本/英文/空目录/压缩包）

用法：python census.py
输出：docs/剧本语料-合格清单.csv  +  屏幕摘要
"""
import csv
import io
import os
import re
import statistics
import sys
from collections import Counter

ROOT = r"D:\play game\剧本杀剧本资源合集"
ROOTS = ["_文本型剧本（86个）", "_精筛_中位3000+线索（8个）", "剧本杀剧本资源合集"]
OUT_CSV = r"C:\cluade code\ppt\text-gen-agent\docs\剧本语料-合格清单.csv"

CJK = re.compile(r"[\u4e00-\u9fff]")

# 非角色本的 docx（按文件名排除）
NON_ROLE = ("线索", "真相", "复盘", "解析", "组织者", "主持人", "手册", "游戏说明", "说明",
            "规则", "背景", "结局", "答案", "投票", "幕", "序", "目录", "封面", "封面图")
DM_KW = ("组织者", "主持人", "dm", "手册", "游戏说明")
TRUTH_KW = ("真相", "复盘", "解析", "答案")
CLUE_KW = ("线索", "证据")

ACT_RE = re.compile(r"【第[一二三四五六七八九十\d]+幕")
HIDDEN_RE = re.compile(r"发现隐藏线索")
NUM_LINE = re.compile(r"^\s*(\d{1,3})\s*[.、)]\s*\S", re.M)


def read_docx(path):
    try:
        import docx
        d = docx.Document(path)
        parts = [p.text for p in d.paragraphs if p.text]
        for t in d.tables:
            for row in t.rows:
                for cell in row.cells:
                    if cell.text:
                        parts.append(cell.text)
        text = "\n".join(parts)
        return len(re.sub(r"\s+", "", text)), text
    except Exception:
        return 0, ""


def read_pdf_head(path, max_pages=2, size_limit=80 * 1024 * 1024):
    try:
        if os.path.getsize(path) > size_limit:
            return None, 0
        from pypdf import PdfReader
        r = PdfReader(path)
        pages = len(r.pages)
        cjk = 0
        for i in range(min(max_pages, pages)):
            try:
                cjk += len(CJK.findall(r.pages[i].extract_text() or ""))
            except Exception:
                pass
        return pages, cjk
    except Exception:
        return None, 0


def roles_from_name(name):
    m = re.search(r"(\d+)\s*(?:[_-]\s*(\d+))?\s*人", name)
    if not m:
        return None
    lo = int(m.group(1))
    hi = int(m.group(2)) if m.group(2) else lo
    return lo, hi


def is_role_file(basename):
    stem = os.path.splitext(basename)[0]
    low = stem.lower()
    if any(k in stem for k in NON_ROLE):
        return False
    if re.fullmatch(r"[\d\s\-_]+", stem):      # 纯数字文件名（001.pdf 之类）
        return False
    return True


def main():
    scripts = []
    for r in ROOTS:
        base = os.path.join(ROOT, r)
        if not os.path.isdir(base):
            continue
        for entry in sorted(os.listdir(base)):
            scripts.append({"root": r, "name": entry, "path": os.path.join(base, entry)})
    print(f"顶层剧本条目: {len(scripts)}")

    rows = []
    for idx, s in enumerate(scripts, 1):
        name = s["name"]
        row = {
            "档位": "", "评分": 0, "标题": name, "分组": s["root"], "角色数": "",
            "角色本数": 0, "角色本中位字数": 0, "角色本最长字数": 0,
            "线索条目数": 0, "隐藏线索标记": 0, "有分幕": 0,
            "有DM手册": 0, "有真相解析": 0,
            "docx": 0, "doc": 0, "txt": 0, "pdf": 0, "图片": 0, "音视频": 0, "总MB": 0,
            "pdf页数": 0, "pdf可抽中文": 0, "判定理由": "",
        }
        roles = roles_from_name(name)
        row["角色数"] = f"{roles[0]}-{roles[1]}" if roles else ""

        if not os.path.isdir(s["path"]):
            row["档位"] = "X"
            row["判定理由"] = "压缩包（未展开）"
            rows.append(row)
            continue

        files = []
        for dp, _dn, fn in os.walk(s["path"]):
            if "__MACOSX" in dp:
                continue
            for f in fn:
                fp = os.path.join(dp, f)
                try:
                    files.append((fp, os.path.getsize(fp), os.path.splitext(f)[1].lower()))
                except OSError:
                    pass
        if not files:
            row["档位"] = "X"
            row["判定理由"] = "空目录"
            rows.append(row)
            continue

        ec = Counter(e for _f, _sz, e in files)
        row["docx"], row["doc"], row["txt"] = ec.get(".docx", 0), ec.get(".doc", 0), ec.get(".txt", 0)
        row["pdf"] = ec.get(".pdf", 0)
        row["图片"] = sum(ec.get(e, 0) for e in (".jpg", ".jpeg", ".png", ".bmp", ".webp"))
        row["音视频"] = sum(ec.get(e, 0) for e in (".mp3", ".wav", ".m4a", ".mp4"))
        row["总MB"] = round(sum(sz for _f, sz, _e in files) / 1024 / 1024, 1)

        names_all = [os.path.basename(f) for f, _sz, _e in files]
        row["有DM手册"] = int(any(any(k in n.lower() for k in DM_KW) for n in names_all))
        row["有真相解析"] = int(any(any(k in n for k in TRUTH_KW) for n in names_all))

        # ---- docx 统计 ----
        role_lens = []
        clue_items = 0
        hidden_marks = 0
        has_act = 0
        docx_files = [(f, n) for f, _sz, e in [(f, sz, e) for f, sz, e in files if e == ".docx"] for n in [None]]
        docx_paths = [f for f, _sz, e in files if e == ".docx"]
        for f in docx_paths[:40]:
            n, text = read_docx(f)
            if not n:
                continue
            base = os.path.basename(f)
            if any(k in base for k in CLUE_KW):
                clue_items += len(NUM_LINE.findall(text))
                hidden_marks += len(HIDDEN_RE.findall(text))
            if ACT_RE.search(text):
                has_act = 1
            if is_role_file(base) and n >= 1500:
                role_lens.append(n)
        role_lens.sort(reverse=True)
        row["角色本数"] = len(role_lens)
        if role_lens:
            row["角色本最长字数"] = role_lens[0]
            row["角色本中位字数"] = int(statistics.median(role_lens))
        row["线索条目数"] = clue_items
        row["隐藏线索标记"] = hidden_marks
        row["有分幕"] = has_act

        # ---- pdf 统计 ----
        pdf_paths = [f for f, _sz, e in files if e == ".pdf"]
        if pdf_paths:
            pages = 0
            cjk = 0
            for f in pdf_paths[:12]:
                pg, c = read_pdf_head(f)
                pages += pg or 0
                cjk += c
            row["pdf页数"] = pages
            row["pdf可抽中文"] = int(cjk > 200)

        # ================= 判定 =================
        score = 0
        why = []

        if row["docx"] > 0 and (role_lens or row["有真相解析"]):
            row["档位"] = "A"
            score += 30
            why.append(f"docx 文本（{row['docx']} 个文件）")
            if row["角色本数"] >= 3:
                score += 20
                why.append(f"角色本 {row['角色本数']} 份")
            if row["角色本中位字数"] >= 3000:
                score += 20
                why.append(f"角色本中位 {row['角色本中位字数']} 字")
            elif row["角色本中位字数"] >= 2000:
                score += 10
                why.append(f"角色本偏薄（中位 {row['角色本中位字数']} 字）")
            if row["线索条目数"] >= 25:
                score += 10
                why.append(f"线索 {row['线索条目数']} 条")
            if row["有DM手册"]:
                score += 8
                why.append("有 DM 手册")
            if row["有真相解析"]:
                score += 8
                why.append("有真相解析")
            if row["有分幕"]:
                score += 4
                why.append("分幕本")
        elif row["pdf"] > 0 and row["pdf可抽中文"]:
            row["档位"] = "B"
            score += 20
            why.append(f"文本型 PDF（{row['pdf页数']} 页可抽中文）")
            if row["pdf页数"] >= 20:
                score += 10
                why.append("页数充足")
        elif row["pdf"] > 0:
            row["档位"] = "C"
            score += 8
            why.append(f"扫描 PDF（{row['pdf页数']} 页，需 OCR）")
        elif row["图片"] > 0:
            row["档位"] = "D"
            score += 3
            why.append(f"纯图片 {row['图片']} 张（需 OCR）")
        else:
            row["档位"] = "X"
            why.append("没有可用于提取正文的文件")

        if row["doc"] or row["txt"]:
            score += 4
            why.append(f"另有 doc/txt {row['doc'] + row['txt']} 个")
        if roles:
            if 4 <= roles[1] <= 6:
                score += 8
                why.append(f"角色 {row['角色数']}（引擎适用）")
            elif roles[1] > 6:
                score -= 5
                why.append(f"角色 {row['角色数']} 超引擎上限 6")
        if "英文" in name:
            row["档位"] = "X"
            score = 0
            why = ["英文剧本，不适合中文语料"]

        row["评分"] = score
        row["判定理由"] = "；".join(why)
        rows.append(row)
        if idx % 25 == 0:
            print(f"  ...{idx}/{len(scripts)}")

    order = {"A": 0, "B": 1, "C": 2, "D": 3, "X": 4}
    rows.sort(key=lambda r: (order.get(r["档位"], 9), -r["评分"], r["标题"]))
    for i, r in enumerate(rows, 1):
        r["序号"] = i

    cols = ["序号"] + [k for k in rows[0].keys() if k != "序号"]
    os.makedirs(os.path.dirname(OUT_CSV), exist_ok=True)
    with io.open(OUT_CSV, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)

    tc = Counter(r["档位"] for r in rows)
    print("\n=== 分档统计 ===")
    for t in ("A", "B", "C", "D", "X"):
        print(f"  {t}: {tc.get(t, 0)}")
    print(f"\n清单已写出: {OUT_CSV}")

    for t, label in (("A", "A 档（文本可精确统计）前 20"), ("B", "B 档（文本型 PDF）前 10")):
        sub = [x for x in rows if x["档位"] == t][:20 if t == "A" else 10]
        print(f"\n=== {label} ===")
        print(f"  {'评':>3}  {'标题':<30} {'角色本':>3} {'中位字':>6} {'线索':>4} {'分幕':>2} {'手册':>2} {'真相':>2}")
        for r in sub:
            print(f"  {r['评分']:>3}  {r['标题'][:28]:<30} {r['角色本数']:>3} {r['角色本中位字数']:>6} "
                  f"{r['线索条目数']:>4} {'是' if r['有分幕'] else '—':>2} {'是' if r['有DM手册'] else '—':>2} {'是' if r['有真相解析'] else '—':>2}")


if __name__ == "__main__":
    main()
