# -*- coding: utf-8 -*-
"""把一个"扫描件剧本"（整本全是图片型 PDF）OCR 成统一 markdown，供 11-metrics 量化。

背景（2026-10-20）：
  `出逃连体村（全套）` 这类资源是**排版精美的图片型 PDF** —— 角色本 23 页、线索卡 11 页，
  pypdf 提取出 0 字（无文本层），必须走 MinerU OCR。实测：
    · 线索卡 11 页 → 58s，产出是**编号结构化的信息卡**（1、2、3…），正是我们最缺的样本；
    · 角色本 23 页 → 92s，产出是第一人称剧情文本（含"你的回忆/晚宴/小剧场"等真实分节）。
  而 DM 手册往往**有文本层**（151 页 / 71.6k 字），不需要 OCR —— 先用 pypdf 抽，省时间。

用法：
    python 19-ocr-scanned-script.py --dir "<剧本目录>" --out data/corpus/<tier>/<名字>.md
"""
import argparse
import io
import os
import re
import sys
import time

import requests

try:
    from pypdf import PdfReader
except ImportError:
    from PyPDF2 import PdfReader

API = "http://127.0.0.1:8000"
POLL_SEC = 5
POLL_MAX = 360        # 最多等 30 分钟/文件
MAX_MB = 40


def strip_base64(md):
    # ⚠️ 不要给 base64 正则设长度上限：366 那本曾因上限漏剥，写出 2600 万字
    return re.sub(r"data:image/[^;]+;base64,[A-Za-z0-9+/=]*", "[图]", md or "")


def pdf_pages(path):
    try:
        return len(PdfReader(path).pages)
    except Exception:
        return 0


def text_layer_chars(path, max_pages=20):
    """前 max_pages 页能抽出多少字（判断有没有文本层）"""
    try:
        r = PdfReader(path)
        total = 0
        for i in range(min(len(r.pages), max_pages)):
            try:
                total += len((r.pages[i].extract_text() or "").strip())
            except Exception:
                pass
        return total
    except Exception:
        return 0


def extract_text_layer(path):
    r = PdfReader(path)
    parts = []
    for i, pg in enumerate(r.pages):
        try:
            t = pg.extract_text() or ""
        except Exception:
            t = ""
        if t.strip():
            parts.append(f"\n\n#### 第 {i+1} 页\n\n{t.strip()}")
    return "".join(parts)


def ocr_pdf(path, log):
    name = os.path.basename(path)
    t0 = time.time()
    with io.open(path, "rb") as fh:
        resp = requests.post(
            f"{API}/v1/file_parse",
            files={"files": (name, fh, "application/pdf")},
            timeout=3600,
        )
    if resp.status_code != 200:
        log(f"  ✗ {name} HTTP {resp.status_code}: {resp.text[:120]}")
        return ""
    j = resp.json()
    if j.get("result_url"):
        url = API + j["result_url"]
        for _ in range(POLL_MAX):
            time.sleep(POLL_SEC)
            try:
                d = requests.get(url, timeout=120).json()
            except Exception:
                continue
            if d.get("files"):
                j = d
                break
    files = j.get("files") or []
    if not files:
        log(f"  ✗ {name} 无结果")
        return ""
    md = (files[0].get("content") or {}).get("markdown", "")
    md = strip_base64(md)
    chars = len(re.sub(r"\s+", "", md))
    log(f"  ✓ {name}: {pdf_pages(path)} 页 → {chars} 字（{time.time()-t0:.0f}s）")
    return md


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="", help="只处理文件名含该关键字的 PDF")
    args = ap.parse_args()

    lines = []

    def log(s):
        print(s, flush=True)
        lines.append(s)

    pdfs = []
    for dp, _dn, fn in os.walk(args.dir):
        for f in sorted(fn):
            if f.lower().endswith(".pdf"):
                pdfs.append(os.path.join(dp, f))
    log(f"共 {len(pdfs)} 个 PDF，目录：{args.dir}")

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    out_chunks = []
    stat = []

    for p in pdfs:
        name = os.path.basename(p)
        if args.only and args.only not in name:
            continue
        size_mb = os.path.getsize(p) / 1048576
        if size_mb > MAX_MB:
            log(f"  - 跳过（{size_mb:.0f}MB 超过上限）: {name}")
            continue
        tl = text_layer_chars(p)
        if tl > 2000:
            txt = extract_text_layer(p)
            chars = len(re.sub(r"\s+", "", txt))
            log(f"  ✓ {name}: 有文本层 → 直接抽取 {chars} 字（省一次 OCR）")
            md = txt
        else:
            md = ocr_pdf(p, log)
        if not md.strip():
            continue
        out_chunks.append(f"\n\n## 文件：{name}\n\n{md.strip()}")
        stat.append((name, len(re.sub(r"\s+", "", md))))

    io.open(args.out, "w", encoding="utf-8").write("".join(out_chunks))
    total = sum(c for _n, c in stat)
    log(f"\n已写出 {args.out}｜{len(stat)} 个文件｜合计 {total} 字")
    for n, c in stat:
        log(f"  · {n}: {c} 字")


if __name__ == "__main__":
    main()
