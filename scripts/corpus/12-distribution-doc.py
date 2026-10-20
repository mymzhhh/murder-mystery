# -*- coding: utf-8 -*-
"""从 _metrics.csv 生成《分布基线》markdown（skill 的 references 之一）。

要点：
  · 剔除留出集（不参与蒸馏），
  · 每个指标同时给「有值本数/最小/中位/最大」，
  · 附每本明细，让读者能看到分布形状而不是只信中位数。
"""
import csv
import io
import os
import statistics

DIR = r"C:\cluade code\ppt\text-gen-agent\data\corpus\a1"
CSV = os.path.join(DIR, "_metrics.csv")
OUT = r"C:\cluade code\ppt\text-gen-agent\skills\murder-mystery-distill\references\distributions.md"

# 留出集：不参与蒸馏，只用于最后验证
HOLDOUT = {"152-绝命阳光号（4人封闭）", "134-致命喷泉（4人封闭）"}

METRICS = [
    ("总字数", "整本字数（含手册/角色本/线索/真相）"),
    ("角色本数", "每本几个角色本"),
    ("角色本中位", "各角色本字数的中位数 ★核心"),
    ("角色本最长", "最厚的那个角色本"),
    ("角色本最短", "最薄的那个角色本"),
    ("时间线时刻数", "角色本里出现的时刻数（HH:MM / N点）★核心"),
    ("线索条数", "线索文件里的编号条目数"),
    ("线索分组数", "线索按人物/场所分了几组"),
    ("线索轮数", "「第N轮」出现几种"),
    ("线索字数", "线索文件总字数"),
    ("隐藏线索标记", "「发现隐藏线索」「深入调查」次数"),
    ("真相字数", "真相/复盘篇幅（含手册内嵌真相）★核心"),
    ("手册字数", "主持人手册字数"),
    ("手册首段字数", "手册第一段（DM 开场用）"),
    ("分幕数", "【第N幕】出现的不同幕数"),
    ("图片文件数", "剧本目录里的图片数"),
]


def main():
    rows = [r for r in csv.DictReader(io.open(CSV, encoding="utf-8-sig"))]
    train = [r for r in rows if r["剧本"] not in HOLDOUT]
    hold = [r for r in rows if r["剧本"] in HOLDOUT]

    L = []
    A = L.append
    A("# 语料分布基线（剧本杀 A1 档）")
    A("")
    A(f"> 样本：**{len(train)} 本**参与蒸馏（另有 {len(hold)} 本留出验证，未计入）")
    A("> 来源：`D:\\play game\\剧本杀剧本资源合集`，A1 档（docx 文本 + 线索也是 docx）")
    A("> 生成：`scripts/corpus/11-metrics.py` → `data/corpus/a1/_metrics.csv`")
    A("")
    A("## 怎么读这张表")
    A("")
    A("- **有值** = 有多少本算得出这个指标。语料写法差异极大，`0` 往往不是「本里没有」，")
    A("  而是「这本用别的写法组织」（例如真相写在手册里、线索是印刷卡图片）。")
    A("- 中位数比平均数可靠：这里存在明显的长本离群值（见下面的警告）。")
    A("")
    A("## 分布总表")
    A("")
    A("| 指标 | 含义 | 有值 | 最小 | 中位 | 最大 |")
    A("|---|---|---|---|---|---|")
    for key, desc in METRICS:
        vals = [int(r[key]) for r in train]
        nz = [v for v in vals if v > 0]
        A(f"| {key} | {desc} | {len(nz)}/{len(vals)} | {min(vals)} | "
          f"{int(statistics.median(vals))} | {max(vals)} |")
    A("")
    A("## ⚠️ 最重要的一条：不要拿 344 当唯一标杆")
    A("")
    role_vals = sorted(int(r["角色本中位"]) for r in train)
    truth_vals = sorted(int(r["真相字数"]) for r in train)
    A(f"`344 吉普赛女郎` 是我们最早的参考本，但它是**长本离群值**：")
    A(f"角色本中位 **5617 字**，而 {len(train)} 本的中位只有 "
      f"**{int(statistics.median(role_vals))} 字**；")
    A(f"真相 **10443 字**，而中位只有 **{int(statistics.median(truth_vals))} 字**。")
    A("")
    A(f"角色本中位数（升序）：{', '.join(str(v) for v in role_vals)}")
    A("")
    A("所以「角色本要写到 5000+」是**误判**——那是前 10% 的长本。中位数量级是 1500–2500。")
    A("写作时应以 **中位数为基准、最多向 75 分位靠**，而不是照抄最厚的那本。")
    A("")
    A("## 每本明细")
    A("")
    A("| 剧本 | 总字数 | 角色本 | 中位 | 时刻 | 线索条 | 分组 | 真相 | 手册 | 分幕 |")
    A("|---|---|---|---|---|---|---|---|---|---|")
    for r in sorted(train, key=lambda x: -int(x["角色本中位"])):
        A(f"| {r['剧本']} | {r['总字数']} | {r['角色本数']} | {r['角色本中位']} | "
          f"{r['时间线时刻数']} | {r['线索条数']} | {r['线索分组数']} | {r['真相字数']} | "
          f"{r['手册字数']} | {r['分幕数']} |")
    A("")
    A("## 留出集（只用于验证，不参与蒸馏）")
    A("")
    A("| 剧本 | 总字数 | 角色本 | 中位 | 时刻 | 线索条 | 真相 |")
    A("|---|---|---|---|---|---|---|")
    for r in hold:
        A(f"| {r['剧本']} | {r['总字数']} | {r['角色本数']} | {r['角色本中位']} | "
          f"{r['时间线时刻数']} | {r['线索条数']} | {r['真相字数']} |")
    A("")
    A("用途：skill 写完后，用留出集判断「我们生成的本落在这个分布的第几百分位」，")
    A("而不是「像不像某一本」。")
    A("")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    io.open(OUT, "w", encoding="utf-8").write("\n".join(L))
    print("已写出:", OUT)
    print(f"训练集 {len(train)} 本 / 留出 {len(hold)} 本")


if __name__ == "__main__":
    main()
