/* ===================== 剧本杀 — 管理端 v2 ===================== */
(function() {
  "use strict";

  // ===================== Auth & Init =====================
  var token = localStorage.getItem("token");
  var username = localStorage.getItem("username");
  var role = localStorage.getItem("role");

  if (!token || role !== "admin") { location.href = "/login.html"; return; }

  document.getElementById("userInfo").textContent = "管理员: " + username;

  function checkAuth(res) {
    if (res.status === 401) { localStorage.clear(); location.href = "/login.html"; }
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      method: opts.method || "GET",
      body: opts.body
    }).then(function(res) { checkAuth(res); return res; });
  }

  function doLogout() {
    api("/api/auth/logout", { method: "POST" }).finally(function() {
      localStorage.clear();
      location.href = "/login.html";
    });
  }

  // ===================== Page Switching =====================
  function switchPage(p) {
    document.querySelectorAll(".nav-tab").forEach(function(el) {
      var isActive = false;
      if (p === "scripts" && el.textContent.indexOf("剧本") !== -1) isActive = true;
      if (p === "users" && el.textContent.indexOf("用户") !== -1) isActive = true;
      if (p === "rooms" && el.textContent.indexOf("房间") !== -1) isActive = true;
      el.classList.toggle("active", isActive);
    });
    document.querySelectorAll(".page").forEach(function(el) { el.classList.remove("active"); });
    document.getElementById("page-" + p).classList.add("active");
    if (p === "scripts") loadScripts();
    if (p === "users") loadUsers();
    if (p === "rooms") loadRooms();
  }

  // ===================== Pipeline =====================
  var _abortController = null;
  var _scriptConfig = null;
  var _lastSessionId = null;
  var _lastPhase = null;

  function pipeActive(n) {
    for (var i = 1; i <= 5; i++) {
      var el = document.getElementById("ps" + i);
      el.classList.remove("active", "done", "error");
      if (i < n) el.classList.add("done");
      else if (i === n) el.classList.add("active");
    }
  }

  function renderPipeline() {
    _abortController = null;
    _scriptConfig = null;
    _lastSessionId = null;
    _lastPhase = null;
    var h = '<div class="pipeline-content">' +
      '<div class="form-group"><label>描述你想要的剧本</label>' +
      '<textarea id="scriptInput" class="form-textarea" rows="4" placeholder="例如：民国上海滩富商毒杀案，6人参加。或者：两人PVE对抗本，现代都市背景..."></textarea></div>' +
      '<div class="pipeline-buttons">' +
      '<button class="btn btn-primary btn-auto" onclick="step1Optimize()">优化提示词</button>' +
      '</div></div>';
    document.getElementById("pipelineContent").innerHTML = h;
    pipeActive(1);
  }

  // Step 1: Optimize prompt
  async function step1Optimize() {
    var input = document.getElementById("scriptInput").value.trim();
    if (!input) { showToast("请输入剧本需求", "warning"); return; }

    pipeActive(2);
    var el = document.getElementById("pipelineContent");
    el.innerHTML = '<div class="state-loading">Agent 正在分析和优化你的需求...</div>';

    try {
      var res = await api("/api/admin/pipeline/optimize", {
        method: "POST",
        body: JSON.stringify({ input: input })
      });
      var data = await res.json();
      if (!res.ok) {
        el.innerHTML = '<div class="alert alert-danger">' + esc(data.error || '优化失败') + '</div>';
        pipeActive(1);
        return;
      }

      var playerCount = data.playerCount || (data.extracted ? data.extracted.playerCount : 4);
      var npcCount = data.npcCount || 0;
      var isPVE = data.isPVE !== undefined ? data.isPVE : (npcCount > 0);
      var gameMode = data.gameMode || (isPVE ? "PVE" : "PVP");
      _scriptConfig = { playerCount: playerCount, npcCount: npcCount, isPVE: isPVE, gameMode: gameMode };

      var h = '<div class="grid-4 mb-lg">';
      h += '<div class="card card-static text-center"><div style="font-size:32px;color:var(--gold);font-weight:800;">' + playerCount + '</div><div class="text-xs text-dim">玩家角色</div></div>';
      h += '<div class="card card-static text-center"><div style="font-size:32px;color:var(--mystic-light);font-weight:800;">' + npcCount + '</div><div class="text-xs text-dim">NPC嫌疑人</div></div>';
      h += '<div class="card card-static text-center"><div style="font-size:18px;color:' + (isPVE ? 'var(--gold)' : 'var(--mystic-light)') + ';font-weight:800;">' + gameMode + '</div><div class="text-xs text-dim">游戏模式</div></div>';
      if (data.title) h += '<div class="card card-static"><strong style="color:var(--gold);">' + esc(data.title) + '</strong><div class="text-xs text-dim mt-sm">' + esc(data.era || '') + ' | ' + esc(data.style || '') + '</div></div>';
      h += '</div>';

      h += '<div class="form-group"><label>优化后的剧本需求（可修改）</label>';
      h += '<textarea id="optimizedInput" class="form-textarea" rows="6">' + esc(data.optimized || input) + '</textarea></div>';
      if (data.summary) h += '<div class="text-sm text-dim mb-sm">' + esc(data.summary) + '</div>';
      if (data.notes) h += '<div class="alert alert-warning">' + esc(data.notes) + '</div>';
      h += '<div class="pipeline-buttons">' +
        '<button class="btn btn-outline btn-auto" onclick="renderPipeline()">返回修改</button>' +
        '<button class="btn btn-primary btn-auto" onclick="step2Generate()">确认并生成</button>' +
        '</div>';

      el.innerHTML = h;
    } catch (e) {
      el.innerHTML = '<div class="alert alert-danger">优化失败: ' + e.message + '</div>';
      pipeActive(1);
    }
  }

  // Step 2-5: Generate → Review → Split
  function cancelPipeline() {
    if (_abortController) { _abortController.abort(); _abortController = null; }
    pipeActive(1);
    renderPipeline();
  }

  function retryPipeline(sessionId) {
    if (!sessionId) return;
    _lastSessionId = sessionId;
    var isReviewPhase = _lastPhase === 'review';
    pipeActive(isReviewPhase ? 4 : 5);
    var el = document.getElementById("pipelineContent");
    el.innerHTML = '<div class="progress-steps"></div>' +
      '<div class="pipeline-buttons"><button class="btn btn-danger btn-sm btn-auto" onclick="cancelPipeline()">取消生成</button></div>';

    _abortController = new AbortController();
    var url = isReviewPhase
      ? "/api/admin/scripts/" + sessionId + "/review-revise"
      : "/api/admin/scripts/" + sessionId + "/split";

    streamPipeline(url, null, el, sessionId);
  }

  function streamPipeline(url, body, el, retrySessionId) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      signal: _abortController ? _abortController.signal : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function(res) {
      return readSSE(res, el);
    }).catch(function(e) {
      if (e.name !== "AbortError") {
        el.innerHTML += '<div class="alert alert-danger mt-sm">流式读取失败: ' + e.message + '</div>';
        if (retrySessionId) {
          el.innerHTML += '<div class="pipeline-buttons"><button class="btn btn-primary btn-auto" onclick="retryPipeline(\'' + retrySessionId + '\')">再次重试</button></div>';
        }
      }
    }).finally(function() { _abortController = null; });
  }

  function readSSE(res, el) {
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = "";
    var sessionId = null;

    function pump() {
      return reader.read().then(function(rd) {
        if (rd.done) return;
        buf += dec.decode(rd.value, { stream: true });
        var lines = buf.split("\n");
        buf = lines.pop() || "";
        var et = "";

        lines.forEach(function(line) {
          if (line.startsWith("event: ")) { et = line.slice(7); return; }
          if (!line.startsWith("data: ")) return;

          try {
            var d = JSON.parse(line.slice(6));
            if (et === "progress") {
              var color = stageColor(d.stage);
              el.querySelector(".progress-steps").innerHTML += '<div style="font-size:12px;color:' + color + ';padding:2px 0;">' + esc(d.stage + ': ' + d.message) + '</div>';
            } else if (et === "phase") {
              if (d.phase === "write") pipeActive(3);
              else if (d.phase === "review") pipeActive(4);
              else if (d.phase === "split") pipeActive(5);
              if (d.phase === "write_done" && d.sessionId) _lastSessionId = d.sessionId;
              _lastPhase = d.phase;
              el.querySelector(".progress-steps").innerHTML += '<div style="font-size:13px;color:var(--gold);padding:4px 0;font-weight:600;">' + esc(d.message) + '</div>';
            } else if (et === "complete") {
              if (d.status === "done") {
                pipeActive(5);
                el.querySelector(".progress-steps").innerHTML += '<div style="color:var(--success);margin-top:8px;font-weight:600;">剧本生成完成！已评测通过并切分</div>';
              } else {
                el.querySelector(".progress-steps").innerHTML += '<div class="alert alert-warning mt-sm">' + esc(d.message) + '</div>';
              }
              if (d.sessionId) el.querySelector(".progress-steps").innerHTML += '<div class="text-xs text-dim mt-sm">SessionId: ' + d.sessionId + '</div>';
              el.innerHTML += '<div class="pipeline-buttons"><button class="btn btn-primary btn-auto" onclick="renderPipeline()">生成新剧本</button></div>';
              loadScripts();
            } else if (et === "error") {
              el.querySelector(".progress-steps").innerHTML += '<div class="alert alert-danger mt-sm">' + esc(d.message) + '</div>';
              var sid = d.sessionId || _lastSessionId;
              if (sid) {
                var btnLabel = (_lastPhase === 'review') ? '重试评测+切分' : (_lastPhase === 'write' || !_lastPhase ? '重新生成' : '重试切分');
                el.innerHTML += '<div class="pipeline-buttons">' +
                  '<button class="btn btn-primary btn-auto" onclick="retryPipeline(\'' + sid + '\')">' + btnLabel + '</button>' +
                  '<button class="btn btn-outline btn-auto" onclick="renderPipeline()">重新开始</button></div>';
              } else {
                pipeActive(1);
              }
            }
          } catch (e) { /* skip malformed JSON */ }
        });

        return pump();
      });
    }

    return pump();
  }

  async function step2Generate() {
    var input = document.getElementById("optimizedInput").value.trim();
    if (!input) { showToast("请输入剧本需求", "warning"); return; }

    pipeActive(3);
    var el = document.getElementById("pipelineContent");
    el.innerHTML = '<div class="progress-steps"></div>' +
      '<div class="pipeline-buttons"><button class="btn btn-danger btn-sm btn-auto" onclick="cancelPipeline()">取消生成</button></div>';

    _abortController = new AbortController();

    try {
      var res = await fetch("/api/admin/pipeline/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ input: input, config: _scriptConfig || undefined }),
        signal: _abortController.signal,
      });

      await readSSE(res, el);
    } catch (e) {
      if (e.name === "AbortError") {
        el.innerHTML = '<div class="alert alert-warning">已取消生成</div>' +
          '<div class="pipeline-buttons"><button class="btn btn-primary btn-auto" onclick="renderPipeline()">重新开始</button></div>';
      } else {
        el.innerHTML += '<div class="alert alert-danger mt-sm">流水线失败: ' + e.message + '</div>';
      }
      pipeActive(1);
    } finally {
      _abortController = null;
    }
  }

  function stageColor(stage) {
    if (stage.indexOf('player_script') !== -1) return 'var(--mystic-light)';
    if (stage.indexOf('npc_script') !== -1) return 'var(--gold)';
    if (stage.indexOf('clue') !== -1) return '#4ade80';
    if (stage.indexOf('dm') !== -1 || stage.indexOf('save') !== -1) return '#93c5fd';
    if (stage.indexOf('passed') !== -1 || stage.indexOf('done') !== -1) return 'var(--success)';
    if (stage.indexOf('fail') !== -1 || stage.indexOf('revise') !== -1) return 'var(--warning)';
    return 'var(--text-dim)';
  }

  // ===================== Script CRUD =====================
  function loadScripts() {
    api("/api/admin/scripts")
      .then(function(res) { return res.json(); })
      .then(function(data) {
        var tbody = document.querySelector("#scriptTable tbody");
        if (!data.scripts || data.scripts.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4"><div class="state-empty">暂无剧本</div></td></tr>';
          return;
        }
        tbody.innerHTML = data.scripts.map(function(s) {
          return '<tr>' +
            '<td>' + esc(s.topic) + '</td>' +
            '<td>' + (s.characterCount || '?') + '人</td>' +
            '<td>' + new Date(s.createdAt).toLocaleString() + '</td>' +
            '<td>' +
            '<button class="btn btn-outline btn-xs" onclick="createRoomFromScript(\'' + esc(s.sessionId) + '\')">创建房间</button>' +
            '<button class="btn btn-outline btn-xs" onclick="viewScript(\'' + esc(s.sessionId) + '\')" style="margin-left:4px;">查看原文</button>' +
            (s.isSplit ? '<button class="btn btn-outline btn-xs" onclick="viewSplitData(\'' + esc(s.sessionId) + '\')" style="margin-left:4px;">查看切分</button>' : '') +
            '<button class="btn btn-outline btn-xs" onclick="reviewScript(\'' + esc(s.sessionId) + '\')" style="margin-left:4px;">评测</button>' +
            '<button class="btn btn-outline btn-xs" onclick="reviewAndReviseScript(\'' + esc(s.sessionId) + '\')" style="margin-left:4px;">评测+修复</button>' +
            '<button class="btn btn-outline btn-xs" onclick="splitScriptBtn(\'' + esc(s.sessionId) + '\')" style="margin-left:4px;">切分</button>' +
            '<button class="btn btn-outline btn-xs" onclick="deleteScript(\'' + esc(s.sessionId) + '\')" style="margin-left:4px;">删除</button>' +
            '</td></tr>';
        }).join("");

        // Populate room creation select
        var sel = document.getElementById("roomScriptSelect");
        if (sel) {
          sel.innerHTML = '<option value="">-- 选择剧本 --</option>' +
            data.scripts.map(function(s) { return '<option value="' + esc(s.sessionId) + '">' + esc(s.topic.substring(0, 40)) + '</option>'; }).join("");
        }
      })
      .catch(function(e) {
        console.error("[admin] loadScripts failed:", e.message);
        document.querySelector("#scriptTable tbody").innerHTML = '<tr><td colspan="4"><div class="state-error">加载剧本失败，请刷新重试</div></td></tr>';
      });
  }

  function deleteScript(id) {
    if (!confirm("确定删除？")) return;
    api("/api/admin/scripts/" + id, { method: "DELETE" }).then(loadScripts);
  }

  function viewScript(id) {
    api("/api/admin/scripts/" + id)
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data.markdown) { showToast("剧本内容为空", "warning"); return; }
        var w = window.open("", "_blank", "width=800,height=700");
        w.document.write('<html><head><meta charset="utf-8"><title>剧本原文</title><style>body{font-family:serif;background:#1a1a2e;color:#d4d4dc;padding:20px;line-height:1.8;white-space:pre-wrap;max-width:800px;margin:0 auto;}</style></head><body>' + esc(data.markdown) + '</body></html>');
      })
      .catch(function(e) { showToast("查看失败: " + e.message, "error"); });
  }

  function viewSplitData(id) {
    api("/api/admin/scripts/" + id + "/split-view")
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data.meta) { showToast("切分数据不存在", "warning"); return; }
        var h = '<h2 style="color:var(--gold);">' + esc(data.meta.title) + '</h2>' +
          '<p>' + esc(data.meta.era || '') + ' | ' + esc(data.meta.location || '') + ' | ' + data.characters.length + '角色 | ' + data.clues.length + '条线索</p><hr>' +
          '<h3>角色剧本</h3>';
        data.characters.forEach(function(c) {
          h += '<details style="margin-bottom:8px;border:1px solid var(--border);border-radius:8px;padding:8px;background:var(--surface);"><summary style="color:' + (c.roleType === "npc" ? 'var(--gold)' : 'var(--mystic-light)') + ';font-weight:600;">' + esc(c.name) + ' [' + (c.roleType === "npc" ? 'NPC' : '玩家') + ']' + (c.isMurderer ? ' 🔪凶手' : '') + ' — ' + esc(c.occupation || '') + '</summary><div style="white-space:pre-wrap;font-size:13px;line-height:1.7;max-height:300px;overflow-y:auto;margin-top:8px;">' + esc(c.script || '') + '</div>' + (c.secret ? '<div style="margin-top:8px;color:var(--blood-light);"><strong>秘密:</strong> ' + esc(c.secret) + '</div>' : '') + '</details>';
        });
        h += '<h3>线索列表 (' + data.clues.length + '条)</h3>';
        data.clues.forEach(function(c) {
          h += '<div style="padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;"><span style="color:var(--gold);">' + esc(c.id) + '</span> (R' + c.round + ') ' + esc(c.content || '') + '</div>';
        });
        var dm = data.dm || {};
        h += '<h3>DM手册</h3><p><strong>凶手:</strong> ' + esc(dm.murdererName || '') + ' | ' + esc(dm.murdererMotive || '') + '</p>';
        if (dm.truthReveal) h += '<div style="white-space:pre-wrap;">' + esc(dm.truthReveal) + '</div>';

        var w = window.open("", "_blank", "width=900,height=750");
        w.document.write('<html><head><meta charset="utf-8"><title>切分数据</title><style>body{font-family:sans-serif;background:#1a1a2e;color:#d4d4dc;padding:20px;line-height:1.6;} h2,h3{color:#c9a96e;} hr{border-color:#2a2a45;} details{background:#181830;} summary{cursor:pointer;}</style></head><body>' + h + '</body></html>');
      })
      .catch(function(e) { showToast("查看失败: " + e.message, "error"); });
  }

  function reviewScript(id) {
    var prog = document.getElementById("genProgress");
    prog.style.display = "block";
    prog.innerHTML = '<div class="panel"><h3 style="color:var(--gold);margin-bottom:8px;">📊 剧本评测</h3><div class="state-loading">AI 正在多维度评测中...</div></div>';

    api("/api/admin/scripts/" + id + "/review", { method: "POST" })
      .then(function(res) { return res.json().then(function(data) { return { ok: res.ok, data: data }; }); })
      .then(function(result) {
        var data = result.data;
        if (!result.ok) { prog.innerHTML = '<div class="alert alert-danger">' + esc(data.error || '评测失败') + '</div>'; return; }
        var scores = data.scores || {};
        var dims = data.dimensions || {};
        var passed = data.passed;
        var dimNames = [
          { key: "storyCompleteness", label: "故事完整性", color: "var(--gold)" },
          { key: "murdererDesign", label: "凶手设计", color: "var(--blood-light)" },
          { key: "clueSystem", label: "线索系统", color: "#4ade80" },
          { key: "characterDesign", label: "角色设计", color: "var(--mystic-light)" },
          { key: "playability", label: "可玩性", color: "#fcd34d" }
        ];

        var h = '<div style="color:' + (passed ? 'var(--success)' : 'var(--warning)') + ';font-size:14px;font-weight:600;margin-bottom:12px;">' +
          (passed ? '✅ 评测通过' : '⚠️ 评测未通过') + ' — ' + data.totalScore + '分</div>';

        // 5维度评分卡片
        h += '<div class="grid-4" style="text-align:center;margin-bottom:12px;">';
        dimNames.forEach(function(d) {
          var score = scores[d.key] || '-';
          h += '<div class="card card-static" style="padding:12px;"><div style="font-size:28px;color:' + d.color + ';font-weight:800;">' + score + '</div><div class="text-xs text-dim">' + d.label + '</div></div>';
        });
        h += '</div>';

        // 每维度可展开详情（reason + suggestion）
        h += '<div style="margin-bottom:12px;">';
        dimNames.forEach(function(d, idx) {
          var dim = dims[d.key];
          if (!dim || !dim.reason) return;
          var openAttr = idx === 0 ? ' open' : '';
          h += '<details class="script-detail" style="margin-bottom:4px;border-left:3px solid ' + d.color + ';"' + openAttr + '>';
          h += '<summary style="color:' + d.color + ';font-weight:600;font-size:13px;">' + d.label + ' — ' + (scores[d.key] || '?') + '分</summary>';
          h += '<div style="font-size:12px;color:var(--text-dim);margin-top:4px;"><strong>评估：</strong>' + esc(dim.reason) + '</div>';
          if (dim.suggestion) h += '<div style="font-size:12px;color:var(--success-light);margin-top:4px;"><strong>建议：</strong>' + esc(dim.suggestion) + '</div>';
          h += '</details>';
        });
        h += '</div>';

        // strengths / weaknesses / revisionAdvice
        if (data.strengths && data.strengths.length) h += '<div style="margin-top:8px;font-size:12px;color:var(--success);">👍 ' + esc(data.strengths.join('；')) + '</div>';
        if (data.weaknesses && data.weaknesses.length) h += '<div style="margin-top:4px;font-size:12px;color:var(--warning);">⚠️ ' + esc(data.weaknesses.join('；')) + '</div>';
        if (data.revisionAdvice) h += '<div style="margin-top:8px;padding:8px;background:var(--surface2);border-radius:6px;font-size:12px;color:var(--text);line-height:1.6;">💡 ' + esc(data.revisionAdvice) + '</div>';

        // 一键应用建议修改
        var patches = data.suggestedPatches || [];
        if (patches.length > 0) {
          h += '<div style="margin-top:12px;padding:10px;background:rgba(245,158,11,0.08);border:1px solid var(--warning);border-radius:8px;">';
          h += '<div class="text-xs" style="color:var(--warning-light);margin-bottom:6px;">🔧 建议的局部修改（' + patches.length + '项）</div>';
          patches.forEach(function(p, i) {
            h += '<div style="font-size:11px;color:var(--text);padding:3px 0;">' + (i + 1) + '. [' + esc(p.type) + '] <strong>' + esc(p.target) + '</strong>: ' + esc(p.operation) + ' — ' + esc(p.description) + '</div>';
          });
          var patchesStr = encodeURIComponent(JSON.stringify(patches));
          h += '<button class="btn btn-warning btn-sm btn-auto" style="margin-top:8px;" onclick="applyPatches(\'' + id + '\', decodeURIComponent(\'' + patchesStr + '\'))">⚡ 一键应用修改</button>';
          h += '<span id="patchResult" style="font-size:11px;margin-left:8px;"></span>';
          h += '</div>';
        }

        prog.innerHTML = '<div class="panel">' + h + '</div>';
      })
      .catch(function(e) { prog.innerHTML = '<div class="alert alert-danger">评测失败: ' + e.message + '</div>'; });
  }

  function applyPatches(id, patchesJson) {
    var btn = event.target;
    btn.disabled = true;
    btn.textContent = "应用修改中...";
    var patches = typeof patchesJson === 'string' ? JSON.parse(patchesJson) : patchesJson;
    api("/api/admin/scripts/" + id + "/apply-patches", {
      method: "POST",
      body: JSON.stringify({ patches: patches })
    }).then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.ok) {
          document.getElementById("patchResult").innerHTML = '<span style="color:var(--success);">✅ 已应用，请重新评测</span>';
        } else {
          document.getElementById("patchResult").innerHTML = '<span style="color:var(--danger);">❌ ' + esc(data.error || '失败') + '</span>';
        }
      })
      .catch(function(e) {
        document.getElementById("patchResult").innerHTML = '<span style="color:var(--danger);">❌ ' + e.message + '</span>';
      })
      .finally(function() { btn.disabled = false; btn.textContent = "⚡ 一键应用修改"; });
  }

  function reviewAndReviseScript(id) {
    if (!confirm("评测+修复将进行最多3轮评测和重新生成，每轮可能需要数分钟。确定继续？")) return;
    var prog = document.getElementById("genProgress");
    prog.style.display = "block";
    prog.innerHTML = '<div class="panel"><h3 style="color:var(--gold);margin-bottom:8px;">🔄 评测+修复</h3><div class="progress-steps"></div></div>';

    fetch("/api/admin/scripts/" + id + "/review-revise", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token }
    }).then(function(res) { return readSSE(res, prog); })
      .catch(function(e) { prog.innerHTML += '<div class="alert alert-danger mt-sm">评测修复失败: ' + e.message + '</div>'; });
  }

  function splitScriptBtn(id) {
    var prog = document.getElementById("genProgress");
    prog.style.display = "block";
    prog.innerHTML = '<div class="panel"><div class="progress-steps"><div style="color:var(--gold);">⏳ 正在切分剧本...</div></div></div>';

    fetch("/api/admin/scripts/" + id + "/split", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token }
    }).then(function(res) { return readSSE(res, prog); })
      .catch(function(e) { prog.innerHTML += '<div class="alert alert-danger mt-sm">切分失败: ' + e.message + '</div>'; });
  }

  // ===================== User Management =====================
  function loadUsers() {
    api("/api/admin/users")
      .then(function(res) { return res.json(); })
      .then(function(data) {
        document.querySelector("#userTable tbody").innerHTML = data.users.map(function(u) {
          return '<tr>' +
            '<td>' + esc(u.username) + '</td>' +
            '<td><span class="tag ' + (u.role === 'admin' ? 'tag-admin' : 'tag-player') + '">' + u.role + '</span></td>' +
            '<td>' + (u.createdAt ? new Date(u.createdAt).toLocaleString() : '') + '</td>' +
            '<td>' +
            '<button class="btn btn-outline btn-xs" onclick="toggleRole(\'' + esc(u.username) + '\',\'' + (u.role === 'admin' ? 'player' : 'admin') + '\')">设为' + (u.role === 'admin' ? '玩家' : '管理员') + '</button>' +
            (u.username !== username ? '<button class="btn btn-outline btn-xs" onclick="delUser(\'' + esc(u.username) + '\')" style="margin-left:4px;">删除</button>' : '') +
            '</td></tr>';
        }).join("");
      })
      .catch(function(e) {
        console.error("[admin] loadUsers failed:", e.message);
        document.querySelector("#userTable tbody").innerHTML = '<tr><td colspan="4"><div class="state-error">加载用户列表失败，请刷新重试</div></td></tr>';
      });
  }

  function toggleRole(name, newRole) {
    api("/api/admin/users/" + name + "/role", {
      method: "PUT",
      body: JSON.stringify({ role: newRole })
    }).then(loadUsers);
  }

  function delUser(name) {
    if (!confirm("确定删除用户 " + name + "？")) return;
    api("/api/admin/users/" + name, { method: "DELETE" }).then(loadUsers);
  }

  // ===================== Room Management =====================
  function loadRooms() {
    api("/api/admin/rooms")
      .then(function(res) { return res.json(); })
      .then(function(data) {
        var el = document.getElementById("activeRooms");
        if (!data.rooms || data.rooms.length === 0) {
          el.innerHTML = '<div class="state-empty">暂无活跃房间</div>';
          return;
        }
        el.innerHTML = data.rooms.map(function(r) {
          return '<div class="card card-static" style="margin-bottom:8px;">' +
            '<div class="flex-between">' +
            '<div><strong>' + esc(r.scriptTitle || '未命名') + '</strong> ' +
            '<span class="tag">' + esc(r.roomCode) + '</span> ' +
            '<span class="text-xs text-dim">' + r.playerCount + '人 | ' + r.phase + '</span></div>' +
            '<button class="btn btn-outline btn-xs" onclick="closeRoom(\'' + esc(r.roomCode) + '\')">关闭</button>' +
            '</div></div>';
        }).join("");
      })
      .catch(function(e) {
        console.error("[admin] loadRooms failed:", e.message);
        document.getElementById("activeRooms").innerHTML = '<div class="state-error">加载房间失败，请刷新重试</div>';
      });
  }

  function createRoom() {
    var sid = document.getElementById("roomScriptSelect").value;
    var max = document.getElementById("roomMaxPlayers").value;
    if (!sid) { showToast("请选择剧本", "warning"); return; }

    api("/api/admin/rooms", {
      method: "POST",
      body: JSON.stringify({ scriptSessionId: sid, maxPlayers: max })
    }).then(function(res) { return res.json(); })
      .then(function(data) {
        var el = document.getElementById("roomCreated");
        el.style.display = "block";
        el.innerHTML = '<div class="alert alert-success" style="text-align:center;">' +
          '<p>房间已创建</p>' +
          '<div class="room-code-lg" style="font-size:36px;">' + esc(data.roomCode) + '</div>' +
          '<p class="text-sm text-dim mt-sm">' + data.characterCount + '个角色 | 分享房间码给玩家</p>' +
          '</div>';
        loadRooms();
      })
      .catch(function(e) { showToast("创建失败: " + e.message, "error"); });
  }

  function createRoomFromScript(sid) {
    document.getElementById("roomScriptSelect").value = sid;
    switchPage("rooms");
  }

  function closeRoom(code) {
    if (!confirm("确定关闭房间 " + code + "？")) return;
    api("/api/admin/rooms/" + code, { method: "DELETE" }).then(loadRooms);
  }

  // ===================== Toast =====================
  function showToast(msg, type) {
    type = type || "info";
    var container = document.getElementById("toastContainer");
    if (!container) {
      container = document.createElement("div");
      container.id = "toastContainer";
      container.className = "toast-container";
      document.body.appendChild(container);
    }
    var toast = document.createElement("div");
    toast.className = "toast toast-" + type;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(function() {
      toast.classList.add("removing");
      setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
    }, 3500);
  }

  // ===================== Utility =====================
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = String(s || "");
    return d.innerHTML;
  }

  // ===================== Global Exports =====================
  window.switchPage = switchPage;
  window.doLogout = doLogout;
  window.step1Optimize = step1Optimize;
  window.step2Generate = step2Generate;
  window.cancelPipeline = cancelPipeline;
  window.retryPipeline = retryPipeline;
  window.renderPipeline = renderPipeline;
  window.loadScripts = loadScripts;
  window.deleteScript = deleteScript;
  window.viewScript = viewScript;
  window.viewSplitData = viewSplitData;
  window.reviewScript = reviewScript;
  window.reviewAndReviseScript = reviewAndReviseScript;
  window.splitScriptBtn = splitScriptBtn;
  window.loadUsers = loadUsers;
  window.toggleRole = toggleRole;
  window.delUser = delUser;
  window.loadRooms = loadRooms;
  window.createRoom = createRoom;
  window.createRoomFromScript = createRoomFromScript;
  window.closeRoom = closeRoom;
  window.applyPatches = applyPatches;

  // ===================== Init =====================
  loadScripts();
  renderPipeline();
})();
