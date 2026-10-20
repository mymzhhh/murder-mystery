# 一键验收：把库里某本剧本导出并跑分布校验
#
# 用法（在仓库根目录）：
#   pwsh scripts/corpus/20-validate-db-script.ps1 -ScriptId <uuid>
#   pwsh scripts/corpus/20-validate-db-script.ps1 -Title 沪西照相馆
#
# 做三件事：
#   1) 在 murder-app 容器里把 scripts.original_markdown 导出成 markdown
#   2) 拷回本地 data/corpus/db-<id前8位>.md
#   3) 跑 skills/murder-mystery-distill/scripts/validate.py
param(
    [string]$ScriptId = "",
    [string]$Title = "",
    [string]$OutDir = "data\corpus"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo

if (-not (Test-Path "_verify\export-md.js")) {
    Write-Error "缺少 _verify\export-md.js（导出脚本）"
}

# 按标题查 id
if (-not $ScriptId -and $Title) {
    $sql = "select id from scripts where title like '%$Title%' order by created_at desc limit 1;"
    $ScriptId = (docker exec murder-pg psql -U murder -d murder_mystery -t -A -c $sql).Trim()
    if (-not $ScriptId) { Write-Error "没找到标题含「$Title」的剧本" }
}
if (-not $ScriptId) { Write-Error "必须给 -ScriptId 或 -Title" }

$short = $ScriptId.Substring(0, 8)
$remote = "/tmp/db-$short.md"
$local = Join-Path $OutDir "db-$short.md"

docker cp "_verify\export-md.js" "murder-app:/tmp/export-md.js" | Out-Null
docker exec murder-app node /tmp/export-md.js $ScriptId $remote
docker cp "murder-app:$remote" $local | Out-Null
Write-Host "`n已导出: $local`n" -ForegroundColor Cyan

$py = "C:\Users\34141\AppData\Local\Programs\Python\Python312\python.exe"
$env:PYTHONIOENCODING = "utf-8"
& $py "skills\murder-mystery-distill\scripts\validate.py" $local
