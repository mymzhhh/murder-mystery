    var token = localStorage.getItem("token");
    var username = localStorage.getItem("username");
    if (!token) { location.href = "/login.html"; }

    document.getElementById("userInfo").textContent = "玩家: " + username;

    // ---- API 调用（纯 HTTP，不依赖 WebSocket）----
    function api(p, o) {
      o = o || {};
      var h = o.headers || {};
      h["Content-Type"] = "application/json";
      h["Authorization"] = "Bearer " + token;
      return fetch(p, { method: o.method || "GET", headers: h, body: o.body });
    }

    // 退出登录（强制清除并跳转）
    function doLogout() {
      localStorage.clear();
      location.href = "/login.html";
    }

    // 401 检测
    function check401(res) {
      if (res.status === 401) { localStorage.clear(); location.href = "/login.html"; return true; }
      return false;
    }

    // ---- 加载剧本列表 ----
    window._scriptDataMap = {};
    async function loadMyScripts() {
      try {
        var res = await api("/api/player/scripts");
        if (check401(res)) return;
        var data = await res.json();
        window._scriptDataMap = {};
        (data.scripts || []).forEach(function(s) { window._scriptDataMap[s.sessionId] = s; });
        var sel = document.getElementById("createScriptSelect");
        if (!sel) return;
        sel.innerHTML = '<option value="">-- 选择一个剧本 --</option>' +
          data.scripts.map(function(s) {
            return '<option value="' + s.sessionId + '">' + esc(s.title || s.topic) + ' (' + (s.characterCount || '?') + '人本)</option>';
          }).join("");
      } catch(e) { console.error("loadScripts error:", e.message); }
    }

    // ---- 加载可加入的房间 ----
    async function loadRooms() {
      try {
        var res = await api("/api/player/rooms");
        if (check401(res)) return;
        var data = await res.json();
        var el = document.getElementById("roomList");
        if (!el) return;
        if (data.rooms.length === 0) { el.innerHTML = '<span style="color:var(--text2);">暂无可用房间</span>'; return; }
        el.innerHTML = data.rooms.map(function(r) {
          return '<div class="card" onclick="joinRoomDirect(\'' + r.roomCode + '\')" style="cursor:pointer;"><h4 style="margin-bottom:6px;">' + esc(r.title||'') + '</h4><div style="font-size:12px;color:var(--text2);"><div>' + esc(r.setting?.era||'') + ' | ' + (r.availableCharacters||[]).join(', ') + '</div><div>' + r.playerCount + '/' + r.maxPlayers + '人</div></div></div>';
        }).join("");
      } catch(e) { console.error("loadRooms error:", e.message); }
    }

    // ---- 页面初始化：立即加载数据 ----
    loadMyScripts();
    loadRooms();

    // ---- WebSocket（独立于数据加载）----
    var socket = null;
    var gs = { roomCode: null, phase: "lobby", players: [], myCharacter: null, myClues: [], chatMessages: [], voteTarget: null, phaseConfig: {}, narrative: "" };

    try {
      socket = io({ transports: ["websocket", "polling"] });
      socket.on("connect", function() { loadRooms(); });
      socket.on("room_state", function(data) { gs = Object.assign(gs, data); showGame(); });
      socket.on("room_updated", function(data) {
        gs.players = data.players;
        if (data.ownerId) { gs.room = gs.room || {}; gs.room.ownerId = data.ownerId; }
        // 在大厅阶段完全刷新（人数/开始按钮需要重新计算）
        if (gs.phase === "lobby") { renderLobbyInGame(); return; }
        updatePlayerList();
        updateCharSelect();
      });
      socket.on("character_selected", function(data) { gs.myCharacter = data.character; updateCharSelect(); });
      socket.on("game_started", function(data) { gs.phase = data.phase; gs.narrative = data.narrative || ""; renderGame(); });
      socket.on("phase_changed", function(data) { gs.phase = data.phase; gs.phaseConfig = data.config || {}; gs.narrative = data.narrative || ""; gs._amIReady = false; gs.readyCount = 0; renderGame(); });
      socket.on("clue_received", function(data) { data.clue.foundByName = data.foundBy; gs.myClues.push(data.clue); renderInvestigation(); });
      socket.on("chat_message", function(data) {
        gs.chatMessages.push(data);
        if (gs.phase.includes("discussion") || gs.phase === "round3" || gs.phase === "voting") renderDiscussion();
        else if (gs.phase.includes("investigation")) renderInvestigation();
      });
      socket.on("ready_update", function(data) {
        gs.readyCount = data.readyCount;
        gs.totalReadyCount = data.totalCount;
        if (data.advancing) { gs.readyCount = 0; return; }
        updateTopBarReady();
      });
      socket.on("vote_recorded", function(data) { gs.voteTarget = data.target; renderVoting(); });
      socket.on("vote_update", function(data) { renderVoting(); });
      socket.on("truth_revealed", function(data) { gs.phase = "truth_reveal"; renderTruth(data); });
      socket.on("game_ended", function() { location.reload(); });
      socket.on("narrative", function(data) { gs.narrative = data.text; renderGame(); });
      socket.on("error", function(data) { alert(data.message); });
      socket.on("left_room", function() { location.reload(); });
    } catch(e) { console.error("socket init error:", e.message); }

    function joinRoom() {
      var code = document.getElementById("roomCodeInput").value.toUpperCase();
      if (code.length < 4) return alert("请输入房间码");
      if (socket) socket.emit("join_room", { roomCode: code, token: token });
    }
    function joinRoomDirect(code) { if (socket) socket.emit("join_room", { roomCode: code, token: token }); }

    function onScriptSelect() {
      var sid = document.getElementById("createScriptSelect").value;
      var s = window._scriptDataMap[sid];
      const preview = document.getElementById("scriptPreview");
      const btn = document.getElementById("btnCreateRoom");
      const maxInput = document.getElementById("createMaxPlayers");

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
      preview.innerHTML = `
        <div class="card" style="margin-bottom:12px;border-color:var(--primary);">
          <h4 style="color:var(--primary-light);">${esc(s.title || s.topic)}</h4>
          <div style="font-size:13px;color:var(--text2);margin-top:4px;">
            <span style="margin-right:12px;">${s.characterCount || '?'} 个角色</span>
          </div>
        </div>`;
    }

    async function createMyRoom() {
      const sid = document.getElementById("createScriptSelect").value;
      const max = document.getElementById("createMaxPlayers").value;
      if (!sid) return alert("请先选择一个剧本");
      try {
        const res = await api("/api/player/rooms", { method: "POST", body: JSON.stringify({ scriptSessionId: sid, maxPlayers: max }) });
        const data = await res.json();
        if (!data.roomCode) {
          alert("创建房间失败: " + (data.error || "未知错误"));
          return;
        }
        const el = document.getElementById("createResult");
        el.style.display = "block";
        var code = data.roomCode;
        el.innerHTML = `
          <div style="padding:20px;background:var(--surface2);border-radius:12px;text-align:center;border:2px solid var(--success);">
            <p style="font-size:13px;color:var(--text2);margin-bottom:8px;">房间已创建！分享房间码给朋友</p>
            <div class="room-code-lg" id="myRoomCode" style="font-size:36px;cursor:pointer;">${esc(code)}</div>
            <p style="font-size:12px;color:var(--text2);margin-top:4px;">点击房间码复制 | 即将自动进入...</p>
            <p style="font-size:11px;color:var(--text2);margin-top:8px;">${data.characterCount}个角色：${(data.characters||[]).join('、')}</p>
          </div>`;
        // 自动进入房间：socket已连接立即join，否则等connect事件
        if (socket && socket.connected) {
          joinMyRoom(code);
        } else {
          socket.once("connect", function() { joinMyRoom(code); });
        }
        document.getElementById("myRoomCode").addEventListener("click", copyRoomCode);
        loadRooms();
      } catch (e) { alert("创建失败: " + e.message); }
    }

    function copyRoomCode() {
      const code = document.getElementById("myRoomCode")?.textContent;
      if (!code) return;
      navigator.clipboard.writeText(code).then(() => {
        alert("房间码已复制: " + code + "\n发送给朋友即可加入！");
      }).catch(() => {
        alert("房间码: " + code + "\n请手动复制发送给朋友");
      });
    }

    function joinMyRoom(code) {
      socket.emit("join_room", { roomCode: code, token });
    }

    function leaveRoom() {
      var code = gs.room && gs.room.roomCode;
      if (socket && code) socket.emit("leave_room", { roomCode: code });
    }

    // === 游戏视图切换 ===
    function showGame() {
      document.getElementById("lobbyView").style.display = "none";
      document.getElementById("gameView").style.display = "block";
      if (gs.phase === "lobby" || gs.phase === "reading" && !gs.myCharacter) renderLobbyInGame();
      else renderGame();
    }

    function renderLobbyInGame() {
      const el = document.getElementById("gameContent");
      const parsed = gs.scriptSummary || {};
      const chars = parsed.characters || gs.myCharacter ? [gs.myCharacter] : [];
      const availableChars = /* get from room state */ [];

      const isOwner = gs.room?.ownerId === gs.playerId;
      const humanPlayers = (gs.players || []).filter(function(p) { return !p.isNPC; });
      const totalSlots = gs.totalSlots || (gs.allCharacters || []).filter(function(c) { return c.roleType !== 'npc'; }).length;
      const assignedCount = humanPlayers.filter(function(p) { return p.characterName; }).length;
      const canStart = humanPlayers.length >= totalSlots && assignedCount >= humanPlayers.length && humanPlayers.length >= 1;

      let h = `<div class="panel"><div style="text-align:center;margin:20px 0;">
        <h3>房间 ${gs.room?.roomCode}</h3>
        <p style="color:var(--text2);">${parsed.title||'剧本杀'}</p>
        <p style="font-size:13px;color:var(--text2);">${parsed.setting?.era||''} | ${esc(parsed.setting?.location||'')}</p>
        <p style="font-size:12px;color:var(--gold);">${humanPlayers.length}/${totalSlots}人 | ${assignedCount}人已选角色</p>
      </div>

      <div class="grid-2">
        <div>
          <h4>玩家列表</h4>
          <div id="playerListEl">${gs.players.map(function(p) {
            var label = esc(p.playerName) + (p.characterName ? ' → ' + esc(p.characterName) : ' (未选角色)');
            if (p.isOwner) label = '👑 ' + label;
            return '<div class="card" style="margin-bottom:4px;padding:10px;">' + label + '</div>';
          }).join("")}</div>
        </div>
        <div>
          <h4>选择你的角色</h4>
          <div id="charSelectEl"></div>
        </div>
      </div>`;

      h += '<div style="text-align:center;margin-top:16px;">';
      h += '<button class="btn btn-outline" onclick="leaveRoom()" style="margin-right:8px;">离开房间</button>';
      if (isOwner) {
        var btnDisabled = !canStart;
        var btnText = canStart ? '开始游戏（AI DM主持）' : (humanPlayers.length < totalSlots ? '等待玩家加入...' : '等待所有人选择角色...');
        h += '<button class="btn btn-success" onclick="startGame()"' + (btnDisabled ? ' disabled style="opacity:0.5;"' : '') + '>' + btnText + '</button>';
      } else {
        h += '<span style="color:var(--text2);font-size:13px;">等待房主开始游戏...</span>';
      }
      h += '</div>';
      h += '</div>';

      el.innerHTML = h;

      // 加载可选角色
      loadCharOptions();
    }

    async function loadCharOptions() {
      try {
        var res = await api("/api/player/rooms");
        var data = await res.json();
        var room = data.rooms.find(function(r) { return r.roomCode === (gs.room && gs.room.roomCode); });
        var sel = document.getElementById("charSelectEl");
        if (!sel || !room) return;
        sel.innerHTML = (room.availableCharacters || []).map(function(c) {
          return '<button class="btn btn-outline" style="margin:4px;" onclick="selectChar(\'' + esc(c) + '\')">' + esc(c) + '</button>';
        }).join("") || '<span style="color:var(--text2);">暂无可用角色</span>';
      } catch (e) { /* ignore */ }
    }

    function selectChar(name) {
      socket.emit("select_character", { roomCode: gs.room?.roomCode, characterName: name });
    }

    // 局部更新玩家列表（避免整页重绘导致布局跳动）
    function updatePlayerList() {
      var list = document.getElementById("playerListEl");
      if (!list) return;
      list.innerHTML = gs.players.map(function(p) {
        var label = esc(p.playerName) + (p.characterName ? ' → ' + esc(p.characterName) : ' (未选角色)');
        if (p.isOwner) label = '👑 ' + label;
        return '<div class="card" style="margin-bottom:4px;padding:10px;">' + label + '</div>';
      }).join("");
    }

    // 局部更新角色选择按钮
    function updateCharSelect() {
      var sel = document.getElementById("charSelectEl");
      if (!sel) return;
      var assigned = gs.players.map(function(p) { return p.characterName; }).filter(Boolean);
      // 只显示玩家角色（gs.allCharacters 从 room_state 获取）
      var chars = (gs.allCharacters || []).filter(function(c) { return c.roleType !== 'npc'; });
      if (chars.length === 0) { loadCharOptions(); return; }
      var me = gs.players.find(function(p) { return p.playerId === gs.playerId; });
      var myChar = me ? me.characterName : null;
      sel.innerHTML = chars.map(function(c) {
        var name = c.name || c;
        var isNpc = c.roleType === "npc";
        var taken = assigned.includes(name) && name !== myChar;
        if (isNpc) return '<button class="btn btn-outline" style="margin:4px;opacity:0.3;cursor:not-allowed;" disabled>' + esc(name) + ' [NPC]</button>';
        return '<button class="btn btn-outline" style="margin:4px;' + (taken ? 'opacity:0.4;' : '') + (name === myChar ? 'border-color:var(--primary);' : '') + '" onclick="selectChar(\'' + esc(name) + '\')"' + (taken ? ' disabled' : '') + '>' + esc(name) + '</button>';
      }).join("") || '<span style="color:var(--text2);">暂无可用角色</span>';
    }

    function startGame() {
      if (!confirm("确定开始游戏？AI DM将自动主持整个游戏流程。")) return;
      socket.emit("start_game", { roomCode: gs.room?.roomCode });
    }

    // === 游戏渲染 ===
    function renderGame() {
      const p = gs.phase;
      if (p === "reading") renderReading();
      else if (p.includes("investigation")) renderInvestigation();
      else if (p.includes("discussion") || p === "round3") renderDiscussion();
      else if (p === "voting") renderVoting();
      else if (p === "truth_reveal") renderTruth();
    }

    function topBar(phase) {
      var labels = { reading: "阅读剧本", round1_investigation: "第一轮搜证", round1_discussion: "第一轮讨论", round2_investigation: "第二轮搜证", round2_discussion: "第二轮讨论", round3: "最终轮", voting: "投票", truth_reveal: "真相" };
      var cls = phase.includes("investigation") ? "phase-investigation" : phase.includes("discussion") || phase === "round3" ? "phase-discussion" : phase === "voting" ? "phase-voting" : "phase-reading";
      var h = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;">';
      h += '<span style="font-size:13px;color:var(--text2);">房间 ' + esc(gs.room?.roomCode||'') + '</span>';
      h += '<span class="phase-indicator ' + cls + '">' + (labels[phase]||phase) + '</span>';
      h += '<span style="font-size:13px;color:var(--text2);">角色: ' + esc(gs.myCharacter?.name||'未选择') + '</span>';
      h += '<span style="flex:1;"></span>';
      var readyCount = gs.readyCount || 0;
      var totalReady = gs.totalReadyCount || 0;
      var btnText = readyCount > 0 ? ('就绪 ' + readyCount + '/' + totalReady) : '进入下一阶段';
      var isReady = gs._amIReady;
      h += '<button class="btn btn-outline btn-sm" id="readyBtn" onclick="doReady()">' + btnText + '</button>';
      h += '</div>';
      return h;
    }

    // 侧边栏当前激活的标签页
    window._sidebarTab = "chat";

    // 右侧面板：玩家列表 + 标签页（剧本/线索/聊天）
    // 从布局JSON生成ASCII平面图
    function renderAsciiMap(layout) {
      var rooms = layout.rooms || [];
      var nameMap = {}; rooms.forEach(function(r) { nameMap[r.id] = r.name; });

      // 构建连接矩阵，按楼层分组
      var floors = {};
      rooms.forEach(function(r) { var f = r.floor || 1; if (!floors[f]) floors[f] = []; floors[f].push(r); });

      var h = '';
      var floorNames = Object.keys(floors).sort();
      floorNames.forEach(function(f, fi) {
        if (floorNames.length > 1) h += '<div style="font-size:11px;color:var(--text-dim);margin:4px 0;">' + (f > 1 ? 'F' + f : '一层') + '</div>';

        var roomList = floors[f];
        var maxName = 6;
        roomList.forEach(function(r) {
          var n = (r.name || r.id).length;
          if (n > maxName) maxName = n;
        });

        // 构建连接图：每个房间一行，显示名称和出口
        h += '<div style="font-family:monospace;font-size:11px;line-height:1.6;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px;white-space:pre;overflow-x:auto;">';

        // 生成ASCII表示
        var cols = Math.min(4, roomList.length);
        var rows = Math.ceil(roomList.length / cols);
        var colW = maxName + 2;

        for (var r = 0; r < rows; r++) {
          // 上边框
          var topLine = '';
          var midLine = '';
          var botLine = '';
          for (var c = 0; c < cols; c++) {
            var idx = r * cols + c;
            if (idx >= roomList.length) break;
            var room = roomList[idx];
            var name = room.name || room.id;
            var pad = colW - name.length;
            var leftPad = Math.floor(pad / 2);
            var rightPad = pad - leftPad;

            var connector = c < cols - 1 && idx + 1 < roomList.length ? '┬' : '┐';
            if (c === 0) topLine += '┌'; else topLine += '┬';
            topLine += '─'.repeat(colW) + connector;

            midLine += '│' + ' '.repeat(leftPad) + name + ' '.repeat(rightPad) + '│';
            if (c < cols - 1 && idx + 1 < roomList.length) midLine += ' ';
          }
          // 补全行
          if (r === 0) {
            h += '<span style="color:var(--gold);">' + esc(topLine) + '</span>\n';
            h += '<span style="color:var(--text);">' + esc(midLine) + '</span>\n';
          } else {
            // 中间行用不同颜色
            h += '<span style="color:var(--text);">' + esc(midLine) + '</span>\n';
          }

          // 底部分隔线（除了最后一行）
          if (r < rows - 1) {
            var sepLine = '';
            for (var c2 = 0; c2 < cols; c2++) {
              if (r * cols + c2 >= roomList.length) break;
              if (c2 === 0) sepLine += '├'; else sepLine += '┼';
              sepLine += '─'.repeat(colW);
            }
            sepLine += '┤';
            h += '<span style="color:var(--gold);">' + esc(sepLine) + '</span>\n';
          }
        }

        // 最后一行底线
        var lastRow = roomList.slice((rows - 1) * cols);
        var bottomLine = '';
        for (var bc = 0; bc < lastRow.length; bc++) {
          if (bc === 0) bottomLine += '└'; else bottomLine += '┴';
          bottomLine += '─'.repeat(colW);
        }
        bottomLine += '┘';
        h += '<span style="color:var(--gold);">' + esc(bottomLine) + '</span>\n';

        h += '</div>';

        // 房间标注（含特征和出口）
        h += '<div style="margin-top:6px;font-size:10px;">';
        roomList.forEach(function(room) {
          var isCrime = room.isCrimeScene;
          var owner = room.owner ? ' <span style="color:var(--text-dim);">(' + esc(room.owner) + ')</span>' : '';
          h += '<div style="margin:2px 0;padding:4px 6px;border-left:3px solid ' + (isCrime ? 'var(--blood)' : 'var(--gold)') + ';background:' + (isCrime ? 'rgba(139,26,26,0.15)' : 'transparent') + ';">';
          h += '<strong style="color:' + (isCrime ? 'var(--blood-light)' : 'var(--gold)') + ';">' + esc(room.name || room.id) + '</strong>' + owner;
          if (room.features) h += '<span style="color:#fcd34d;"> 🔎 ' + esc(room.features.join('、').substring(0, 60)) + '</span>';
          if (room.exitsTo) h += '<span style="color:var(--mystic-light);"> → ' + esc(room.exitsTo.map(function(e) { return nameMap[e] || e; }).join('、')) + '</span>';
          if (isCrime) h += ' <span style="color:var(--blood-light);">★案发</span>';
          h += '</div>';
        });
        h += '</div>';
      });
      return h;
    }

    function sidePanel(activeTab) {
      activeTab = activeTab || window._sidebarTab || "chat";
      window._sidebarTab = activeTab;
      var myId = socket && socket.id;

      var h = '';

      // 玩家列表（含NPC标记）
      h += '<div class="panel" style="margin-bottom:8px;"><h4 style="font-size:13px;margin-bottom:4px;">玩家</h4>';
      (gs.players||[]).forEach(function(p) {
        var isMe = p.playerId === myId;
        var isNPC = p.isNPC || (p.playerId && p.playerId.startsWith("npc_"));
        h += '<div style="display:flex;align-items:center;gap:4px;padding:2px 0;font-size:11px;">';
        h += '<span style="flex:1;">' + esc(p.characterName||p.playerName) + (isMe?' (你)':'') + (isNPC?' <span style="color:var(--gold);font-size:10px;">[NPC]</span>':'') + '</span>';
        h += '</div>';
      });
      h += '</div>';

      // 标签导航（有NPC时显示审讯标签）
      var hasNpcs = (gs.allCharacters || []).some(c => c.roleType === 'npc');
      h += '<div class="sidebar-tabs">';
      h += '<button class="sidebar-tab ' + (activeTab === 'script' ? 'active' : '') + '" onclick="switchSidebarTab(\'script\')">📜 剧本</button>';
      h += '<button class="sidebar-tab ' + (activeTab === 'clues' ? 'active' : '') + '" onclick="switchSidebarTab(\'clues\')">🔍 线索</button>';
      if (hasNpcs) h += '<button class="sidebar-tab ' + (activeTab === 'interrogate' ? 'active' : '') + '" onclick="switchSidebarTab(\'interrogate\')">🎤 审讯</button>';
      h += '<button class="sidebar-tab ' + (activeTab === 'layout' ? 'active' : '') + '" onclick="switchSidebarTab(\'layout\')">🗺️ 布局</button>';
      h += '<button class="sidebar-tab ' + (activeTab === 'chat' ? 'active' : '') + '" onclick="switchSidebarTab(\'chat\')">💬 聊天</button>';
      h += '</div>';

      // 标签内容
      h += '<div class="sidebar-tab-content" id="sidebarTabContent">';

      if (activeTab === 'script') {
        // 剧本标签：显示角色剧本（优先完整playerScript，回退到分段字段）
        var char = gs.myCharacter || {};
        var s = char.script || {};
        var fullScript = s.playerScript || s.fullScript || s.story || '';
        h += '<div class="sidebar-script">';
        if (char.name) {
          h += '<h4 style="color:var(--gold);margin-bottom:8px;">' + esc(char.name) + ' 的角色剧本</h4>';
          if (char.isMurderer) h += '<div class="murderer-tag" style="margin-bottom:8px;">你是凶手</div>';
        }
        // 优先显示完整剧本正文
        if (fullScript) {
          h += '<div style="white-space:pre-wrap;font-size:12px;line-height:1.7;max-height:500px;overflow-y:auto;">' + md2html(String(fullScript || '')) + '</div>';
        }
        // 秘密单独显示
        if (s.secret) {
          h += '<details class="script-detail" style="margin-top:8px;"><summary style="color:var(--blood-light);">你的秘密</summary><div style="white-space:pre-wrap;font-size:12px;line-height:1.6;">' + esc(String(s.secret).substring(0, 2000)) + '</div></details>';
        }
        // 如果分段字段可用则作为补充
        var sections = [['你的时间线', s.personalTimeline], ['你的目标', s.goals], ['你已知晓', s.knownInfo], ['你的物品', s.items]];
        var hasExtra = sections.some(function(sec) { return sec[1]; });
        if (hasExtra) {
          for (var i = 0; i < sections.length; i++) {
            if (sections[i][1]) {
              h += '<details class="script-detail"><summary>' + esc(sections[i][0]) + '</summary><div style="white-space:pre-wrap;font-size:12px;line-height:1.6;">' + esc(String(sections[i][1]).substring(0, 2000)) + '</div></details>';
            }
          }
        }
        h += '</div>';
      } else if (activeTab === 'clues') {
        // 线索标签：显示已收集线索
        h += '<div class="sidebar-clues">';
        if (gs.myClues.length === 0) {
          h += '<p style="color:var(--text2);font-size:12px;">暂无线索</p>';
        } else {
          for (var j = 0; j < gs.myClues.length; j++) {
            var c = gs.myClues[j];
            var isPhysical2 = c.clueType && !/人证/.test(c.clueType);
            var locHtml2 = (isPhysical2 && c.location) ? '<div style="font-size:10px;color:var(--gold);">📍 ' + esc(c.location) + '</div>' : '';
            h += '<div class="sidebar-clue-card"><div class="clue-id">' + esc(c.id) + ((c.foundByName || c.foundBy) ? ' <span style="font-size:10px;color:var(--text-dim);">— ' + esc(c.foundByName || c.foundBy) + ' 发现</span>' : '') + '</div>' + locHtml2 + '<div style="font-size:11px;">' + esc(String(c.content||'').substring(0, 300)) + '</div></div>';
          }
        }
        h += '</div>';
      } else if (activeTab === 'interrogate') {
        // 审讯标签：NPC列表，点击弹出对话框
        var npcs = (gs.allCharacters || []).filter(c => c.roleType === 'npc');
        h += '<div class="sidebar-script" style="max-height:450px;">';
        h += '<p style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">点击NPC进行审讯（对话全员可见）</p>';
        for (var j = 0; j < npcs.length; j++) {
          var npc = npcs[j];
          h += '<div class="npc-card" onclick="openNpcDialog(\'' + esc(npc.name) + '\')" style="padding:8px;margin-bottom:4px;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:var(--surface);">';
          h += '<span style="color:var(--gold);font-weight:600;">' + esc(npc.name) + '</span>';
          if (npc.occupation) h += '<span style="font-size:11px;color:var(--text-dim);margin-left:6px;">' + esc(npc.occupation) + '</span>';
          h += '<span style="float:right;font-size:11px;color:var(--text-dim);">审讯 ▶</span>';
          h += '</div>';
        }
        h += '</div>';
      } else if (activeTab === 'layout') {
        // 布局标签：ASCII场景平面图
        var layout = (gs.scriptSummary && gs.scriptSummary.layout) || null;
        h += '<div class="sidebar-script" style="max-height:520px;overflow:auto;">';
        if (layout && layout.rooms) {
          h += '<h4 style="color:var(--gold);margin-bottom:8px;">📍 场景布局</h4>';
          h += renderAsciiMap(layout);
          // 图例
          h += '<div style="margin-top:8px;font-size:10px;color:var(--text-dim);">★ 案发现场 | 🔗 箭头=出口方向 | 房间按楼层分组</div>';
        } else {
          h += '<p style="color:var(--text-dim);font-size:12px;">布局数据未生成或剧本中无布局描述。</p>';
          h += '<p style="color:var(--text-dim);font-size:11px;">提示：新生成的剧本包含场景布局图。</p>';
        }
        h += '</div>';
      } else {
        // 聊天标签
        h += '<div class="chat-box" style="height:280px;"><div class="chat-messages" id="chatMsgs">';
        (gs.chatMessages||[]).slice(-40).forEach(function(m) {
          h += '<div class="chat-msg"><span class="sender">' + esc(m.characterName||m.playerName) + ':</span>' + esc(m.content) + '</div>';
        });
        h += '</div><div class="chat-input-row"><input id="chatIn" placeholder="输入消息..." onkeydown="if(event.key==&quot;Enter&quot;)doChat()" /><button onclick="doChat()">发送</button></div></div>';
      }

      h += '</div>'; // .sidebar-tab-content
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

    window._bookData = { pages: [], current: 0 };

    function renderReading() {
      var char = gs.myCharacter || {};
      var s = char.script || {};

      // Build sections array
      var sections = [];
      if (char.name) sections.push({ label: char.name + ' 的角色剧本', content: char.isMurderer ? '【你是凶手】' : '', isTitle: true, isMurderer: char.isMurderer });
      var secs = [['你的故事', s.story], ['你的秘密', s.secret], ['你的时间线', s.personalTimeline], ['你的目标', s.goals], ['你掌握的信息', s.knownInfo], ['你的物品', s.items], ['你的谎言', s.lies], ['辩护策略', s.defenseStrategy]];
      for (var i = 0; i < secs.length; i++) {
        if (secs[i][1]) sections.push({ label: secs[i][0], content: secs[i][1] });
      }

      // Split into pages (~380 chars per page for comfortable book reading)
      var pages = [];
      var currentPage = '';
      var charsPerPage = 380;

      for (var j = 0; j < sections.length; j++) {
        var sec = sections[j];
        var header = sec.label;
        var body = sec.content || '';

        if (sec.isTitle) {
          if (currentPage) { pages.push(currentPage); currentPage = ''; }
          var titleHtml = '<div style="text-align:center;padding-top:60px;"><h2 style="font-size:26px;">' + esc(sec.label) + '</h2>';
          if (sec.isMurderer) titleHtml += '<div class="murderer-tag">你是凶手</div>';
          titleHtml += '<p style="margin-top:40px;color:#8b7355;font-style:italic;">请仔细阅读，不要向其他玩家透露你的剧本内容</p></div>';
          pages.push(titleHtml);
          continue;
        }

        var sectionText = '<h3>' + esc(header) + '</h3><div style="white-space:pre-wrap;">' + md2html(body) + '</div>';

        // If a single section is too long, split it across multiple pages
        if (sectionText.length > charsPerPage) {
          if (currentPage) { pages.push(currentPage); currentPage = ''; }
          // Split long section at paragraph boundaries
          var paragraphs = sectionText.split(/\n{2,}/);
          for (var k = 0; k < paragraphs.length; k++) {
            if (currentPage.length + paragraphs[k].length > charsPerPage && currentPage.length > 0) {
              pages.push(currentPage);
              currentPage = paragraphs[k];
            } else {
              currentPage += (currentPage ? '\n\n' : '') + paragraphs[k];
            }
          }
        } else if (currentPage.length + sectionText.length > charsPerPage && currentPage.length > 0) {
          pages.push(currentPage);
          currentPage = sectionText;
        } else {
          currentPage += (currentPage ? '\n' : '') + sectionText;
        }
      }
      if (currentPage) pages.push(currentPage);
      if (pages.length === 0) pages.push('<div style="white-space:pre-wrap;">' + esc(char.script?.fullScript || JSON.stringify(char)) + '</div>');

      window._bookData = { pages: pages, current: 0 };

      var h = topBar('reading');
      h += gs.narrative ? '<div class="narrative-panel">' + esc(gs.narrative) + '</div>' : '';
      h += '<div class="book-container">';
      h += '<div class="book" id="bookEl">';
      h += '<div class="book-page left" id="bookLeft">' + (pages[0] || '') + '<span class="page-num">1</span></div>';
      h += '<div class="book-spine"></div>';
      h += '<div class="book-page right" id="bookRight">' + (pages[1] || '') + '<span class="page-num">' + (pages[1] ? '2' : '') + '</span></div>';
      h += '</div></div>';
      h += '<div class="book-nav">';
      h += '<button onclick="flipPage(-1)" id="btnPrev" disabled>◀ 上一页</button>';
      h += '<span class="page-indicator" id="pageIndicator">第 1 / ' + Math.ceil(pages.length / 2) + ' 页</span>';
      h += '<button onclick="flipPage(1)" id="btnNext"' + (pages.length <= 2 ? ' disabled' : '') + '>下一页 ▶</button>';
      h += '</div>';

      document.getElementById('gameContent').innerHTML = h;
    }

    function flipPage(direction) {
      var book = window._bookData;
      var newPage = book.current + direction * 2; // 2 pages per spread
      if (newPage < 0 || newPage >= book.pages.length) return;

      book.current = newPage;
      var bookEl = document.getElementById('bookEl');
      var left = document.getElementById('bookLeft');
      var right = document.getElementById('bookRight');

      // Flip animation
      bookEl.classList.remove('flip-forward', 'flip-backward');
      void bookEl.offsetWidth; // trigger reflow
      bookEl.classList.add(direction > 0 ? 'flip-forward' : 'flip-backward');

      // Update content after a short delay (mid-flip)
      setTimeout(function() {
        left.innerHTML = (book.pages[book.current] || '') + '<span class="page-num">' + (book.current + 1) + '</span>';
        right.innerHTML = (book.pages[book.current + 1] || '') + '<span class="page-num">' + (book.pages[book.current + 1] ? book.current + 2 : '') + '</span>';

        document.getElementById('btnPrev').disabled = book.current <= 0;
        document.getElementById('btnNext').disabled = book.current + 2 >= book.pages.length;
        document.getElementById('pageIndicator').textContent = '第 ' + (Math.floor(book.current / 2) + 1) + ' / ' + Math.ceil(book.pages.length / 2) + ' 页';
      }, 300);
    }

    function renderInvestigation() {
      let h = topBar(gs.phase);
      h += gs.narrative ? `<div class="narrative-panel">${esc(gs.narrative)}</div>` : "";
      h += '<h4 style="margin:12px 0;">已获取的线索</h4>';
      h += '<div class="clue-grid">';
      for (const c of gs.myClues) {
        var isPhysical = c.clueType && !/人证/.test(c.clueType);
        var locHtml = (isPhysical && c.location) ? '<div style="font-size:10px;color:var(--gold);margin-bottom:2px;">📍 ' + esc(c.location) + '</div>' : '';
        h += `<div class="clue-card found"><div class="clue-id">${esc(c.id)}${c.foundBy ? ' <span style="font-size:10px;color:var(--text-dim);">— ' + esc(c.foundBy) + ' 发现</span>' : ''}</div>${locHtml}<div class="clue-body">${esc(c.content||'')}</div></div>`;
      }
      h += '</div>';
      h += `<button class="btn btn-primary" style="margin-top:16px;" onclick="investigate()">申请调查</button>`;
      if (gs.myClues.length >= 3) h += '<p style="font-size:12px;color:var(--text2);margin-top:8px;">已获得多条线索，可以准备进入讨论阶段</p>';

      document.getElementById("gameContent").innerHTML = wrapWithSidebar(h);
      setTimeout(function(){var e=document.getElementById('chatMsgs');if(e)e.scrollTop=e.scrollHeight;},100);
    }

    function investigate() {
      socket.emit("investigate", { roomCode: gs.room?.roomCode });
    }

    // ==================== NPC审讯弹窗 ====================
    window._npcChats = {};

    function openNpcDialog(npcName) {
      var chats = window._npcChats[npcName] || [];
      var h = '<div class="npc-dialog-overlay" onclick="if(event.target===this)closeNpcDialog()">';
      h += '<div class="npc-dialog">';
      h += '<div class="npc-dialog-header">';
      h += '<span>🎤 审讯 ' + esc(npcName) + '</span>';
      h += '<button onclick="closeNpcDialog()" style="background:none;border:none;color:var(--text);font-size:18px;cursor:pointer;">✕</button>';
      h += '</div>';
      h += '<div class="npc-dialog-body" id="npcDialogBody">';
      if (chats.length === 0) {
        h += '<p style="color:var(--text-dim);text-align:center;padding:20px;">输入你的问题开始审讯...</p>';
      } else {
        for (var i = 0; i < chats.length; i++) {
          var m = chats[i];
          h += '<div class="npc-dialog-msg"><div class="npc-dialog-role">' + (m.role === 'user' ? '你' : esc(npcName)) + ':</div><div>' + esc(m.content) + '</div></div>';
        }
      }
      h += '</div>';
      h += '<div class="npc-dialog-input">';
      h += '<input id="npcDialogInput" placeholder="输入你的问题..." onkeydown="if(event.key==\'Enter\')askNpcInDialog(\'' + esc(npcName) + '\')" />';
      h += '<button onclick="askNpcInDialog(\'' + esc(npcName) + '\')">发送</button>';
      h += '</div></div></div>';

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
      // 记录提问
      var chats = window._npcChats[npcName] || [];
      chats.push({ role: "user", content: q });
      window._npcChats[npcName] = chats;
      // 发送到服务器
      socket.emit("ask_npc", { roomCode: gs.room?.roomCode, npcName: npcName, question: q });
      // 刷新对话框
      refreshNpcDialog(npcName);
    }

    function refreshNpcDialog(npcName) {
      var chats = window._npcChats[npcName] || [];
      var body = document.getElementById("npcDialogBody");
      if (!body) return;
      var h = '';
      for (var i = 0; i < chats.length; i++) {
        var m = chats[i];
        h += '<div class="npc-dialog-msg" style="margin-bottom:8px;"><div class="npc-dialog-role" style="color:' + (m.role === 'user' ? 'var(--gold)' : 'var(--mystic-light)') + ';font-weight:600;font-size:11px;">' + (m.role === 'user' ? '你' : esc(npcName)) + ':</div><div style="font-size:13px;">' + esc(m.content) + '</div></div>';
      }
      body.innerHTML = h || '<p style="color:var(--text-dim);text-align:center;padding:20px;">输入你的问题开始审讯...</p>';
      body.scrollTop = body.scrollHeight;
    }

    // 监听chat_message，如果是NPC回复则更新对话框
    var _origChatHandler = socket._callbacks && socket._callbacks["$chat_message"];
    socket.on("chat_message", function(data) {
      // 检查是否是NPC消息（来自ask_npc的回复）
      if (data.playerId && data.playerId.startsWith("npc_")) {
        var npcName = data.characterName;
        if (npcName) {
          var chats = window._npcChats[npcName] || [];
          var content = data.content || "";
          // 去掉 "[回复 xxx] " 前缀
          content = content.replace(/^\[回复 .+?\]\s*/, "");
          chats.push({ role: "npc", content: content });
          window._npcChats[npcName] = chats;
          refreshNpcDialog(npcName);
        }
      }
    });

    function renderDiscussion() {
      let h = topBar(gs.phase);
      h += gs.narrative ? '<div class="narrative-panel">' + esc(gs.narrative) + '</div>' : '';

      h += '<p style="color:var(--text2);font-size:13px;margin-top:12px;">讨论中 — 使用右侧聊天框发送消息</p>';
      document.getElementById("gameContent").innerHTML = wrapWithSidebar(h);
      setTimeout(function(){var e=document.getElementById('chatMsgs');if(e)e.scrollTop=e.scrollHeight;},100);
    }

    function doReady() {
      gs._amIReady = true;
      socket.emit("ready", { roomCode: gs.room?.roomCode });
      updateTopBarReady();
    }

    function updateTopBarReady() {
      var btn = document.getElementById("readyBtn");
      if (!btn) return;
      var readyCount = gs.readyCount || 0;
      var totalReady = gs.totalReadyCount || 0;
      if (readyCount > 0) {
        btn.textContent = '就绪 ' + readyCount + '/' + totalReady;
        btn.disabled = false;
        btn.style.opacity = '';
      } else {
        btn.textContent = gs._amIReady ? '等待其他人...' : '进入下一阶段';
        btn.disabled = false;
        btn.style.opacity = '';
      }
    }

    function doChat() {
      const inp = document.getElementById("chatIn");
      if (!inp?.value.trim()) return;
      socket.emit("chat", { roomCode: gs.room?.roomCode, content: inp.value });
      inp.value = "";
    }

    function renderVoting() {
      let h = topBar("voting");
      h += gs.narrative ? `<div class="narrative-panel">${esc(gs.narrative)}</div>` : "";

      // 投票目标：所有角色（含NPC），从 allCharacters 获取NPC信息
      var humanNames = (gs.players || []).map(p => p.characterName).filter(Boolean);
      var npcNames = (gs.allCharacters || []).filter(c => c.roleType === 'npc').map(c => c.name);
      var allVoteTargets = humanNames.concat(npcNames.filter(n => !humanNames.includes(n)));
      var chars = allVoteTargets.filter((v, i, a) => a.indexOf(v) === i);
      h += '<h4 style="margin:16px 0;">投票指认凶手</h4><div class="vote-grid">';
      for (const name of chars) {
        h += `<div class="vote-card ${gs.voteTarget === name ? 'voted' : ''}" onclick="doVote('${esc(name)}')"><div class="name">${esc(name)}</div></div>`;
      }
      h += '</div>';
      if (gs.voteTarget) h += `<p style="text-align:center;margin-top:8px;color:var(--primary-light);">你已投票: ${esc(gs.voteTarget)}</p>`;

      document.getElementById("gameContent").innerHTML = wrapWithSidebar(h);
      setTimeout(function(){var e=document.getElementById('chatMsgs');if(e)e.scrollTop=e.scrollHeight;},100);
    }

    function doVote(target) {
      socket.emit("vote", { roomCode: gs.room?.roomCode, targetCharacterName: target });
    }

    window._truthData = null;
    function renderTruth(data) {
      if (data && data.murdererName) window._truthData = data; // 缓存真相数据防止被覆盖
      data = data || window._truthData || {};
      let h = '<div class="reveal-container">';
      h += `<h2>${data.outcome === 'true_accusation' ? '案件告破！' : '真相大白'}</h2>`;
      h += data.murdererName ? `<div class="murderer">凶手：${esc(data.murdererName)}</div>` : '';
      h += data.narrative ? `<div class="outcome">${esc(data.narrative)}</div>` : data.description ? `<div class="outcome">${esc(data.description)}</div>` : '';
      if (data.votes) {
        h += '<div style="margin-top:16px;">';
        for (const [name, count] of Object.entries(data.votes)) h += `<div>${esc(name)}: ${count} 票</div>`;
        h += '</div>';
      }
      h += '</div>';
      document.getElementById("gameContent").innerHTML = wrapWithSidebar(h, "chat");
      setTimeout(function(){var e=document.getElementById('chatMsgs');if(e)e.scrollTop=e.scrollHeight;},100);
    }

    function esc(s) {
      const d = document.createElement("div"); d.textContent = String(s || ""); return d.innerHTML;
    }

    // 将剧本中的简单Markdown转为HTML（##标题、**加粗**）
    function md2html(text) {
      var s = esc(String(text || ""));
      // ## 或 ### 标题 → 独立行，加粗变大变色
      s = s.replace(/^#{2,3}\s+(.+?)$/gm, '<div style="font-weight:700;color:var(--gold);font-size:1.15em;margin:12px 0 6px 0;">$1</div>');
      // 中文序号标题（一、xxx 或 1. xxx）→ 加粗
      s = s.replace(/^[（(]?[一二三四五六七八九十\d]+[）)、.]\s*.+$/gm, function(m) {
        if (m.length < 30) return '<div style="font-weight:600;color:var(--gold-light);margin:8px 0 4px 0;">' + m + '</div>';
        return m;
      });
      // **加粗** → <strong>
      s = s.replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--gold-light);">$1</strong>');
      // 单个 *斜体* → <em>
      s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
      return s;
    }

// 音效和语音已移除

// 聊天/房间更新时自动刷新侧边栏
if (!window._sidePatched) {
  window._sidePatched = true;
  socket.on("chat_message", function(data) { setTimeout(refreshSidebar, 50); });
  socket.on("room_updated", function(data) { setTimeout(refreshSidebar, 50); });
}
