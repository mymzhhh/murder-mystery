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
    if (p === "stats") loadStats();
    if (p === "models") loadModels();
    if (p === "users") loadUsers();
    if (p === "rooms") { loadRooms(); loadRoomScriptSelect(); }
  }

  // ===================== Pipeline =====================
  var _abortController = null;
  var _scriptConfig = null;
  var _lastSessionId = null;
  var _lastPhase = null;

  function pipeActive(n) {
    for (var i = 1; i <= 6; i++) {
      var el = document.getElementById("ps" + i);
      if (!el) continue;
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
    el.innerHTML = '<div class="state-loading">Agent 正在分析和优化你的需求...（通常需要1~3分钟，请耐心等待）</div>';

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
      var advMode = ["hardcore", "emotional"].indexOf(data.advancedMode) !== -1 ? data.advancedMode : "standard";
      var advLabel = advMode === "hardcore" ? "硬核·多重指向" : advMode === "emotional" ? "情感·反转" : "标准";
      _scriptConfig = { playerCount: playerCount, npcCount: npcCount, isPVE: isPVE, gameMode: gameMode, advancedMode: advMode };

      var h = '<div class="grid-4 mb-lg">';
      h += '<div class="card card-static text-center"><div style="font-size:32px;color:var(--gold);font-weight:800;">' + playerCount + '</div><div class="text-xs text-dim">玩家角色</div></div>';
      h += '<div class="card card-static text-center"><div style="font-size:32px;color:var(--mystic-light);font-weight:800;">' + npcCount + '</div><div class="text-xs text-dim">' + (gameMode === 'PVP' ? 'NPC目击者/关系人' : 'NPC嫌疑人') + '</div></div>';
      h += '<div class="card card-static text-center"><div style="font-size:18px;color:' + (isPVE ? 'var(--gold)' : 'var(--mystic-light)') + ';font-weight:800;">' + gameMode + '</div><div class="text-xs text-dim">游戏模式</div></div>';
      h += '<div class="card card-static text-center"><div style="font-size:14px;color:var(--success);font-weight:700;">' + advLabel + '</div><div class="text-xs text-dim">创作风格档位</div></div>';
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
    pipeActive(isReviewPhase ? 5 : 6);
    var el = document.getElementById("pipelineContent");
    el.innerHTML = '<div class="progress-steps"></div>' +
      '<div class="pipeline-buttons"><button class="btn btn-danger btn-sm btn-auto" onclick="cancelPipeline()">取消生成</button></div>';

    _abortController = new AbortController();
    var url = isReviewPhase
      ? "/api/admin/scripts/" + sessionId + "/review-split"
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
              if (d.phase === "outline") pipeActive(3);
              else if (d.phase === "write") pipeActive(4);
              else if (d.phase === "review") pipeActive(5);
              else if (d.phase === "split") pipeActive(6);
              if (d.phase === "write_done" && d.sessionId) _lastSessionId = d.sessionId;
              _lastPhase = d.phase;
              el.querySelector(".progress-steps").innerHTML += '<div style="font-size:13px;color:var(--gold);padding:4px 0;font-weight:600;">' + esc(d.message) + '</div>';
            } else if (et === "outline") {
              // 剧本大纲可视化：渲染结构化大纲面板并推进到生成剧本步骤
              pipeActive(4);
              _lastPhase = "outline";
              renderOutlinePanel(d);
            } else if (et === "complete") {
              if (d.status === "done") {
                pipeActive(6);
                el.querySelector(".progress-steps").innerHTML += '<div style="color:var(--success);margin-top:8px;font-weight:600;">剧本生成完成！已评测并切分</div>';
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

  // 渲染剧本大纲可视化面板（来自 SSE outline 事件）
  function renderOutlinePanel(d) {
    var el = document.getElementById("pipelineContent");
    if (!el) return;
    var o = d || {};
    var ts = o.trickSpec || {};
    var h = '<div class="panel" style="margin-top:10px;">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;"><h3 style="color:var(--gold);margin:0;">🎭 剧本大纲</h3>';
    h += '<span class="tag">' + (o.isPVE ? 'PVE' : 'PVP') + ' · ' + (o.playerCount || '?') + '玩家' + ((o.npcCount||0) > 0 ? ' + ' + o.npcCount + 'NPC' : '') + '</span></div>';

    // 标题 + 核心诡计
    h += '<div class="grid-2" style="margin-top:10px;">';
    h += '<div class="card card-static"><div class="text-xs text-dim">剧本名</div><strong style="font-size:18px;">' + esc(o.title || '未命名') + '</strong><div class="text-xs mt-sm">' + esc(o.storyBackground || '') + '</div></div>';
    h += '<div class="card card-static"><div class="text-xs text-dim">核心诡计</div><strong style="color:var(--blood-light);">' + esc(o.coreTrick || '') + '</strong><div class="text-xs mt-sm">' + esc((ts.trick ? ts.trick + '·' : '') + (ts.type || '') + (ts.mechanism ? '｜' + ts.mechanism : '')) + '</div></div>';
    h += '</div>';

    // 死者 + 凶手（含双时间线）
    var v = o.victim || {};
    var m = o.murderer || {};
    h += '<div class="grid-2" style="margin-top:8px;">';
    h += '<div class="card card-static"><div class="text-xs text-dim">死者</div><strong>' + esc(v.name || '?') + '</strong><div class="text-xs mt-sm">' + esc([v.identity, v.causeOfDeath, v.deathPlace].filter(Boolean).join(' · ')) + '</div></div>';
    h += '<div class="card card-static"><div class="text-xs text-dim">凶手</div><strong style="color:var(--danger);">' + esc(m.name || '?') + '</strong><div class="text-xs mt-sm">动机：' + esc(m.motive || '') + '</div></div>';
    h += '</div>';

    // 人物列表
    var chars = [];
    (o.players || []).forEach(function(p) { chars.push({ name: p.name, tag: p.isMurderer ? '🔪凶手' : (o.isPVE ? '玩家' : '玩家'), clazz: p.isMurderer ? 'tag-admin' : 'tag-player', meta: p.identity || '' }); });
    (o.npcs || []).forEach(function(n) { chars.push({ name: n.name, tag: 'NPC', clazz: 'tag-npc', meta: (n.identity || '') + (n.isMurderer ? ' 🔪' : '') }); });
    if (chars.length) {
      h += '<div style="margin-top:8px;"><div class="text-xs text-dim mb-sm">人物</div><div class="grid-2">';
      chars.forEach(function(c) {
        h += '<div class="card card-static" style="padding:8px 10px;"><strong>' + esc(c.name) + '</strong> <span class="tag ' + c.clazz + '">' + esc(c.tag) + '</span><div class="text-xs text-dim mt-sm">' + esc(c.meta) + '</div></div>';
      });
      h += '</div></div>';
    }

    // 关系网
    if (o.relations && o.relations.length) {
      h += '<div style="margin-top:10px;"><div class="text-xs text-dim mb-sm">人物关系网</div>';
      (o.relations || []).forEach(function(r) {
        h += '<div style="font-size:12px;padding:3px 0;border-bottom:1px solid var(--border);">' + esc(r.a) + ' ↔ ' + esc(r.b) + '：<span class="text-dim">' + esc(r.link || '') + '</span> <span style="color:var(--warning);">' + esc(r.tension || '') + '</span></div>';
      });
      h += '</div>';
    }

    // 凶手双时间线
    if (m.realLine || m.fakeLine) {
      h += '<div class="grid-2" style="margin-top:10px;">';
      if (m.realLine) h += '<div class="card card-static"><div class="text-xs text-dim">凶手真实时间线（DM真相）</div><div style="font-size:12px;white-space:pre-wrap;margin-top:4px;">' + esc(m.realLine) + '</div></div>';
      if (m.fakeLine) h += '<div class="card card-static"><div class="text-xs" style="color:var(--warning);">凶手伪装时间线（对外谎言）</div><div style="font-size:12px;white-space:pre-wrap;margin-top:4px;">' + esc(m.fakeLine) + '</div></div>';
      h += '</div>';
    }

    // 时间线骨架
    if (o.timeline && o.timeline.length) {
      h += '<div style="margin-top:10px;"><div class="text-xs text-dim mb-sm">关键时间线</div>';
      (o.timeline || []).forEach(function(t) {
        h += '<div style="font-size:12px;padding:2px 0;"><span style="color:var(--gold);font-family:monospace;">' + esc(t.time || '') + '</span> ' + esc(t.desc || '') + '</div>';
      });
      h += '</div>';
    }

    // 布局
    if (o.layout && o.layout.length) {
      h += '<div style="margin-top:10px;"><div class="text-xs text-dim mb-sm">场景布局</div><div style="font-size:12px;">' + esc(o.layout.join(' · ')) + '</div></div>';
    }

    h += '</div>';
    // 插入到进度日志之前（作为顶部面板）
    var steps = el.querySelector(".progress-steps");
    var panel = document.createElement("div");
    panel.innerHTML = h;
    if (steps) el.insertBefore(panel.firstChild, steps);
    else el.innerHTML = h + el.innerHTML;
    // 滚动到顶部让用户看到大纲
    el.scrollIntoView({ behavior: "smooth", block: "start" });
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

  // ===================== 仪表盘 =====================
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return String(n);
  }

  function loadStats() {
    api("/api/admin/stats")
      .then(function(res) { return res.json(); })
      .then(function(d) {
        document.getElementById("statCards").innerHTML =
          '<div class="card card-static"><div class="card-num">' + esc(d.users) + '</div><div class="card-label">用户数</div></div>' +
          '<div class="card card-static"><div class="card-num">' + esc(d.scripts) + '</div><div class="card-label">剧本数</div></div>' +
          '<div class="card card-static"><div class="card-num">' + esc(d.rooms) + '</div><div class="card-label">活跃房间</div></div>' +
          '<div class="card card-static"><div class="card-num">' + Math.floor((d.uptime || 0) / 60) + ' 分钟</div><div class="card-label">服务运行时长</div></div>';
        var l = d.llm || {};
        document.getElementById("llmCards").innerHTML =
          '<div class="card card-static"><div class="card-num">' + esc(l.calls) + '</div><div class="card-label">API 调用次数</div></div>' +
          '<div class="card card-static"><div class="card-num">' + esc(fmtTokens(l.inputTokens)) + '</div><div class="card-label">输入 tokens</div></div>' +
          '<div class="card card-static"><div class="card-num">' + esc(fmtTokens(l.outputTokens)) + '</div><div class="card-label">输出 tokens</div></div>' +
          '<div class="card card-static"><div class="card-num">' + esc(fmtTokens(l.totalTokens)) + '</div><div class="card-label">总 tokens</div></div>';
        var meta = document.getElementById("statsMeta");
        if (meta) meta.textContent = "统计时间: " + (d.updatedAt || "").replace("T", " ").replace(/\.\d+Z$/, " UTC");
        loadSyncStatus();
      })
      .catch(function(e) {
        console.error("[admin] loadStats failed:", e.message);
        document.getElementById("statCards").innerHTML = '<div class="state-error">加载失败，刷新重试</div>';
      });
  }

  // ===================== PG 同步面板 =====================
  function loadSyncStatus() {
    var el = document.getElementById("syncPanel");
    if (!el) return;
    api("/api/admin/sync-status")
      .then(function(res) { return res.json(); })
      .then(function(d) {
        el.innerHTML =
          '<div class="grid-4">' +
          '<div class="card card-static"><div class="card-num">' + esc(d.pendingCount || 0) + '</div><div class="card-label">待同步</div></div>' +
          '<div class="card card-static"><div class="card-num">' + esc(d.failedCount || 0) + '</div><div class="card-label">失败挂起</div></div>' +
          '</div>' +
          '<div style="margin-top:10px;display:flex;gap:8px;">' +
          '<button class="btn btn-primary btn-auto" onclick="syncNow(false)">立即同步</button>' +
          '<button class="btn btn-outline btn-auto" onclick="syncNow(true)">全量对账</button>' +
          '</div>' +
          '<p class="text-dim" id="syncResult" style="margin-top:8px;"></p>';
      })
      .catch(function(e) {
        console.error("[admin] loadSyncStatus failed:", e.message);
        el.innerHTML = '<div class="state-error">加载失败</div>';
      });
  }

  function syncNow(reconcileAll) {
    var btns = document.querySelectorAll('#syncPanel button');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    api("/api/admin/sync-now", { method: "POST", body: JSON.stringify({ reconcileAll: !!reconcileAll }) })
      .then(function(res) { return res.json(); })
      .then(function(d) {
        var el = document.getElementById("syncResult");
        if (el) el.textContent = "已同步 " + (d.synced || []).length + " 个，失败 " + ((d.failed || []).length) + " 个" + ((d.failed||[]).length ? "（可在日志查看原因）" : "");
        loadStats();
      })
      .catch(function(e) { showToast("同步失败: " + e.message, "error"); loadStats(); });
  }

  // ===================== Script CRUD =====================
  var SCRIPT_PAGE_SIZE = 10;
  var scriptPage = 1;
  var scriptTotal = 0;
  var scriptQuery = "";
  var _searchTimer = null;

  function scriptPageMove(delta) {
    var maxPage = Math.max(1, Math.ceil(scriptTotal / SCRIPT_PAGE_SIZE));
    var np = scriptPage + delta;
    if (np < 1 || np > maxPage) return;
    scriptPage = np;
    loadScripts();
  }
  window.scriptPageMove = scriptPageMove;

  // 房间创建下拉需要全量剧本（独立于分页表）
  function loadRoomScriptSelect() {
    api("/api/admin/scripts?pageSize=100")
      .then(function(res) { return res.json(); })
      .then(function(data) {
        var sel = document.getElementById("roomScriptSelect");
        if (!sel) return;
        sel.innerHTML = '<option value="">-- 选择剧本 --</option>' +
          (data.scripts || []).map(function(s) { return '<option value="' + esc(s.sessionId) + '">' + esc(s.topic.substring(0, 40)) + '</option>'; }).join("");
      })
      .catch(function(e) { console.error("[admin] loadRoomScriptSelect failed:", e.message); });
  }

  function loadScripts() {
    var params = "?page=" + scriptPage + "&pageSize=" + SCRIPT_PAGE_SIZE + (scriptQuery ? "&q=" + encodeURIComponent(scriptQuery) : "");
    api("/api/admin/scripts" + params)
      .then(function(res) { return res.json(); })
      .then(function(data) {
        scriptTotal = data.total || 0;
        var tbody = document.querySelector("#scriptTable tbody");
        if (!data.scripts || data.scripts.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4"><div class="state-empty">暂无剧本</div></td></tr>';
        } else {
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
              '<button class="btn btn-outline btn-xs" onclick="reviewAndSplitScript(\'' + esc(s.sessionId) + '\')" style="margin-left:4px;">评测并切分</button>' +
              '<button class="btn btn-outline btn-xs" onclick="splitScriptBtn(\'' + esc(s.sessionId) + '\')" style="margin-left:4px;">切分</button>' +
              '<button class="btn btn-outline btn-xs" onclick="deleteScript(\'' + esc(s.sessionId) + '\')" style="margin-left:4px;">删除</button>' +
              '</td></tr>';
          }).join("");
        }

        // 分页信息
        var maxPage = Math.max(1, Math.ceil(scriptTotal / SCRIPT_PAGE_SIZE));
        var info = document.getElementById("scriptPageInfo");
        if (info) info.textContent = "共 " + scriptTotal + " 个剧本 · 第 " + scriptPage + "/" + maxPage + " 页";
        var prev = document.getElementById("scriptPrev");
        var next = document.getElementById("scriptNext");
        if (prev) prev.disabled = scriptPage <= 1;
        if (next) next.disabled = scriptPage >= maxPage;

        loadRoomScriptSelect();
      })
      .catch(function(e) {
        console.error("[admin] loadScripts failed:", e.message);
        document.querySelector("#scriptTable tbody").innerHTML = '<tr><td colspan="4"><div class="state-error">加载剧本失败，请刷新重试</div></td></tr>';
      });
  }

  // 剧本搜索框（防抖 300ms）
  function initScriptSearch() {
    var searchEl = document.getElementById("scriptSearch");
    if (!searchEl) return;
    searchEl.addEventListener("input", function() {
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(function() {
        scriptPage = 1;
        scriptQuery = searchEl.value.trim();
        loadScripts();
      }, 300);
    });
  }

  function deleteScript(id) {
    if (!confirm("确定删除？")) return;
    api("/api/admin/scripts/" + id, { method: "DELETE" }).then(loadScripts);
  }

  function viewScript(id) {
    var w = window.open("", "_blank", "width=800,height=700");
    w.document.write('<html><head><meta charset="utf-8"><title>剧本原文</title><style>body{font-family:serif;background:#1a1a2e;color:#d4d4dc;padding:20px;line-height:1.8;white-space:pre-wrap;max-width:800px;margin:0 auto;}</style></head><body><p style="text-align:center;color:var(--text-dim);">加载中...</p></body></html>');
    api("/api/admin/scripts/" + id)
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data.markdown) { showToast("剧本内容为空", "warning"); w.close(); return; }
        w.document.write('<html><head><meta charset="utf-8"><title>剧本原文</title><style>body{font-family:serif;background:#1a1a2e;color:#d4d4dc;padding:20px;line-height:1.8;white-space:pre-wrap;max-width:800px;margin:0 auto;}</style></head><body>' + esc(data.markdown) + '</body></html>');
      })
      .catch(function(e) { showToast("查看失败: " + e.message, "error"); w.close(); });
  }

  function viewSplitData(id) {
    var w = window.open("", "_blank", "width=900,height=750");
    w.document.write('<html><head><meta charset="utf-8"><title>切分数据</title><style>body{font-family:sans-serif;background:#1a1a2e;color:#d4d4dc;padding:20px;line-height:1.6;} h2,h3{color:#c9a96e;} hr{border-color:#2a2a45;} details{background:#181830;} summary{cursor:pointer;}</style></head><body><p style="text-align:center;color:var(--text-dim);">加载中...</p></body></html>');
    api("/api/admin/scripts/" + id + "/split-view")
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data.meta) { showToast("切分数据不存在", "warning"); w.close(); return; }
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
        w.document.write('<html><head><meta charset="utf-8"><title>切分数据</title><style>body{font-family:sans-serif;background:#1a1a2e;color:#d4d4dc;padding:20px;line-height:1.6;} h2,h3{color:#c9a96e;} hr{border-color:#2a2a45;} details{background:#181830;} summary{cursor:pointer;}</style></head><body>' + h + '</body></html>');
      })
      .catch(function(e) { showToast("查看失败: " + e.message, "error"); w.close(); });
  }

  function reviewScript(id) {
    var prog = document.getElementById("genProgress");
    prog.style.display = "block";
    prog.innerHTML = '<div class="panel"><h3 style="color:var(--gold);margin-bottom:8px;">🔍 剧本评测（逻辑漏洞检查）</h3><div class="state-loading">AI 正在查找时间线与线索链中的逻辑漏洞...</div></div>';

    api("/api/admin/scripts/" + id + "/review", { method: "POST" })
      .then(function(res) { return res.json().then(function(data) { return { ok: res.ok, data: data }; }); })
      .then(function(result) {
        var data = result.data;
        if (!result.ok) { prog.innerHTML = '<div class="alert alert-danger">' + esc(data.error || '评测失败') + '</div>'; return; }
        var report = data.report || '';
        var hasIssue = report && (report.indexOf("未发现明显漏洞") === -1 || report.indexOf("未通过") !== -1);
        var h = '<div style="font-size:14px;font-weight:600;margin-bottom:12px;color:' + (hasIssue ? 'var(--warning)' : 'var(--success)') + ';">' +
          (hasIssue ? '⚠️ 评测发现以下问题（逻辑漏洞或自检不通过项）' : '✅ 评测通过') + '</div>';
        h += '<div style="padding:12px;background:var(--surface2);border-radius:8px;white-space:pre-wrap;font-size:13px;line-height:1.8;max-height:480px;overflow-y:auto;color:var(--text);">' + esc(report || '（无评测结果）') + '</div>';
        h += '<div class="pipeline-buttons" style="margin-top:12px;">' +
          '<button class="btn btn-primary btn-auto" onclick="reviewAndSplitScript(\'' + id + '\')">评测并切分</button>' +
          '</div>';
        prog.innerHTML = '<div class="panel">' + h + '</div>';
      })
      .catch(function(e) { prog.innerHTML = '<div class="alert alert-danger">评测失败: ' + e.message + '</div>'; });
  }

  function reviewAndSplitScript(id) {
    var prog = document.getElementById("genProgress");
    prog.style.display = "block";
    prog.innerHTML = '<div class="panel"><h3 style="color:var(--gold);margin-bottom:8px;">🔍 评测并切分</h3><div class="progress-steps"></div></div>';

    fetch("/api/admin/scripts/" + id + "/review-split", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token }
    }).then(function(res) { return readSSE(res, prog); })
      .catch(function(e) { prog.innerHTML += '<div class="alert alert-danger mt-sm">评测切分失败: ' + e.message + '</div>'; });
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
  // HTML 转义（含引号）：esc 结果会被拼进 onclick='...' 等属性，必须转义单双引号（XSS 防护）
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ===================== 模型管理 =====================
  var _modelTesting = {};

  function loadModels() {
    var el = document.getElementById("modelsRoot");
    if (!el) return;
    api("/api/admin/models")
      .then(function(res) { return res.json(); })
      .then(function(data) {
        var h = '';
        h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
          '<span class="text-sm text-dim">通道：生成通道（主创作） / 推理通道（AI玩家·NPC·审讯）</span>' +
          '<button class="btn btn-outline btn-sm" onclick="refreshModels()">↻ 刷新</button></div>';

        ['generative', 'reasoning'].forEach(function(ch) {
          var label = ch === 'generative' ? '🖋️ 生成通道' : '🧠 推理通道';
          var models = data[ch] || [];
          h += '<div class="card card-static" style="margin-bottom:12px;padding:14px;">';
          h += '<h4 style="margin:0 0 10px;color:var(--gold);">' + label + '</h4>';

          if (models.length === 0) {
            h += '<p class="text-xs text-dim">（未配置模型，将使用环境变量默认值——请检查 .env 中对应 API Key）</p>';
          }
          models.forEach(function(m) {
            var activeTag = m.active ? '<span class="tag tag-success">当前生效</span>' : '';
            h += '<div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--border);">' +
              '<div><span style="font-weight:600;">' + esc(m.name) + '</span> ' + activeTag +
              '<div class="text-xs text-dim">模型: ' + esc(m.model || '') + (m.baseUrl ? ' | ' + esc(m.baseUrl) : '') +
              (m.apiKey ? ' | key: ' + esc(m.apiKey) : ' | key: (环境)' ) +
              (m.source === 'env' ? ' | 来源: 环境变量' : ' | 来源: 手动添加') + '</div></div>' +
              '<div class="flex" style="gap:6px;">' +
              (!m.active ? '<button class="btn btn-outline btn-xs" onclick="setActiveModel(\'' + ch + '\',\'' + esc(m.name) + '\')">设为生效</button>' : '') +
              (m.source !== 'env' ? '<button class="btn btn-outline btn-xs" onclick="deleteModel(\'' + ch + '\',\'' + esc(m.name) + '\')">删除</button>' : '') +
              '</div></div>';
          });

          // 测试成功回调反馈
          if (_modelTesting[ch]) {
            h += '<div class="alert alert-success" style="margin-top:8px;">' + esc(_modelTesting[ch]) + '</div>';
          } else if (_modelTesting[ch] === null) {
            h += '<div class="alert alert-warning" style="margin-top:8px;">测试失败，见输出</div>';
          }

          // 添加表单
          h += '<div style="margin-top:12px;padding:10px;background:var(--surface);border:1px dashed var(--border);border-radius:var(--radius);">' +
            '<div style="font-size:12px;color:var(--gold-light);margin-bottom:8px;">✚ 添加模型</div>' +
            '<div class="grid-2" style="gap:8px;margin-bottom:8px;">' +
            '<input id="mdlName_' + ch + '" class="form-input" placeholder="名称（如: deepseek-v4-flash）" />' +
            '<input id="mdlModel_' + ch + '" class="form-input" placeholder="模型名（如: deepseek-v4-flash）" />' +
            '</div>' +
            '<input id="mdlUrl_' + ch + '" class="form-input" style="margin-bottom:8px;" placeholder="API Base URL（如 https://api.deepseek.com）" />' +
            '<input id="mdlKey_' + ch + '" class="form-input" style="margin-bottom:8px;" type="password" placeholder="API Key（留空则用环境变量）" />' +
            '<div class="flex" style="gap:8px;">' +
            '<button class="btn btn-primary btn-sm" onclick="addModel(\'' + ch + '\')">添加并生效</button>' +
            '<button class="btn btn-outline btn-sm" onclick="testModel(\'' + ch + '\')">测试连通</button>' +
            '</div></div>';

          h += '</div>';
        });
        el.innerHTML = h;
      })
      .catch(function(e) {
        console.error("[admin] loadModels failed:", e.message);
        el.innerHTML = '<div class="state-error">加载模型失败: ' + esc(e.message) + '</div>';
      });
  }

  function addModel(channel) {
    var name = document.getElementById("mdlName_" + channel).value.trim();
    var model = document.getElementById("mdlModel_" + channel).value.trim();
    var baseUrl = document.getElementById("mdlUrl_" + channel).value.trim();
    var apiKey = document.getElementById("mdlKey_" + channel).value.trim();
    if (!name || !model) { showToast("请填写名称与模型名", "warning"); return; }
    api("/api/admin/models/" + channel, {
      method: "POST",
      body: JSON.stringify({ name: name, model: model, baseUrl: baseUrl, apiKey: apiKey })
    }).then(function(res) { return res.json(); })
      .then(function(d) {
        if (d.error) { showToast(d.error, "error"); return; }
        // 添加后默认设为生效
        return api("/api/admin/models/" + channel + "/active", {
          method: "POST", body: JSON.stringify({ name: name })
        }).then(function() { return d; });
      })
      .then(function() {
        showToast("模型已添加并生效", "success");
        loadModels();
      })
      .catch(function(e) { showToast("添加失败: " + e.message, "error"); });
  }

  function setActiveModel(channel, name) {
    if (!confirm("将「" + name + "」设为" + (channel === 'generative' ? '生成通道' : '推理通道') + "当前生效模型？切换即时生效，无需重启。")) return;
    api("/api/admin/models/" + channel + "/active", {
      method: "POST", body: JSON.stringify({ name: name })
    }).then(function(res) { return res.json(); })
      .then(function(d) {
        if (d.error) { showToast(d.error, "error"); return; }
        showToast("已切换生效模型: " + name, "success");
        loadModels();
      })
      .catch(function(e) { showToast("切换失败: " + e.message, "error"); });
  }

  function deleteModel(channel, name) {
    if (!confirm("删除模型「" + name + "」？")) return;
    api("/api/admin/models/" + channel + "/" + encodeURIComponent(name), { method: "DELETE" })
      .then(function(res) { return res.json(); })
      .then(function() { loadModels(); showToast("已删除", "info"); })
      .catch(function(e) { showToast("删除失败: " + e.message, "error"); });
  }

  // 测试连通（SSE）
  function testModel(channel) {
    var name = document.getElementById("mdlName_" + channel).value.trim();
    var model = document.getElementById("mdlModel_" + channel).value.trim();
    var baseUrl = document.getElementById("mdlUrl_" + channel).value.trim();
    var apiKey = document.getElementById("mdlKey_" + channel).value.trim();
    if (!model) { showToast("请填写模型名", "warning"); return; }
    _modelTesting[channel] = '测试中...';
    loadModels();
    var params = new URLSearchParams({ model: model, name: name, baseUrl: baseUrl, apiKey: apiKey }).toString();
    var ev = new EventSource("/api/admin/models/" + channel + "/test?" + params);
    var done = false;
    function finish() { if (!done) { done = true; ev.close(); } }
    ev.addEventListener("complete", function(e) {
      finish();
      try { var d = JSON.parse(e.data); _modelTesting[channel] = "✅ 连通成功（HTTP " + d.httpStatus + "）模型 " + d.model + (d.reply ? "，回复: " + d.reply : ""); } catch (err) { _modelTesting[channel] = "✅ 连通成功"; }
      loadModels();
    });
    ev.addEventListener("error", function(e) {
      // error 事件也可能带 data（后端发的 error event）；读不到就提示失败
      var msg = "";
      if (e.data) { try { msg = JSON.parse(e.data).message || e.data; } catch (err) { msg = e.data; } }
      finish();
      _modelTesting[channel] = "❌ 测试失败" + (msg ? ": " + msg : "");
      loadModels();
    });
    // 后端 data: {"message":"..."} 普通事件兜底
    ev.onmessage = function(e) {
      try { var d = JSON.parse(e.data); if (d && d.message) { _modelTesting[channel] = "❌ " + d.message; } } catch (err) {}
    };
  }

  function refreshModels() {
    delete _modelTesting.generative;
    delete _modelTesting.reasoning;
    loadModels();
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
  window.reviewAndSplitScript = reviewAndSplitScript;
  window.splitScriptBtn = splitScriptBtn;
  window.loadUsers = loadUsers;
  window.toggleRole = toggleRole;
  window.delUser = delUser;
  window.loadRooms = loadRooms;
  window.createRoom = createRoom;
  window.createRoomFromScript = createRoomFromScript;
  window.closeRoom = closeRoom;
  window.syncNow = syncNow;
  window.loadModels = loadModels;
  window.addModel = addModel;
  window.setActiveModel = setActiveModel;
  window.deleteModel = deleteModel;
  window.testModel = testModel;
  window.refreshModels = refreshModels;

  // ===================== Init =====================
  initScriptSearch();
  loadScripts();
  renderPipeline();
})();
