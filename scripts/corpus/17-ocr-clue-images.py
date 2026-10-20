# -*- coding: utf-8 -*-
"""OCR A2 档的线索卡图片，把文字并进已有的 markdown，补上"线索"维度。

为什么做（2026-10-20）：skill 里最虚的指标是线索相关的 ——
  线索条数只有 8/21 本有值、线索分组 7/21、线索轮数 5/21、
  **隐藏线索标记只有 4/21**（等于没有统计依据）。
A2 的 45 本角色本齐全但线索是图片，OCR 后能把样本从 8 提到 30+。

做法：
  · 每本挑文件名含「线索/证据/线索卡」的图片（没有就跳过，不乱 OCR 角色立绘）；
  · MinerU 一次最多 100 个文件，按批提交；大图会返回 queued，需轮询；
  · OCR 结果以 `## 文件：线索（图片OCR）` 一节追加到 data/corpus/a2/<title>.md 末尾，
    这样 11-metrics.py 会按文件名把它归成线索节，无需改量化脚本。

用法：python 17-ocr-clue-images.py [--limit N]
"""
import csv
import io
import json
import os
import re
import sys
import time

import requests

ROOT = r"D:\play game\剧本杀剧本资源合集"
CSV = r"C:\cluade code\ppt\text-gen-agent\docs\剧本语料-合格清单.csv"
DUP_CSV = r"C:\cluade code\ppt\text-gen-agent\docs\剧本语料-重复本.csv"
A2_DIR = r"C:\cluade code\ppt\text-gen-agent\data\corpus\a2"
API = "http://127.0.0.1:8000"

CLUE_NAME = re.compile(r"线索|证据|线索卡")
MAX_IMAGES = 40          # 单本最多 OCR 几张（够统计线索条数）
MAX_MB = 8               # 超大图先跳过
SECTION_HEAD = "## 文件：线索（图片OCR）"


def safe_name(s):
    s = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", s)
    return re.sub(r"\s+", " ", s).strip()[:80]


def resolve_dir(root_group, title):
    p = os.path.join(ROOT, root_group, title)
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


def strip_base64(md):
    # ⚠️ 不能给 base64 长度设上限：366 那本的图 base64 超长，设上限就会漏剥 → 26MB 文本
    md = re.sub(r"!\[[^\]]*\]\(data:[^)]*\)", "", md)
    md = re.sub(r"data:image/[a-zA-Z]+;base64,[A-Za-z0-9+/=\s]+", "", md)
    return re.sub(r"\n{3,}", "\n\n", md)


def poll(data, timeout_s=900):
    if not isinstance(data, dict) or str(data.get("status")) == "completed":
        return data
    url = data.get("result_url") or data.get("status_url")
    if not url:
        return data
    if url.startswith("/"):
        url = API + url
    t0 = time.time()
    last = data
    while time.time() - t0 < timeout_s:
        time.sleep(4)
        try:
            cur = requests.get(url, timeout=120).json()
        except Exception:
            continue
        last = cur
        if str(cur.get("status")) in ("completed", "failed", "error"):
            return cur
    return last


def ocr_batch(paths):
    files, handles = [], []
    try:
        for p in paths:
            fh = open(p, "rb")
            handles.append(fh)
            files.append(("files", (os.path.basename(p), fh, "image/jpeg")))
        r = requests.post(f"{API}/v1/file_parse", files=files, timeout=600)
        r.raise_for_status()
        return poll(r.json())
    finally:
        for fh in handles:
            fh.close()


def texts_from(data):
    out = []
    for f in (data.get("files") or []):
        c = f.get("content")
        md = (c or {}).get("markdown") if isinstance(c, dict) else ""
        if md:
            out.append((os.path.splitext(str(f.get("name") or ""))[0], strip_base64(md)))
    return out


def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    rows = list(csv.DictReader(io.open(CSV, encoding="utf-8-sig")))
    skip = set()
    try:
        for d in csv.DictReader(io.open(DUP_CSV, encoding="utf-8-sig")):
            if d["建议"].startswith("重复"):
                skip.add(d["剧本"])
    except FileNotFoundError:
        pass
    targets = [r for r in rows if r["档位"] == "A" and int(r["线索文件字数"] or 0) == 0
               and r["标题"] not in skip]
    print(f"A2 目标: {len(targets)} 本", flush=True)

    done = failed = 0
    for i, r in enumerate(targets, 1):
        title = r["标题"]
        md_path = os.path.join(A2_DIR, safe_name(title) + ".md")
        if not os.path.exists(md_path):
            print(f"  [{i}] 缺 markdown（先跑 10-extract）: {title[:26]}", flush=True)
            continue
        body = io.open(md_path, encoding="utf-8").read()
        if SECTION_HEAD in body:
            print(f"  [{i}/{len(targets)}] 跳过（已 OCR）{title[:28]}", flush=True)
            continue
        d = resolve_dir(r["分组"], title)
        if not d:
            print(f"  [{i}] 目录找不到: {title[:26]}", flush=True)
            failed += 1
            continue
        imgs = []
        for dp, _dn, fn in os.walk(d):
            if "__MACOSX" in dp:
                continue
            for f in fn:
                # 线索卡常放在名为「线索/证据」的子目录里，文件名只是 1.jpg —— 只看文件名会漏
                in_clue_dir = any(CLUE_NAME.search(part) for part in dp.split(os.sep))
                if (CLUE_NAME.search(f) or in_clue_dir) and f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                    p = os.path.join(dp, f)
                    try:
                        if os.path.getsize(p) / 1048576 <= MAX_MB:
                            imgs.append(p)
                    except OSError:
                        pass
        if not imgs:
            print(f"  [{i}] 无线索图: {title[:26]}", flush=True)
            continue
        imgs.sort()
        imgs = imgs[:MAX_IMAGES]
        t0 = time.time()
        try:
            data = ocr_batch(imgs)
        except Exception as e:
            print(f"  [{i}] ✗ OCR 失败 {title[:26]}: {e}", flush=True)
            failed += 1
            continue
        parts = texts_from(data)
        if not parts:
            print(f"  [{i}] ✗ 无文本 {title[:26]}", flush=True)
            failed += 1
            continue

        chunk = [SECTION_HEAD, ""]
        for name, md in parts:
            if len(md.strip()) < 10:
                continue
            chunk.append(f"### {name}")
            chunk.append("")
            chunk.append(md.strip())
            chunk.append("")
        if len("\n".join(chunk)) < 120:
            print(f"  [{i}] OCR 文本太少，跳过 {title[:26]}", flush=True)
            continue
        body = body.rstrip() + "\n\n" + "\n".join(chunk)
        io.open(md_path, "w", encoding="utf-8").write(body)
        done += 1
        chars = len(re.sub(r"\s+", "", "\n".join(chunk)))
        print(f"  [{i}/{len(targets)}] {title[:28]:<30} {len(imgs)} 图 → {chars} 字 "
              f"（{time.time() - t0:.0f}s）", flush=True)
        if limit and done >= limit:
            break

    print(f"\n完成 {done} 本，失败 {failed} 本", flush=True)


if __name__ == "__main__":
    main()
