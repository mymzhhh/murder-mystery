# -*- coding: utf-8 -*-
"""把逻辑校验器跑在**真实语料**上，量误报率。

为什么（2026-10-20）：这次的连环事故起源于"校验器把自己的时间线当手法声明"误报 9 条，
假问题被送进自动修订，最终吞掉 4 个角色。所以校验器的**误报率**比它的查全率更关键 ——
误报会驱动破坏性操作。这里用 19 本真实语料（人写、经过市场检验）当负样本：
它们不该被判出大量问题。
"""
import io
import json
import os
import re
import subprocess
import sys

A1 = r"C:\cluade code\ppt\text-gen-agent\data\corpus\a1"
NODE_SCRIPT = r"""
const path = require("path");
const { runLogicChecks, timelineEntries } = require("/app/src/script/logic-checks.js");
const fs = require("fs");
const md = fs.readFileSync(process.argv[2], "utf8");
const secs = [];
const parts = md.split(/^## 文件：(.+)$/m);
for (let i = 1; i < parts.length; i += 2) secs.push({ name: parts[i].trim(), text: parts[i+1] || "" });
const isRole = (n) => !/手册|组织者|主持人|游戏说明|规则|线索|证据|真相|复盘|解析|答案|供词|背景|公共/.test(n);
const roles = secs.filter(s => isRole(s.name));
const truth = secs.filter(s => /真相|复盘|解析|答案|供词/.test(s.name)).map(s => s.text).join("\n");
const clue = secs.filter(s => /线索|证据/.test(s.name)).map(s => s.text).join("\n");
const killer = roles.find(s => /凶手|真凶|你就是/.test(s.text)) || roles[0];
const tEntries = roles.reduce((a, s) => a + timelineEntries(s.text).length, 0);
const _res = runLogicChecks({
  sections: roles.map(s => ({ name: s.name, text: s.text })),
  murdererName: killer ? killer.name : "",
  dmText: truth,
  clueIds: [],
});
process.stdout.write(JSON.stringify({
  roles: roles.length, timeline: tEntries, truthChars: truth.replace(/\s+/g, "").length,
  clueChars: clue.replace(/\s+/g, "").length, issues: issues.length,
  sample: issues.slice(0, 3),
}));
"""


def main():
    if "--write-node" in sys.argv:
        io.open(r"C:\cluade code\ppt\text-gen-agent\_verify\logic-on-corpus.js", "w",
                encoding="utf-8").write(NODE_SCRIPT)
        print("node helper written")
        return

    node_file = r"/tmp/logic-on-corpus.js"
    rows = []
    files = sorted(f for f in os.listdir(A1) if f.endswith(".md") and not f.startswith("_"))
    for fn in files:
        p = os.path.join(A1, fn)
        r = subprocess.run(["docker", "exec", "murder-app", "node", node_file, f"/tmp/a1/{fn}"],
                           capture_output=True, text=True, encoding="utf-8")
        out = (r.stdout or "").strip()
        if not out:
            print(f"  ! {fn[:30]} 无输出: {(r.stderr or '')[:120]}")
            continue
        try:
            d = json.loads(out)
        except json.JSONDecodeError:
            print(f"  ! {fn[:30]} 解析失败: {out[:120]}")
            continue
        d["file"] = fn[:-3]
        rows.append(d)

    print(f"\n跑完 {len(rows)} 本真实语料\n")
    print(f"{'剧本':<30}{'角色本':>6}{'时刻':>6}{'真相字':>8}{'问题':>6}")
    print("-" * 60)
    total_issues = 0
    for d in sorted(rows, key=lambda x: -x["issues"]):
        total_issues += d["issues"]
        print(f"{d['file'][:28]:<30}{d['roles']:>6}{d['timeline']:>6}{d['truthChars']:>8}{d['issues']:>6}")
    n = len(rows) or 1
    clean = sum(1 for d in rows if d["issues"] == 0)
    print(f"\n零问题: {clean}/{len(rows)} 本（{100 * clean // n}%）｜平均问题数: {total_issues / n:.2f}")
    print("\n问题样本（前 5 条）：")
    shown = 0
    for d in rows:
        for s in d["sample"]:
            print(f"  [{d['file'][:16]}] {s[:110]}")
            shown += 1
            if shown >= 5:
                break
        if shown >= 5:
            break


if __name__ == "__main__":
    main()
