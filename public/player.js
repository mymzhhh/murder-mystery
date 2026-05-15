/* ===================== 剧本杀 — 玩家端 v2 ===================== */
(function() {
  "use strict";

  // ===================== Auth & Init =====================
  var token = localStorage.getItem("token");
  var username = localStorage.getItem("username");
  if (!token) { location.href = "/login.html"; return; }

  document.getElementById("userInfo").textContent = "玩家: " + username;

  // ===================== API Helpers =====================
  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    headers["Content-Type"] = "application/json";
    headers["Authorization"] = "Bearer " + token;
    return fetch(path, { method: opts.method || "GET", headers: headers, body: opts.body });
  }

  function check401(res) {
    if (res.status === 401) { localStorage.clear(); location.href = "/login.html"; return true; }
    return false;
  }

  function doLogout() {
    localStorage.clear();
    sessionStorage.removeItem("_roomCode");
    location.href = "/login.html";
  }

  // ===================== Game State =====================
  var gs = {
    room: null,
    roomCode: null,
    phase: "lobby",
    players: [],
    myCharacter: null,
    myClues: [],
    chatMessages: [],
    voteTarget: null,
    phaseConfig: {},
    narrative: "",
    readyCount: 0,
    totalReadyCount: 0,
    _amIReady: false,
    _countdown: undefined,
    scriptSummary: null,
    allCharacters: [],
    totalSlots: 0
  };

  // ===================== Toast Notifications =====================
  function ensureToastContainer() {
    var el = document.getElementById("toastContainer");
    if (el) return el;
    el = document.createElement("div");
    el.id = "toastContainer";
    el.className = "toast-container";
    document.body.appendChild(el);
    return el;
  }

  function showToast(msg, type) {
    type = type || "info";
    var container = ensureToastContainer();
    var toast = document.createElement("div");
    toast.className = "toast toast-" + type;
    toast.textContent = msg;
    container.appendChild(toast);

    setTimeout(function() {
      toast.classList.add("removing");
      setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
    }, 3500);
  }

  // ===================== Script Data =====================
  window._scriptDataMap = {};

  function loadMyScripts() {
    api("/api/player/scripts")
      .then(function(res) {
        if (check401(res)) return;
        return res.json().then(function(data) {
          window._scriptDataMap = {};
          (data.scripts || []).forEach(function(s) { window._scriptDataMap[s.sessionId] = s; });
          var sel = document.getElementById("createScriptSelect");
          if (!sel) return;
          sel.innerHTML = '<option value="">-- 选择一个剧本 --</option>' +
            data.scripts.map(function(s) {
              return '<option value="' + esc(s.sessionId) + '">' + esc(s.title || s.topic) + ' (' + (s.characterCount || '?') + '人本)</option>';
            }).join("");
        });
      })
      .catch(function(e) { console.error("loadMyScripts error:", e.message); });
  }

  function loadRooms() {
    api("/api/player/rooms")
      .then(function(res) {
        if (check401(res)) return;
        return res.json().then(function(data) {
          var el = document.getElementById("roomList");
          if (!el) return;
          if (!data.rooms || data.rooms.length === 0) {
            el.innerHTML = '<div class="state-empty">暂无可用房间</div>';
            return;
          }
          el.innerHTML = data.rooms.map(function(r) {
            return '<div class="card" onclick="joinRoomDirect(\'' + esc(r.roomCode) + '\')"><h4 style="margin-bottom:6px;">' + esc(r.title || '') + '</h4><div class="text-xs text-dim">' + esc(r.setting && r.setting.era || '') + ' | ' + (r.availableCharacters || []).join(', ') + '</div><div class="text-xs text-dim mt-sm">' + r.playerCount + '/' + r.maxPlayers + '人</div></div>';
          }).join("");
        });
      })
      .catch(function(e) { console.error("loadRooms error:", e.message); });
  }

  // Load immediately
  loadMyScripts();
  loadRooms();

  // ===================== WebSocket Setup =====================
  var socket = null;

  try {
    socket = io({ transports: ["websocket", "polling"] });

    socket.on("connect", function() {
      loadRooms();
      var savedRoom = sessionStorage.getItem("_roomCode");
      if (savedRoom && token) {
        document.getElementById("lobbyView").style.display = "none";
        document.getElementById("gameView").style.display = "block";
        document.getElementById("gameContent").innerHTML = '<div class="state-loading" style="padding:60px;"><h3 style="color:var(--gold);">重新连接中...</h3><p class="text-dim">正在恢复游戏进度</p></div>';
        socket.emit("join_room", { roomCode: savedRoom, token: token });
      }
    });

    socket.on("room_state", function(data) {
      gs = Object.assign(gs, data);
      if (gs.room && gs.room.roomCode) sessionStorage.setItem("_roomCode", gs.room.roomCode);
      showGame();
    });

    socket.on("room_updated", function(data) {
      gs.players = data.players;
      if (data.ownerId) { gs.room = gs.room || {}; gs.room.ownerId = data.ownerId; }
      if (gs.phase === "lobby") { renderLobbyInGame(); return; }
      updatePlayerList();
      updateCharSelect();
    });

    socket.on("character_selected", function(data) {
      gs.myCharacter = data.character;
      updateCharSelect();
    });

    socket.on("game_started", function(data) {
      gs.phase = data.phase;
      gs.narrative = data.narrative || "";
      var overlay = document.getElementById("startCountdown");
      if (overlay) overlay.remove();
      renderGame();
    });

    socket.on("phase_changed", function(data) {
      gs.phase = data.phase;
      gs.phaseConfig = data.config || {};
      gs.narrative = data.narrative || "";
      gs._amIReady = false;
      gs.readyCount = 0;
      renderGame();
    });

    socket.on("clue_received", function(data) {
      data.clue.foundByName = data.foundBy;
      gs.myClues.push(data.clue);
      showToast("获得新线索: " + (data.clue.id || "未知"), "success");
      if (gs.phase && gs.phase.includes("investigation")) renderInvestigation();
    });

    socket.on("chat_message", function(data) {
      gs.chatMessages.push(data);

      // NPC reply → dialog
      if (data.playerId && data.playerId.startsWith("npc_")) {
        var npcName = data.characterName;
        if (npcName) {
          var chats = window._npcChats[npcName] || [];
          var content = (data.content || "").replace(/^\[回复 .+?\]\s*/, "");
          chats.push({ role: "npc", content: content });
          window._npcChats[npcName] = chats;
          refreshNpcDialog(npcName);
        }
      }

      setTimeout(refreshSidebar, 50);
    });

    socket.on("ready_update", function(data) {
      gs.readyCount = data.readyCount;
      gs.totalReadyCount = data.totalCount;
      if (data.countdown !== undefined) {
        gs._countdown = data.countdown;
        if (data.countdown === 0) { gs.readyCount = 0; gs._countdown = undefined; }
      }
      updateTopBarReady();
    });

    socket.on("vote_recorded", function(data) {
      gs.voteTarget = data.target;
      showToast("已投票: " + data.target, "info");
      renderVoting();
    });

    socket.on("vote_update", function() { renderVoting(); });

    socket.on("truth_revealed", function(data) {
      gs.phase = "truth_reveal";
      renderTruth(data);
    });

    socket.on("game_ended", function() { location.reload(); });

    socket.on("narrative", function(data) {
      gs.narrative = data.text;
      renderGame();
    });

    socket.on("error", function(data) {
      showToast(data.message || "发生错误", "error");
    });

    socket.on("left_room", function() { location.reload(); });

    socket.on("disconnect", function() {
      showToast("连接断开，正在重连...", "warning");
    });

  } catch (e) {
    console.error("socket init error:", e.message);
    showToast("无法连接到游戏服务器", "error");
  }

  // ===================== Room Actions =====================
  function joinRoom() {
    var code = document.getElementById("roomCodeInput").value.toUpperCase().trim();
    if (code.length < 4) { showToast("请输入有效的房间码", "warning"); return; }
    if (socket) socket.emit("join_room", { roomCode: code, token: token });
  }

  function joinRoomDirect(code) {
    if (socket) socket.emit("join_room", { roomCode: code, token: token });
  }

  // ===================== Script Selection =====================
  function onScriptSelect() {
    var sid = document.getElementById("createScriptSelect").value;
    var s = window._scriptDataMap[sid];
    var preview = document.getElementById("scriptPreview");
    var btn = document.getElementById("btnCreateRoom");
    var maxInput = document.getElementById("createMaxPlayers");

    if (!s) {
      preview.style.display = "none";
      btn.disabled = true;
      btn.textContent = "请先选择剧本";
      maxInput.value = "";
      return;
    }

    maxInput.value = s.characterCount || 6;
    btn.disabled = false;
    btn.textContent = "创建房间（" + (s.characterCount || 6) + "人本）";

    preview.style.display = "block";
    preview.innerHTML = '<div class="card" style="margin-bottom:12px;border-color:var(--gold);"><h4 style="color:var(--gold-light);">' + esc(s.title || s.topic) + '</h4><div class="text-sm text-dim mt-sm"><span>' + (s.characterCount || '?') + ' 个角色</span></div></div>';
  }

  async function createMyRoom() {
    var sid = document.getElementById("createScriptSelect").value;
    var max = document.getElementById("createMaxPlayers").value;
    if (!sid) { showToast("请先选择一个剧本", "warning"); return; }

    try {
      var res = await api("/api/player/rooms", {
        method: "POST",
        body: JSON.stringify({ scriptSessionId: sid, maxPlayers: max })
      });
      var data = await res.json();
      if (!data.roomCode) {
        showToast("创建房间失败: " + (data.error || "未知错误"), "error");
        return;
      }

      var el = document.getElementById("createResult");
      el.style.display = "block";
      var code = data.roomCode;
      el.innerHTML = '<div style="padding:20px;background:var(--surface2);border-radius:12px;text-align:center;border:2px solid var(--success);">' +
        '<p class="text-sm text-dim mb-sm">房间已创建！分享房间码给朋友</p>' +
        '<div class="room-code-lg" id="myRoomCode" style="font-size:36px;cursor:pointer;">' + esc(code) + '</div>' +
        '<p class="text-xs text-dim mt-sm">点击房间码复制 | 即将自动进入...</p>' +
        '<p class="text-xs text-dim mt-sm">' + data.characterCount + '个角色：' + (data.characters || []).join('、') + '</p>' +
        '</div>';

      if (socket && socket.connected) {
        joinMyRoom(code);
      } else {
        socket.once("connect", function() { joinMyRoom(code); });
      }

      document.getElementById("myRoomCode").addEventListener("click", copyRoomCode);
      loadRooms();
    } catch (e) {
      showToast("创建失败: " + e.message, "error");
    }
  }

  function copyRoomCode() {
    var codeEl = document.getElementById("myRoomCode");
    var code = codeEl ? codeEl.textContent.trim() : "";
    if (!code) return;
    navigator.clipboard.writeText(code).then(function() {
      showToast("房间码已复制: " + code + "，发送给朋友即可加入！", "success");
    }).catch(function() {
      showToast("房间码: " + code + "，请手动复制发送给朋友", "info");
    });
  }

  function joinMyRoom(code) {
    socket.emit("join_room", { roomCode: code, token: token });
  }

  function leaveRoom() {
    sessionStorage.removeItem("_roomCode");
    var code = gs.room && gs.room.roomCode;
    if (socket && code) socket.emit("leave_room", { roomCode: code });
  }

  // ===================== View Switching =====================
  function showGame() {
    document.getElementById("lobbyView").style.display = "none";
    document.getElementById("gameView").style.display = "block";
    if (gs.phase && gs.phase !== "lobby") { renderGame(); return; }
    renderLobbyInGame();
  }

  // ===================== Lobby in Game =====================
  function renderLobbyInGame() {
    var el = document.getElementById("gameContent");
    var parsed = gs.scriptSummary || {};
    var humanPlayers = (gs.players || []).filter(function(p) { return !p.isNPC; });
    var totalSlots = gs.totalSlots || (gs.allCharacters || []).filter(function(c) { return c.roleType !== 'npc'; }).length;
    var assignedCount = humanPlayers.filter(function(p) { return p.characterName; }).length;
    var canStart = humanPlayers.length >= totalSlots && assignedCount >= humanPlayers.length && humanPlayers.length >= 1;
    var isOwner = gs.room && gs.room.ownerId === gs.playerId;

    var h = '<div class="panel"><div class="text-center" style="margin:20px 0;">' +
      '<h3>房间 ' + esc(gs.room && gs.room.roomCode) + '</h3>' +
      '<p class="text-dim">' + esc(parsed.title || '剧本杀') + '</p>' +
      '<p class="text-sm text-dim">' + esc(parsed.setting && parsed.setting.era || '') + ' | ' + esc(parsed.setting && parsed.setting.location || '') + '</p>' +
      '<p class="text-xs" style="color:var(--gold);">' + humanPlayers.length + '/' + totalSlots + '人 | ' + assignedCount + '人已选角色</p>' +
      '</div>';

    h += '<div class="grid-2"><div><h4>玩家列表</h4><div id="playerListEl">' +
      gs.players.map(function(p) {
        var label = esc(p.playerName) + (p.characterName ? ' → ' + esc(p.characterName) : ' (未选角色)');
        if (p.isOwner) label = '👑 ' + label;
        return '<div class="card card-static" style="margin-bottom:4px;padding:10px;">' + label + '</div>';
      }).join("") +
      '</div></div><div><h4>选择你的角色</h4><div id="charSelectEl"></div></div></div>';

    h += '<div class="text-center mt-lg">' +
      '<button class="btn btn-outline btn-auto" onclick="leaveRoom()" style="margin-right:8px;">离开房间</button>';
    if (isOwner) {
      h += '<button class="btn btn-success btn-auto" onclick="startGame()"' + (canStart ? '' : ' disabled style="opacity:0.5;"') + '>' +
        (canStart ? '开始游戏（AI DM主持）' : (humanPlayers.length < totalSlots ? '等待玩家加入...' : '等待所有人选择角色...')) + '</button>';
    } else {
      h += '<span class="text-sm text-dim">等待房主开始游戏...</span>';
    }
    h += '</div></div>';

    el.innerHTML = h;
    loadCharOptions();
  }

  function loadCharOptions() {
    api("/api/player/rooms").then(function(res) {
      return res.json();
    }).then(function(data) {
      var room = (data.rooms || []).find(function(r) { return r.roomCode === (gs.room && gs.room.roomCode); });
      var sel = document.getElementById("charSelectEl");
      if (!sel || !room) return;
      sel.innerHTML = (room.availableCharacters || []).map(function(c) {
        return '<button class="btn btn-outline btn-auto" style="margin:4px;" onclick="selectChar(\'' + esc(c) + '\')">' + esc(c) + '</button>';
      }).join("") || '<span class="text-dim">暂无可用角色</span>';
    }).catch(function() {});
  }

  function selectChar(name) {
    socket.emit("select_character", { roomCode: gs.room && gs.room.roomCode, characterName: name });
  }

  function updatePlayerList() {
    var list = document.getElementById("playerListEl");
    if (!list) return;
    list.innerHTML = gs.players.map(function(p) {
      var label = esc(p.playerName) + (p.characterName ? ' → ' + esc(p.characterName) : ' (未选角色)');
      if (p.isOwner) label = '👑 ' + label;
      return '<div class="card card-static" style="margin-bottom:4px;padding:10px;">' + label + '</div>';
    }).join("");
  }

  function updateCharSelect() {
    var sel = document.getElementById("charSelectEl");
    if (!sel) return;
    var assigned = gs.players.map(function(p) { return p.characterName; }).filter(Boolean);
    var chars = (gs.allCharacters || []).filter(function(c) { return c.roleType !== 'npc'; });
    if (chars.length === 0) { loadCharOptions(); return; }
    var me = gs.players.find(function(p) { return p.playerId === gs.playerId; });
    var myChar = me ? me.characterName : null;
    sel.innerHTML = chars.map(function(c) {
      var name = c.name || c;
      var taken = assigned.indexOf(name) !== -1 && name !== myChar;
      if (c.roleType === "npc") {
        return '<button class="btn btn-outline btn-auto" style="margin:4px;opacity:0.3;cursor:not-allowed;" disabled>' + esc(name) + ' [NPC]</button>';
      }
      return '<button class="btn btn-outline btn-auto" style="margin:4px;' + (taken ? 'opacity:0.4;' : '') + (name === myChar ? 'border-color:var(--gold);' : '') + '" onclick="selectChar(\'' + esc(name) + '\')"' + (taken ? ' disabled' : '') + '>' + esc(name) + '</button>';
    }).join("") || '<span class="text-dim">暂无可用角色</span>';
  }

  // ===================== Start Game =====================
  function startGame() {
    if (!confirm("确定开始游戏？AI DM将自动主持整个游戏流程。")) return;

    var overlay = document.createElement("div");
    overlay.id = "startCountdown";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;";
    overlay.innerHTML = '<div style="color:var(--gold);font-size:24px;" id="countdownText">AI DM 正在准备游戏...</div>' +
      '<div class="progress-bar" style="width:200px;margin-top:20px;"><div class="progress-fill" style="width:100%;"></div></div>';
    document.body.appendChild(overlay);

    var dots = 0;
    var timer = setInterval(function() {
      dots = (dots + 1) % 4;
      var el = document.getElementById("countdownText");
      if (el) el.innerHTML = "AI DM 正在准备游戏" + ".".repeat(dots) + " ".repeat(3 - dots);
      if (!document.getElementById("startCountdown")) clearInterval(timer);
    }, 500);

    socket.emit("start_game", { roomCode: gs.room && gs.room.roomCode });
    var onStarted = function() {
      var ov = document.getElementById("startCountdown");
      if (ov) ov.remove();
      clearInterval(timer);
      socket.off("game_started", onStarted);
    };
    socket.on("game_started", onStarted);
  }

  // ===================== Game Rendering =====================
  function renderGame() {
    var p = gs.phase;
    if (p === "reading") renderReading();
    else if (p.indexOf("investigation") !== -1) renderInvestigation();
    else if (p.indexOf("discussion") !== -1 || p === "round3") renderDiscussion();
    else if (p === "voting") renderVoting();
    else if (p === "truth_reveal") renderTruth();
  }

  // ===================== Top Bar =====================
  function topBar(phase) {
    var labels = {
      reading: "阅读剧本",
      round1_investigation: "第一轮搜证", round1_discussion: "第一轮讨论",
      round2_investigation: "第二轮搜证", round2_discussion: "第二轮讨论",
      round3: "最终轮", voting: "投票", truth_reveal: "真相"
    };
    var cls = "phase-reading";
    if (phase.indexOf("investigation") !== -1) cls = "phase-investigation";
    else if (phase.indexOf("discussion") !== -1 || phase === "round3") cls = "phase-discussion";
    else if (phase === "voting") cls = "phase-voting";

    var h = '<div class="flex-between flex-wrap gap-sm mb">';
    h += '<div class="flex-center gap-sm flex-wrap">';
    h += '<span class="text-sm text-dim">房间 ' + esc(gs.room && gs.room.roomCode || '') + '</span>';
    h += '<span class="phase-indicator ' + cls + '">' + (labels[phase] || phase) + '</span>';
    h += '<span class="text-sm text-dim">角色: ' + esc(gs.myCharacter && gs.myCharacter.name || '未选择') + '</span>';
    h += '</div>';

    var readyCount = gs.readyCount || 0;
    var totalReady = gs.totalReadyCount || 0;
    var btnText = readyCount > 0 ? ('就绪 ' + readyCount + '/' + totalReady) : '进入下一阶段';
    h += '<button class="btn btn-outline btn-sm btn-auto" id="readyBtn" onclick="doReady()">' + btnText + '</button>';
    h += '</div>';
    return h;
  }

  function updateTopBarReady() {
    var btn = document.getElementById("readyBtn");
    if (!btn) return;
    var cd = gs._countdown;
    if (cd !== undefined && cd > 0) {
      btn.textContent = '即将切换... ' + cd;
      btn.disabled = true;
      btn.style.opacity = '0.7';
      btn.style.color = 'var(--gold)';
      return;
    }
    var readyCount = gs.readyCount || 0;
    var totalReady = gs.totalReadyCount || 0;
    if (readyCount > 0) {
      btn.textContent = '就绪 ' + readyCount + '/' + totalReady;
    } else {
      btn.textContent = gs._amIReady ? '等待其他人...' : '进入下一阶段';
    }
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.color = '';
  }

  function doReady() {
    gs._amIReady = true;
    socket.emit("ready", { roomCode: gs.room && gs.room.roomCode });
    updateTopBarReady();
  }

  // ===================== Sidebar =====================
  window._sidebarTab = "chat";

  function sidePanel(activeTab) {
    activeTab = activeTab || window._sidebarTab || "chat";
    window._sidebarTab = activeTab;
    var myId = socket && socket.id;

    var h = '';

    // Players
    h += '<div class="panel" style="margin-bottom:8px;"><h4 style="font-size:13px;margin-bottom:4px;">玩家</h4>';
    (gs.players || []).forEach(function(p) {
      var isMe = p.playerId === myId;
      var isNPC = p.isNPC || (p.playerId && p.playerId.indexOf("npc_") === 0);
      h += '<div class="flex-between" style="padding:2px 0;font-size:11px;">' +
        '<span>' + esc(p.characterName || p.playerName) + (isMe ? ' (你)' : '') + (isNPC ? ' <span class="tag tag-npc">NPC</span>' : '') + '</span>' +
        '</div>';
    });
    h += '</div>';

    // Tabs
    var hasNpcs = (gs.allCharacters || []).some(function(c) { return c.roleType === 'npc'; });
    h += '<div class="sidebar-tabs">' +
      '<button class="sidebar-tab ' + (activeTab === 'script' ? 'active' : '') + '" onclick="switchSidebarTab(\'script\')">📜 剧本</button>' +
      '<button class="sidebar-tab ' + (activeTab === 'clues' ? 'active' : '') + '" onclick="switchSidebarTab(\'clues\')">🔍 线索</button>';
    if (hasNpcs) h += '<button class="sidebar-tab ' + (activeTab === 'interrogate' ? 'active' : '') + '" onclick="switchSidebarTab(\'interrogate\')">🎤 审讯</button>';
    h += '<button class="sidebar-tab ' + (activeTab === 'layout' ? 'active' : '') + '" onclick="switchSidebarTab(\'layout\')">🗺️ 布局</button>' +
      '<button class="sidebar-tab ' + (activeTab === 'chat' ? 'active' : '') + '" onclick="switchSidebarTab(\'chat\')">💬 聊天</button>' +
      '</div>';

    h += '<div class="sidebar-tab-content" id="sidebarTabContent">';

    if (activeTab === 'script') {
      var char = gs.myCharacter || {};
      var s = char.script || {};
      var fullScript = s.playerScript || s.fullScript || s.story || '';
      h += '<div class="sidebar-script">';
      if (char.name) {
        h += '<h4 style="color:var(--gold);margin-bottom:8px;">' + esc(char.name) + ' 的角色剧本</h4>';
        if (char.isMurderer) h += '<div class="murderer-tag" style="margin-bottom:8px;">你是凶手</div>';
      }
      if (fullScript) {
        h += '<div style="white-space:pre-wrap;font-size:12px;line-height:1.7;max-height:500px;overflow-y:auto;">' + md2html(String(fullScript || '')) + '</div>';
      }
      if (s.secret) {
        h += '<details class="script-detail" style="margin-top:8px;"><summary style="color:var(--blood-light);">你的秘密</summary><div style="white-space:pre-wrap;font-size:12px;line-height:1.6;">' + esc(String(s.secret).substring(0, 2000)) + '</div></details>';
      }
      var sections = [['你的时间线', s.personalTimeline], ['你的目标', s.goals], ['你已知晓', s.knownInfo], ['你的物品', s.items]];
      var hasExtra = sections.some(function(sec) { return sec[1]; });
      if (hasExtra) {
        sections.forEach(function(sec) {
          if (!sec[1]) return;
          h += '<details class="script-detail"><summary>' + esc(sec[0]) + '</summary><div style="white-space:pre-wrap;font-size:12px;line-height:1.6;">' + esc(String(sec[1]).substring(0, 2000)) + '</div></details>';
        });
      }
      h += '</div>';

    } else if (activeTab === 'clues') {
      h += '<div class="sidebar-clues">';
      if (gs.myClues.length === 0) {
        h += '<div class="state-empty" style="padding:20px;">暂无线索</div>';
      } else {
        gs.myClues.forEach(function(c) {
          var isPhysical = c.clueType && !/人证/.test(c.clueType);
          var locHtml = (isPhysical && c.location) ? '<div style="font-size:10px;color:var(--gold);">📍 ' + esc(c.location) + '</div>' : '';
          h += '<div class="sidebar-clue-card"><div class="clue-id">' + esc(c.id) + ((c.foundByName || c.foundBy) ? ' <span class="text-xs text-dim">— ' + esc(c.foundByName || c.foundBy) + ' 发现</span>' : '') + '</div>' + locHtml + '<div class="text-xs">' + esc(String(c.content || '').substring(0, 300)) + '</div></div>';
        });
      }
      h += '</div>';

    } else if (activeTab === 'interrogate') {
      var npcs = (gs.allCharacters || []).filter(function(c) { return c.roleType === 'npc'; });
      h += '<div class="sidebar-script" style="max-height:450px;">';
      h += '<p class="text-xs text-dim mb-sm">点击NPC进行审讯（对话全员可见）</p>';
      npcs.forEach(function(npc) {
        h += '<div class="npc-card" onclick="openNpcDialog(\'' + esc(npc.name) + '\')">' +
          '<span style="color:var(--gold);font-weight:600;">' + esc(npc.name) + '</span>' +
          (npc.occupation ? '<span class="text-xs text-dim" style="margin-left:6px;">' + esc(npc.occupation) + '</span>' : '') +
          '<span style="float:right;font-size:11px;color:var(--text-dim);">审讯 ▶</span>' +
          '</div>';
      });
      h += '</div>';

    } else if (activeTab === 'layout') {
      var layoutDesc = (gs.scriptSummary && gs.scriptSummary.layoutDescription) || '';
      h += '<div class="sidebar-script" style="max-height:520px;overflow:auto;">';
      if (layoutDesc) {
        h += '<h4 style="color:var(--gold);margin-bottom:8px;">📍 场景布局</h4>';
        var descHtml = esc(layoutDesc);
        descHtml = descHtml.replace(/^###\s+(.+)$/gm, '<div style="font-weight:700;color:var(--gold);margin:10px 0 4px;font-size:13px;">$1</div>');
        descHtml = descHtml.replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--gold-light);">$1</strong>');
        descHtml = descHtml.replace(/^- (.+)$/gm, '<div style="padding:2px 0 2px 8px;border-left:2px solid var(--border);margin:2px 0;font-size:11px;line-height:1.6;">$1</div>');
        h += '<div style="font-size:11px;line-height:1.7;white-space:pre-wrap;">' + descHtml + '</div>';
      } else {
        h += '<div class="state-empty" style="padding:20px;">布局数据未生成或剧本中无布局描述。<br><span class="text-xs">提示：新生成的剧本包含场景布局图。</span></div>';
      }
      h += '</div>';

    } else {
      h += '<div class="chat-box" style="height:280px;"><div class="chat-messages" id="chatMsgs">';
      (gs.chatMessages || []).slice(-40).forEach(function(m) {
        h += '<div class="chat-msg"><span class="sender">' + esc(m.characterName || m.playerName) + ':</span>' + esc(m.content) + '</div>';
      });
      h += '</div><div class="chat-input-row"><input id="chatIn" placeholder="输入消息..." /><button onclick="doChat()">发送</button></div></div>';
    }

    h += '</div>';
    return h;
  }

  function switchSidebarTab(tab) {
    window._sidebarTab = tab;
    refreshSidebar();
  }

  function wrapWithSidebar(mainContent, activeTab) {
    return '<div class="game-layout"><div class="game-main">' + mainContent + '</div><div class="game-sidebar" id="gameSidebar">' + sidePanel(activeTab) + '</div></div>';
  }

  function refreshSidebar() {
    var el = document.getElementById("gameSidebar");
    if (el) el.innerHTML = sidePanel(window._sidebarTab);
  }

  // ===================== Book Reader =====================
  window._bookData = { pages: [], current: 0 };

  function renderReading() {
    var char = gs.myCharacter || {};
    var s = char.script || {};

    var sections = [];
    if (char.name) {
      sections.push({ label: char.name + ' 的角色剧本', content: char.isMurderer ? '【你是凶手】' : '', isTitle: true, isMurderer: char.isMurderer });
    }
    var secs = [
      ['你的故事', s.story], ['你的秘密', s.secret], ['你的时间线', s.personalTimeline],
      ['你的目标', s.goals], ['你掌握的信息', s.knownInfo], ['你的物品', s.items],
      ['你的谎言', s.lies], ['辩护策略', s.defenseStrategy]
    ];
    secs.forEach(function(sec) {
      if (sec[1]) sections.push({ label: sec[0], content: sec[1] });
    });

    var pages = [];
    var currentPage = '';
    var charsPerPage = 380;

    sections.forEach(function(sec) {
      if (sec.isTitle) {
        if (currentPage) { pages.push(currentPage); currentPage = ''; }
        var h = '<div style="text-align:center;padding-top:60px;"><h2 style="font-size:26px;">' + esc(sec.label) + '</h2>';
        if (sec.isMurderer) h += '<div class="murderer-tag">你是凶手</div>';
        h += '<p style="margin-top:40px;color:#8b7355;font-style:italic;">请仔细阅读，不要向其他玩家透露你的剧本内容</p></div>';
        pages.push(h);
        return;
      }

      var sectionText = '<h3>' + esc(sec.label) + '</h3><div style="white-space:pre-wrap;">' + md2html(sec.content) + '</div>';

      if (sectionText.length > charsPerPage) {
        if (currentPage) { pages.push(currentPage); currentPage = ''; }
        var paragraphs = sectionText.split(/\n{2,}/);
        paragraphs.forEach(function(para) {
          if (currentPage.length + para.length > charsPerPage && currentPage.length > 0) {
            pages.push(currentPage);
            currentPage = para;
          } else {
            currentPage += (currentPage ? '\n\n' : '') + para;
          }
        });
      } else if (currentPage.length + sectionText.length > charsPerPage && currentPage.length > 0) {
        pages.push(currentPage);
        currentPage = sectionText;
      } else {
        currentPage += (currentPage ? '\n' : '') + sectionText;
      }
    });
    if (currentPage) pages.push(currentPage);
    if (pages.length === 0) pages.push('<div style="white-space:pre-wrap;">' + esc(char.script && char.script.fullScript || JSON.stringify(char)) + '</div>');

    window._bookData = { pages: pages, current: 0 };

    var h = topBar('reading');
    h += gs.narrative ? '<div class="narrative-panel">' + esc(gs.narrative) + '</div>' : '';
    h += '<div class="book-container"><div class="book" id="bookEl">' +
      '<div class="book-page left" id="bookLeft">' + (pages[0] || '') + '<span class="page-num">1</span></div>' +
      '<div class="book-spine"></div>' +
      '<div class="book-page right" id="bookRight">' + (pages[1] || '') + '<span class="page-num">' + (pages[1] ? '2' : '') + '</span></div>' +
      '</div></div>';
    h += '<div class="book-nav">' +
      '<button onclick="flipPage(-1)" id="btnPrev" disabled>◀ 上一页</button>' +
      '<span class="page-indicator" id="pageIndicator">第 1 / ' + Math.ceil(pages.length / 2) + ' 页</span>' +
      '<button onclick="flipPage(1)" id="btnNext"' + (pages.length <= 2 ? ' disabled' : '') + '>下一页 ▶</button>' +
      '</div>';

    document.getElementById('gameContent').innerHTML = h;
  }

  function flipPage(direction) {
    var book = window._bookData;
    var newPage = book.current + direction * 2;
    if (newPage < 0 || newPage >= book.pages.length) return;

    book.current = newPage;
    var bookEl = document.getElementById('bookEl');
    var left = document.getElementById('bookLeft');
    var right = document.getElementById('bookRight');

    bookEl.classList.remove('flip-forward', 'flip-backward');
    void bookEl.offsetWidth;
    bookEl.classList.add(direction > 0 ? 'flip-forward' : 'flip-backward');

    setTimeout(function() {
      left.innerHTML = (book.pages[book.current] || '') + '<span class="page-num">' + (book.current + 1) + '</span>';
      right.innerHTML = (book.pages[book.current + 1] || '') + '<span class="page-num">' + (book.pages[book.current + 1] ? book.current + 2 : '') + '</span>';
      document.getElementById('btnPrev').disabled = book.current <= 0;
      document.getElementById('btnNext').disabled = book.current + 2 >= book.pages.length;
      document.getElementById('pageIndicator').textContent = '第 ' + (Math.floor(book.current / 2) + 1) + ' / ' + Math.ceil(book.pages.length / 2) + ' 页';
    }, 300);
  }

  // ===================== Investigation =====================
  function renderInvestigation() {
    var h = topBar(gs.phase);
    h += gs.narrative ? '<div class="narrative-panel">' + esc(gs.narrative) + '</div>' : '';
    h += '<h4 style="margin:12px 0;">已获取的线索</h4>';
    h += '<div class="clue-grid">';
    gs.myClues.forEach(function(c) {
      var isPhysical = c.clueType && !/人证/.test(c.clueType);
      var locHtml = (isPhysical && c.location) ? '<div style="font-size:10px;color:var(--gold);margin-bottom:2px;">📍 ' + esc(c.location) + '</div>' : '';
      h += '<div class="clue-card found"><div class="clue-id">' + esc(c.id) + (c.foundBy ? ' <span class="text-xs text-dim">— ' + esc(c.foundBy) + ' 发现</span>' : '') + '</div>' + locHtml + '<div class="clue-body">' + esc(c.content || '') + '</div></div>';
    });
    h += '</div>';
    // 自然语言搜证输入
    h += '<div style="margin-top:16px;display:flex;gap:8px;">';
    h += '<input id="investigateInput" class="form-input flex-1" placeholder="描述你想调查的地点或物品，如：书房的书桌抽屉" onkeydown="if(event.key===\'Enter\')investigate()" />';
    h += '<button class="btn btn-primary btn-auto" onclick="investigate()">🔍 调查</button>';
    h += '</div>';
    h += '<p class="text-xs text-dim mt-sm">输入调查地点可精准获取线索，留空则随机发放</p>';
    if (gs.myClues.length >= 3) h += '<p class="text-xs text-dim mt-sm">已获得多条线索，可以准备进入讨论阶段</p>';

    document.getElementById("gameContent").innerHTML = wrapWithSidebar(h);
    setTimeout(function() { var e = document.getElementById('chatMsgs'); if (e) e.scrollTop = e.scrollHeight; }, 100);
  }

  function investigate() {
    var input = document.getElementById("investigateInput");
    var query = input ? input.value.trim() : "";
    if (input) input.value = "";
    socket.emit("investigate", { roomCode: gs.room && gs.room.roomCode, query: query });
  }

  // ===================== NPC Dialog =====================
  window._npcChats = {};

  function openNpcDialog(npcName) {
    var chats = window._npcChats[npcName] || [];
    var h = '<div class="npc-dialog-overlay" onclick="if(event.target===this)closeNpcDialog()">' +
      '<div class="npc-dialog">' +
      '<div class="npc-dialog-header"><span>🎤 审讯 ' + esc(npcName) + '</span>' +
      '<button onclick="closeNpcDialog()" style="background:none;border:none;color:var(--text);font-size:18px;cursor:pointer;">✕</button></div>' +
      '<div class="npc-dialog-body" id="npcDialogBody">';

    if (chats.length === 0) {
      h += '<div class="state-empty" style="padding:40px;">输入你的问题开始审讯...</div>';
    } else {
      chats.forEach(function(m) {
        h += '<div class="npc-dialog-msg"><div class="npc-dialog-role" style="color:' + (m.role === 'user' ? 'var(--gold)' : 'var(--mystic-light)') + ';">' + (m.role === 'user' ? '你' : esc(npcName)) + ':</div><div style="font-size:13px;">' + esc(m.content) + '</div></div>';
      });
    }
    h += '</div>' +
      '<div class="npc-dialog-input"><input id="npcDialogInput" placeholder="输入你的问题..." /><button onclick="askNpcInDialog(\'' + esc(npcName) + '\')">发送</button></div>' +
      '</div></div>';

    var overlay = document.getElementById("npcDialogOverlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "npcDialogOverlay";
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = h;
    overlay.style.display = "block";
    setTimeout(function() { var inp = document.getElementById("npcDialogInput"); if (inp) inp.focus(); }, 100);
  }

  function closeNpcDialog() {
    var overlay = document.getElementById("npcDialogOverlay");
    if (overlay) overlay.style.display = "none";
  }

  function askNpcInDialog(npcName) {
    var inp = document.getElementById("npcDialogInput");
    if (!inp) return;
    var q = inp.value.trim();
    if (!q) return;
    inp.value = "";

    var chats = window._npcChats[npcName] || [];
    chats.push({ role: "user", content: q });
    window._npcChats[npcName] = chats;

    socket.emit("ask_npc", { roomCode: gs.room && gs.room.roomCode, npcName: npcName, question: q });
    refreshNpcDialog(npcName);
  }

  function refreshNpcDialog(npcName) {
    var chats = window._npcChats[npcName] || [];
    var body = document.getElementById("npcDialogBody");
    if (!body) return;
    var h = '';
    chats.forEach(function(m) {
      h += '<div class="npc-dialog-msg" style="margin-bottom:8px;"><div class="npc-dialog-role" style="color:' + (m.role === 'user' ? 'var(--gold)' : 'var(--mystic-light)') + ';font-weight:600;font-size:11px;">' + (m.role === 'user' ? '你' : esc(npcName)) + ':</div><div style="font-size:13px;">' + esc(m.content) + '</div></div>';
    });
    body.innerHTML = h || '<div class="state-empty" style="padding:40px;">输入你的问题开始审讯...</div>';
    body.scrollTop = body.scrollHeight;
  }

  // ===================== Discussion =====================
  function renderDiscussion() {
    var h = topBar(gs.phase);
    h += gs.narrative ? '<div class="narrative-panel">' + esc(gs.narrative) + '</div>' : '';
    h += '<p class="text-sm text-dim mt">讨论中 — 使用右侧聊天框发送消息</p>';
    document.getElementById("gameContent").innerHTML = wrapWithSidebar(h);
    setTimeout(function() { var e = document.getElementById('chatMsgs'); if (e) e.scrollTop = e.scrollHeight; }, 100);
  }

  function doChat() {
    var inp = document.getElementById("chatIn");
    if (!inp || !inp.value.trim()) return;
    socket.emit("chat", { roomCode: gs.room && gs.room.roomCode, content: inp.value });
    inp.value = "";
  }

  // ===================== Voting =====================
  function renderVoting() {
    var h = topBar("voting");
    h += gs.narrative ? '<div class="narrative-panel">' + esc(gs.narrative) + '</div>' : '';

    var humanNames = (gs.players || []).map(function(p) { return p.characterName; }).filter(Boolean);
    var npcNames = (gs.allCharacters || []).filter(function(c) { return c.roleType === 'npc'; }).map(function(c) { return c.name; });
    var allTargets = humanNames.concat(npcNames.filter(function(n) { return humanNames.indexOf(n) === -1; }));
    var chars = allTargets.filter(function(v, i, a) { return a.indexOf(v) === i; });

    h += '<h4 style="margin:16px 0;">投票指认凶手</h4><div class="vote-grid">';
    chars.forEach(function(name) {
      h += '<div class="vote-card ' + (gs.voteTarget === name ? 'voted' : '') + '" onclick="doVote(\'' + esc(name) + '\')"><div class="name">' + esc(name) + '</div></div>';
    });
    h += '</div>';
    if (gs.voteTarget) h += '<p class="text-center mt" style="color:var(--gold-light);">你已投票: ' + esc(gs.voteTarget) + '</p>';

    document.getElementById("gameContent").innerHTML = wrapWithSidebar(h);
    setTimeout(function() { var e = document.getElementById('chatMsgs'); if (e) e.scrollTop = e.scrollHeight; }, 100);
  }

  function doVote(target) {
    socket.emit("vote", { roomCode: gs.room && gs.room.roomCode, targetCharacterName: target });
  }

  // ===================== Truth Reveal =====================
  window._truthData = null;

  function renderTruth(data) {
    if (data && data.murdererName) window._truthData = data;
    data = data || window._truthData || {};

    var h = '<div class="reveal-container">' +
      '<h2>' + (data.outcome === 'true_accusation' ? '案件告破！' : '真相大白') + '</h2>' +
      (data.murdererName ? '<div class="murderer">凶手：' + esc(data.murdererName) + '</div>' : '') +
      (data.narrative ? '<div class="outcome">' + esc(data.narrative) + '</div>' : data.description ? '<div class="outcome">' + esc(data.description) + '</div>' : '');

    if (data.votes) {
      h += '<div style="margin-top:16px;">';
      Object.keys(data.votes).forEach(function(name) {
        h += '<div>' + esc(name) + ': ' + data.votes[name] + ' 票</div>';
      });
      h += '</div>';
    }
    h += '</div>';

    document.getElementById("gameContent").innerHTML = wrapWithSidebar(h, "chat");
    setTimeout(function() { var e = document.getElementById('chatMsgs'); if (e) e.scrollTop = e.scrollHeight; }, 100);
  }

  // ===================== Utility =====================
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = String(s || "");
    return d.innerHTML;
  }

  function md2html(text) {
    var s = esc(String(text || ""));
    s = s.replace(/^#{2,3}\s+(.+?)$/gm, '<div style="font-weight:700;color:var(--gold);font-size:1.15em;margin:12px 0 6px 0;">$1</div>');
    s = s.replace(/^[（(]?[一二三四五六七八九十\d]+[）)、.]\s*.+$/gm, function(m) {
      if (m.length < 30) return '<div style="font-weight:600;color:var(--gold-light);margin:8px 0 4px 0;">' + m + '</div>';
      return m;
    });
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--gold-light);">$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    return s;
  }

  // ===================== Global Exports =====================
  window.joinRoom = joinRoom;
  window.joinRoomDirect = joinRoomDirect;
  window.onScriptSelect = onScriptSelect;
  window.createMyRoom = createMyRoom;
  window.leaveRoom = leaveRoom;
  window.selectChar = selectChar;
  window.startGame = startGame;
  window.flipPage = flipPage;
  window.investigate = investigate;
  window.doChat = doChat;
  window.doVote = doVote;
  window.doReady = doReady;
  window.switchSidebarTab = switchSidebarTab;
  window.doLogout = doLogout;
  window.openNpcDialog = openNpcDialog;
  window.closeNpcDialog = closeNpcDialog;
  window.askNpcInDialog = askNpcInDialog;

  // ===================== Sidebar Auto-Refresh =====================
  var sidePatched = false;
  function patchSidebarRefresh() {
    if (sidePatched) return;
    sidePatched = true;
    socket.on("chat_message", function() { setTimeout(refreshSidebar, 50); });
    socket.on("room_updated", function() { setTimeout(refreshSidebar, 50); });
  }
  patchSidebarRefresh();

  // ===================== Chat Input Enter =====================
  document.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && e.target.id === "chatIn") {
      doChat();
    }
  });

})();
