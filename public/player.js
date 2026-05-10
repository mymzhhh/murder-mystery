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
        var oldPlayers = gs.players;
        gs.players = data.players;
        // 仅局部更新玩家列表，不重绘整个页面防止按钮跳动
        updatePlayerList();
        updateCharSelect();
      });
      socket.on("character_selected", function(data) { gs.myCharacter = data.character; updateCharSelect(); });
      socket.on("game_started", function(data) { gs.phase = data.phase; gs.narrative = data.narrative || ""; renderGame(); });
      socket.on("phase_changed", function(data) { gs.phase = data.phase; gs.phaseConfig = data.config || {}; gs.narrative = data.narrative || ""; renderGame(); });
      socket.on("clue_received", function(data) { gs.myClues.push(data.clue); renderInvestigation(); });
      socket.on("chat_message", function(data) { gs.chatMessages.push(data); if (gs.phase.includes("discussion") || gs.phase === "round3" || gs.phase === "voting") renderDiscussion(); });
      socket.on("vote_recorded", function(data) { gs.voteTarget = data.target; renderVoting(); });
      socket.on("vote_update", function(data) { renderVoting(); });
      socket.on("truth_revealed", function(data) { renderTruth(data); });
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
        const el = document.getElementById("createResult");
        el.style.display = "block";
        el.innerHTML = `
          <div style="padding:20px;background:var(--surface2);border-radius:12px;text-align:center;border:2px solid var(--success);">
            <p style="font-size:13px;color:var(--text2);margin-bottom:8px;">房间已创建！分享房间码给朋友</p>
            <div class="room-code-lg" id="myRoomCode" style="font-size:36px;cursor:pointer;">${data.roomCode}</div>
            <p style="font-size:12px;color:var(--text2);margin-top:4px;">点击房间码复制</p>
            <div style="display:flex;gap:8px;justify-content:center;margin-top:12px;">
              <button class="btn btn-primary btn-sm" onclick="copyRoomCode()" style="width:auto;">复制房间码</button>
              <button class="btn btn-success btn-sm" onclick="joinMyRoom('${data.roomCode}')" style="width:auto;">进入房间</button>
            </div>
            <p style="font-size:11px;color:var(--text2);margin-top:8px;">${data.characterCount}个角色：${(data.characters||[]).join('、')}</p>
          </div>`;
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

      let h = `<div class="panel"><div style="text-align:center;margin:20px 0;">
        <h3>房间 ${gs.room?.roomCode}</h3>
        <p style="color:var(--text2);">${parsed.title||'剧本杀'}</p>
        <p style="font-size:13px;color:var(--text2);">${parsed.setting?.era||''} | ${esc(parsed.setting?.location||'')}</p>
      </div>

      <div class="grid-2">
        <div>
          <h4>玩家列表</h4>
          <div id="playerListEl">${gs.players.map(function(p) { return '<div class="card" style="margin-bottom:4px;padding:10px;">' + esc(p.playerName) + (p.characterName ? ' → ' + esc(p.characterName) : ' (未选择角色)') + '</div>'; }).join("")}</div>
        </div>
        <div>
          <h4>选择你的角色</h4>
          <div id="charSelectEl"></div>
        </div>
      </div>`;

      h += '<div style="text-align:center;margin-top:16px;">';
      h += '<button class="btn btn-outline btn-sm" id="voiceBtn" onclick="initVoice()" style="margin-right:8px;">开启语音</button>';
      h += '<button class="btn btn-outline btn-sm" onclick="toggleMute()" style="margin-right:8px;">静音</button>';
      h += '<button class="btn btn-outline" onclick="leaveRoom()" style="margin-right:8px;">离开房间</button>';
      if (gs.players.length >= 2) {
        h += '<button class="btn btn-success" onclick="startGame()">开始游戏（AI DM主持）</button>';
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
        return '<div class="card" style="margin-bottom:4px;padding:10px;">' + esc(p.playerName) + (p.characterName ? ' → ' + esc(p.characterName) : ' (未选择角色)') + '</div>';
      }).join("");
    }

    // 局部更新角色选择按钮
    function updateCharSelect() {
      var sel = document.getElementById("charSelectEl");
      if (!sel) return;
      var assigned = gs.players.map(function(p) { return p.characterName; }).filter(Boolean);
      var chars = (gs.parsedScript?.characters || (gs.myCharacter ? [gs.myCharacter] : []));
      if (chars.length === 0) { loadCharOptions(); return; }
      var me = gs.players.find(function(p) { return p.playerId === gs.playerId; });
      var myChar = me ? me.characterName : null;
      sel.innerHTML = chars.map(function(c) {
        var name = c.name || c;
        var taken = assigned.includes(name) && name !== myChar;
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
      h += '<button class="btn btn-outline btn-sm" id="voiceBtn" onclick="initVoice()" style="margin-right:4px;">开启语音</button>';
      h += '<button class="btn btn-outline btn-sm" onclick="toggleMute()" style="margin-right:4px;">静音</button>';
      h += '<button class="btn btn-outline btn-sm" onclick="socket.emit(\'ready\',{roomCode:gs.room&&gs.room.roomCode})">进入下一阶段</button>';
      h += '</div>';
      return h;
    }

    // 侧边栏当前激活的标签页
    window._sidebarTab = "chat";

    // 右侧面板：玩家列表 + 标签页（剧本/线索/聊天）
    function sidePanel(activeTab) {
      activeTab = activeTab || window._sidebarTab || "chat";
      window._sidebarTab = activeTab;
      var myId = socket && socket.id;

      var h = '';

      // 玩家列表（紧凑）
      h += '<div class="panel" style="margin-bottom:8px;"><h4 style="font-size:13px;margin-bottom:4px;">玩家</h4>';
      (gs.players||[]).forEach(function(p) {
        var isMe = p.playerId === myId;
        var muted = voiceCtx.mutedPeers && voiceCtx.mutedPeers[p.playerId];
        h += '<div style="display:flex;align-items:center;gap:4px;padding:2px 0;font-size:11px;">';
        h += '<span style="flex:1;">' + esc(p.characterName||p.playerName) + (isMe?' (你)':'') + '</span>';
        if (!isMe && voiceCtx.enabled) {
          h += '<button class="btn btn-outline btn-sm" style="padding:1px 5px;font-size:10px;" onclick="togglePeerMute(\'' + p.playerId + '\')">' + (muted?'🔇':'🔊') + '</button>';
        }
        h += '</div>';
      });
      h += '</div>';

      // 标签导航
      h += '<div class="sidebar-tabs">';
      h += '<button class="sidebar-tab ' + (activeTab === 'script' ? 'active' : '') + '" onclick="switchSidebarTab(\'script\')">📜 剧本</button>';
      h += '<button class="sidebar-tab ' + (activeTab === 'clues' ? 'active' : '') + '" onclick="switchSidebarTab(\'clues\')">🔍 线索</button>';
      h += '<button class="sidebar-tab ' + (activeTab === 'chat' ? 'active' : '') + '" onclick="switchSidebarTab(\'chat\')">💬 聊天</button>';
      h += '</div>';

      // 标签内容
      h += '<div class="sidebar-tab-content" id="sidebarTabContent">';

      if (activeTab === 'script') {
        // 剧本标签：显示角色剧本
        var char = gs.myCharacter || {};
        var s = char.script || {};
        h += '<div class="sidebar-script">';
        if (char.name) {
          h += '<h4 style="color:var(--gold);margin-bottom:8px;">' + esc(char.name) + ' 的角色剧本</h4>';
          if (char.isMurderer) h += '<div class="murderer-tag" style="margin-bottom:8px;">你是凶手</div>';
        }
        var sections = [['你的故事', s.story], ['你的秘密', s.secret], ['你的时间线', s.personalTimeline], ['你的目标', s.goals], ['你掌握的信息', s.knownInfo], ['你的物品', s.items]];
        for (var i = 0; i < sections.length; i++) {
          if (sections[i][1]) {
            h += '<details class="script-detail"><summary>' + esc(sections[i][0]) + '</summary><div style="white-space:pre-wrap;font-size:12px;line-height:1.6;">' + esc(String(sections[i][1]).substring(0, 2000)) + '</div></details>';
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
            h += '<div class="sidebar-clue-card"><div class="clue-id">' + esc(c.id) + '</div><div style="font-size:11px;">' + esc(String(c.content||'').substring(0, 300)) + '</div></div>';
          }
        }
        h += '</div>';
      } else {
        // 聊天标签
        h += '<div class="chat-box" style="height:200px;"><div class="chat-messages" id="chatMsgs">';
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

        var sectionText = '<h3>' + esc(header) + '</h3><p style="white-space:pre-wrap;">' + esc(body) + '</p>';

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
        h += `<div class="clue-card found"><div class="clue-id">${esc(c.id)}</div><div class="clue-body">${esc(c.content||'')}</div></div>`;
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

    function renderDiscussion() {
      let h = topBar(gs.phase);
      h += gs.narrative ? '<div class="narrative-panel">' + esc(gs.narrative) + '</div>' : '';
      h += '<p style="color:var(--text2);font-size:13px;margin-top:12px;">讨论中 — 使用右侧聊天框发送消息</p>';
      document.getElementById("gameContent").innerHTML = wrapWithSidebar(h);
      setTimeout(function(){var e=document.getElementById('chatMsgs');if(e)e.scrollTop=e.scrollHeight;},100);
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

      const chars = gs.players.map(p => p.characterName).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
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

    function renderTruth(data) {
      data = data || {};
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
      document.getElementById("gameContent").innerHTML = wrapWithSidebar(h);
      setTimeout(function(){var e=document.getElementById('chatMsgs');if(e)e.scrollTop=e.scrollHeight;},100);
    }

    function esc(s) {
      const d = document.createElement("div"); d.textContent = String(s || ""); return d.innerHTML;
    }

// ==================== WebRTC 语音 ====================
var voiceCtx = { peers: {}, stream: null, muted: false, enabled: false };

async function initVoice() {
  if (voiceCtx.enabled) return;
  try {
    voiceCtx.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    voiceCtx.enabled = true;
    voiceCtx.muted = false;
    connectToAllPeers();
    updateVoiceBtn();
    console.log("[voice] enabled");
  } catch(e) { console.log("[voice] mic denied:", e.message); }
}

function toggleMute() {
  voiceCtx.muted = !voiceCtx.muted;
  if (voiceCtx.stream) {
    voiceCtx.stream.getAudioTracks().forEach(function(t) { t.enabled = !voiceCtx.muted; });
  }
  if (socket) socket.emit("rtc_mute", { roomCode: gs.room && gs.room.roomCode, muted: voiceCtx.muted });
  updateVoiceBtn();
}

function updateVoiceBtn() {
  var btn = document.getElementById("voiceBtn");
  if (!btn) return;
  if (!voiceCtx.enabled) { btn.textContent = "开启语音"; btn.className = "btn btn-outline btn-sm"; }
  else if (voiceCtx.muted) { btn.textContent = "已静音"; btn.className = "btn btn-outline btn-sm"; }
  else { btn.textContent = "语音中"; btn.className = "btn btn-success btn-sm"; }
}

function connectToAllPeers() {
  if (!gs.players) return;
  var myId = socket && socket.id;
  gs.players.forEach(function(p) {
    if (p.playerId !== myId && p.connected && !voiceCtx.peers[p.playerId]) {
      createPeerConnection(p.playerId);
    }
  });
}

function createPeerConnection(targetId) {
  var pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  voiceCtx.peers[targetId] = pc;

  pc.onicecandidate = function(e) {
    if (e.candidate && socket) {
      socket.emit("rtc_ice", { roomCode: gs.room && gs.room.roomCode, targetId: targetId, candidate: e.candidate });
    }
  };

  pc.ontrack = function(e) {
    var audio = new Audio();
    audio.srcObject = e.streams[0];
    audio.autoplay = true;
    audio.playsinline = true;
    audio.setAttribute("data-peer", targetId);
    document.body.appendChild(audio);
    audio.play().catch(function() { /* autoplay blocked, user needs to interact */ });
  };

  pc.onconnectionstatechange = function() {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      closePeer(targetId);
    }
  };

  if (voiceCtx.stream) {
    voiceCtx.stream.getTracks().forEach(function(t) { pc.addTrack(t, voiceCtx.stream); });
  }

  pc.createOffer().then(function(offer) { return pc.setLocalDescription(offer); })
    .then(function() { socket.emit("rtc_offer", { roomCode: gs.room && gs.room.roomCode, targetId: targetId, offer: pc.localDescription }); })
    .catch(function(e) { console.log("[voice] offer error:", e.message); });
}

function closePeer(targetId) {
  var pc = voiceCtx.peers[targetId];
  if (pc) { pc.close(); delete voiceCtx.peers[targetId]; }
  var el = document.querySelector('audio[data-peer="' + targetId + '"]');
  if (el) el.remove();
}

function closeAllPeers() {
  Object.keys(voiceCtx.peers).forEach(closePeer);
  voiceCtx.peers = {};
  if (voiceCtx.stream) {
    voiceCtx.stream.getTracks().forEach(function(t) { t.stop(); });
    voiceCtx.stream = null;
  }
  voiceCtx.enabled = false;
  voiceCtx.muted = false;
  updateVoiceBtn();
}

// WebRTC signaling handlers
if (typeof socket !== "undefined" && socket) {
  socket.on("rtc_offer", function(data) {
    var pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    voiceCtx.peers[data.fromId] = pc;
    pc.onicecandidate = function(e) {
      if (e.candidate) socket.emit("rtc_ice", { roomCode: gs.room && gs.room.roomCode, targetId: data.fromId, candidate: e.candidate });
    };
    pc.ontrack = function(e) {
      var a = new Audio(); a.srcObject = e.streams[0]; a.autoplay = true; a.playsinline = true; a.setAttribute("data-peer", data.fromId); document.body.appendChild(a);
      a.play().catch(function() {});
    };
    pc.onconnectionstatechange = function() {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") closePeer(data.fromId);
    };
    if (voiceCtx.stream) {
      voiceCtx.stream.getTracks().forEach(function(t) { pc.addTrack(t, voiceCtx.stream); });
    }
    pc.setRemoteDescription(new RTCSessionDescription(data.offer))
      .then(function() { return pc.createAnswer(); })
      .then(function(answer) { return pc.setLocalDescription(answer); })
      .then(function() { socket.emit("rtc_answer", { roomCode: gs.room && gs.room.roomCode, targetId: data.fromId, answer: pc.localDescription }); })
      .catch(function(e) { console.log("[voice] answer error:", e.message); });
  });

  socket.on("rtc_answer", function(data) {
    var pc = voiceCtx.peers[data.fromId];
    if (pc) pc.setRemoteDescription(new RTCSessionDescription(data.answer)).catch(function(e) {});
  });

  socket.on("rtc_ice", function(data) {
    var pc = voiceCtx.peers[data.fromId];
    if (pc && data.candidate) pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(function(e) {});
  });

  socket.on("rtc_mute_update", function(data) {
    var el = document.querySelector('audio[data-peer="' + data.playerId + '"]');
    if (el) el.muted = data.muted;
  });
}

// Hook into room join/leave
var _origShowGame = showGame;
showGame = function() {
  _origShowGame();
  setTimeout(initVoice, 1000);
  // 聊天消息到达时刷新侧边栏
  var origChat = socket._callbacks && socket._callbacks["chat_message"];
  if (!window._chatPatched) {
    window._chatPatched = true;
    socket.on("chat_message", function(data) { setTimeout(refreshSidebar, 50); });
    socket.on("room_updated", function(data) { setTimeout(refreshSidebar, 50); });
  }
};

// 单人静音
window._mutedPeers = {};
if (!voiceCtx.mutedPeers) voiceCtx.mutedPeers = {};

function togglePeerMute(playerId) {
  voiceCtx.mutedPeers[playerId] = !voiceCtx.mutedPeers[playerId];
  var el = document.querySelector('audio[data-peer="' + playerId + '"]');
  if (el) el.muted = voiceCtx.mutedPeers[playerId];
  refreshSidebar();
}
var _origLeaveRoom = leaveRoom;
leaveRoom = function() { closeAllPeers(); _origLeaveRoom(); };
if (window._origLeftRoom) { /* already patched */ }

// 音效已移除
