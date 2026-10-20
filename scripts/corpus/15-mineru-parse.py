# -*- coding: utf-8 -*-
"""用本地 MinerU 解析 B 档（文本型 PDF）剧本，产出统一 markdown。

API 要点（2026-10-20 实测）：
  · 端点 POST http://127.0.0.1:8000/v1/file_parse
  · **只能带 files 字段** —— 多带 tier/output_formats 会报
    "Too many fields. Maximum number of fields is 0"
  · 一次最多 100 个文件；返回 JSON（job 或直接结果），需按实际结构取 markdown

用法：
  python 15-mineru-parse.py --limit 1        # 先试一本
  python 15-mineru-parse.py                  # 全部 B 档
"""
import csv
import io
import json
import os
import sys
import time
import zipfile

import requests

ROOT = r"D:\play game\剧本杀剧本资源合集"
CSV = r"C:\cluade code\ppt\text-gen-agent\docs\剧本语料-合格清单.csv"
DUP_CSV = r"C:\cluade code\ppt\text-gen-agent\docs\剧本语料-重复本.csv"
OUT_DIR = r"C:\cluade code\ppt\text-gen-agent\data\corpus\b"
API = "http://127.0.0.1:8000"

MAX_PDF_PER_SCRIPT = 8           # 单本最多提交几个 PDF（实测 14 个 × 60MB 串行解析会卡十几分钟）
MAX_MB_PER_PDF = 25              # 超大 PDF（多半是扫描件）跳过，那是 C 档的事


def safe_name(s):
    import re
    s = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", s)
    return re.sub(r"\s+", " ", s).strip()[:80]


def load_targets():
    rows = list(csv.DictReader(io.open(CSV, encoding="utf-8-sig")))
    skip = set()
    try:
        for d in csv.DictReader(io.open(DUP_CSV, encoding="utf-8-sig")):
            if d["建议"].startswith("重复"):
                skip.add(d["剧本"])
    except FileNotFoundError:
        pass
    return [r for r in rows if r["档位"] == "B" and r["标题"] not in skip]


def pdf_pages(p):
    try:
        from pypdf import PdfReader
        return len(PdfReader(p).pages)
    except Exception:
        return 999

def collect_pdfs(script_dir):
    out = []
    for dp, _dn, fn in os.walk(script_dir):
        if "__MACOSX" in dp:
            continue
        for f in fn:
            if f.lower().endswith(".pdf"):
                p = os.path.join(dp, f)
                try:
                    mb = os.path.getsize(p) / 1024 / 1024
                except OSError:
                    continue
                if mb > MAX_MB_PER_PDF:
                    continue
                # 页数上限：实测一本 305-空A1774 的 PDF 让服务端单次请求跑了 25 分钟还没完，
                # 直接把整批堵死。超过 40 页的先跳过（那是"整本扫描"的形态，属 C 档）。
                if pdf_pages(p) > 40:
                    continue
                out.append((p, mb))
    # 大文件优先（通常是完整角色本/手册），但控制在 MAX_PDF_PER_SCRIPT 个
    out.sort(key=lambda x: -x[1])
    return [p for p, _mb in out[:MAX_PDF_PER_SCRIPT]]


def parse_files(paths):
    """一次提交一批 PDF，返回 markdown 文本"""
    files = []
    handles = []
    try:
        for p in paths:
            fh = open(p, "rb")
            handles.append(fh)
            files.append(("files", (os.path.basename(p), fh, "application/pdf")))
        r = requests.post(f"{API}/v1/file_parse", files=files, timeout=420)
        r.raise_for_status()
        ct = r.headers.get("content-type", "")
        if "application/json" not in ct:
            return None, f"非 JSON 响应: {ct} 前 200 字: {r.content[:200]!r}"
        data = r.json()
        return data, None
    finally:
        for fh in handles:
            fh.close()


def strip_base64(md):
    """去掉 `![](data:image/...;base64,...)` 这类内嵌图片（体积巨大且对文本统计无用）"""
    import re
    md = re.sub(r"!\[[^\]]*\]\(data:[^)]{0,2000000}\)", "", md)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md


def poll_until_done(data, timeout_s=900):
    """大文件会返回 {status: queued, result_url/status_url} —— 必须轮询到 completed 再取结果。"""
    if not isinstance(data, dict):
        return data
    if str(data.get("status")) == "completed":
        return data
    result_url = data.get("result_url") or data.get("status_url")
    if not result_url:
        return data
    if result_url.startswith("/"):
        result_url = API + result_url
    t0 = time.time()
    last = data
    while time.time() - t0 < timeout_s:
        time.sleep(5)
        try:
            r = requests.get(result_url, timeout=120)
            r.raise_for_status()
            cur = r.json()
        except Exception:
            continue
        last = cur
        st = str(cur.get("status") or "")
        if st == "completed":
            return cur
        if st in ("failed", "error"):
            return cur
    return last


def extract_markdown(data, tmpdir):
    """从 API 响应里取出 markdown。

    实测（2026-10-20）响应结构：
      {status, progress, files: [{file_id, name, status, parse, output_files, content:
        {markdown: "...", ...}}]}
    markdown 直接内嵌在 files[i].content.markdown 里（一个 10 页手册约 450KB，含 base64 图）。
    """
    if not isinstance(data, dict):
        return ""
    parts = []
    for f in (data.get("files") or []):
        md = ""
        c = f.get("content")
        if isinstance(c, dict):
            md = c.get("markdown") or ""
        elif isinstance(c, str):
            md = c
        if not md:
            continue
        name = os.path.splitext(str(f.get("name") or ""))[0] or "未命名"
        parts.append(f"## 文件：{name}\n\n{strip_base64(md)}\n")
    if parts:
        return "\n".join(parts)
    # 兜底：顶层直接给文本
    for k in ("markdown", "md", "content"):
        if isinstance(data.get(k), str) and len(data[k]) > 50:
            return strip_base64(data[k])
    return ""

def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    targets = load_targets()
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"B 档目标: {len(targets)} 本")

    for i, r in enumerate(targets, 1):
        title = r["标题"]
        out_path = os.path.join(OUT_DIR, safe_name(title) + ".md")
        if os.path.exists(out_path) and os.path.getsize(out_path) > 2000:
            print(f"  [{i}/{len(targets)}] 跳过（已存在）{title[:28]}")
            continue
        d = os.path.join(ROOT, r["分组"], title)
        if not os.path.isdir(d):
            print(f"  [{i}] 目录不存在: {title}")
            continue
        pdfs = collect_pdfs(d)
        if not pdfs:
            print(f"  [{i}] 没有可用 PDF: {title}")
            continue
        t0 = time.time()
        try:
            data, err = parse_files(pdfs)
        except Exception as e:
            print(f"  [{i}] ✗ 请求失败 {title[:26]}: {e}")
            continue
        if err:
            print(f"  [{i}] ✗ {title[:26]}: {err}")
            continue
        data = poll_until_done(data)
        md = extract_markdown(data, OUT_DIR)
        if not md:
            snippet = json.dumps(data, ensure_ascii=False)[:300]
            print(f"  [{i}] ✗ 没取到 markdown {title[:26]}｜响应: {snippet}")
            if limit and i >= limit:
                break
            continue
        io.open(out_path, "w", encoding="utf-8").write(md)
        print(f"  [{i}/{len(targets)}] {title[:28]:<30} {len(pdfs)} PDF → {len(md)} 字 "
              f"（{time.time() - t0:.0f}s）")
        if limit and i >= limit:
            break


if __name__ == "__main__":
    main()
