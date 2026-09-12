// 实时语音聊天（WebRTC 网状连接；Socket.IO 只做 SDP/ICE 信令中转，服务端不碰音频）
//
// 两个独立开关：
//   micOn    「向其他人说话」：把自己的麦克风轨挂到所有连接上（关=别人听不到你）
//   listenOn 「接收其他人说话」：是否播放收到的远端音频（关=你听不到别人，但仍在线）
//
// ⚠️ 浏览器要求安全上下文才能申请麦克风：http://localhost 可用，
//    但通过局域网 IP（http://192.168.x.x）访问会被拒绝，需要 HTTPS 才能多人真机试玩。

const RTC_CONFIG = {
  // 同一台机器/同一局域网靠 host 候选即可连通；STUN 仅用于公网场景，取不到也无妨
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const SPEAK_THRESHOLD = 0.02; // RMS 阈值，用于"谁在说话"的高亮

export function createVoice({ socket, roomCode, onPeers, onSpeaking, onError }) {
  const peers = new Map();      // socketId → { pc, sender, audio, name, analyser }
  // socketId → 角色名。必须单独存：voice_join 通知往往早于对端发来的 offer 到达，
  // 那一刻还没有 peer 条目，名字会丢，UI 就只能显示一长串 socketId。
  const peerNames = new Map();
  let localStream = null;
  let micOn = false;
  let listenOn = false;
  let joined = false;
  let closed = false;
  let speakTimer = null;
  let audioCtx = null;

  const notify = (msg) => { if (onError) onError(msg); };
  const emitPeers = () => { if (onPeers) onPeers(listPeerStates()); };

  function listPeerStates() {
    return [...peers.values()].map(p => ({
      playerId: p.id,
      playerName: p.name,
      connection: p.pc.connectionState,
    }));
  }

  // ---------- 远端音频播放 & 说话检测 ----------
  function attachAudio(entry, stream) {
    entry.audio.srcObject = stream;
    entry.audio.muted = !listenOn;
    entry.audio.play().catch(() => { /* 首次用户手势前可能被拦，由按钮点击解锁 */ });
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      entry.analyser = analyser;
      entry.buf = new Uint8Array(analyser.fftSize);
    } catch (e) { /* 无 AudioContext 时仅失去"正在说话"高亮 */ }
  }

  function startSpeakLoop() {
    if (speakTimer) return;
    speakTimer = setInterval(() => {
      if (closed || !onSpeaking) return;
      const speaking = {};
      for (const p of peers.values()) {
        if (!p.analyser || !listenOn) { speaking[p.id] = false; continue; }
        p.analyser.getByteTimeDomainData(p.buf);
        let sum = 0;
        for (let i = 0; i < p.buf.length; i++) { const v = (p.buf[i] - 128) / 128; sum += v * v; }
        speaking[p.id] = Math.sqrt(sum / p.buf.length) > SPEAK_THRESHOLD;
      }
      onSpeaking(speaking);
    }, 300);
  }

  // ---------- 连接管理 ----------
  function ensurePeer(id, name, initiator) {
    let entry = peers.get(id);
    if (entry) return entry;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    // 预留一个双向音频通道：麦克风后开时用 replaceTrack 挂上，无需重新协商
    const sender = pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    entry = { id, name: name || peerNames.get(id) || id, pc, sender, audio, analyser: null, pendingIce: [] };

    // ⚠️ 这里不能用 ev.streams[0] 兜底：addTransceiver("audio") 未绑定 stream，
    //    远端 SDP 里 msid 为空，Chrome 下 ev.streams 是空数组 → 音频元素永远拿不到 srcObject，
    //    表现就是"连接状态 connected、双方都显示已连接，但完全听不到声音"这种静默故障。
    pc.ontrack = (ev) => {
      const stream = (ev.streams && ev.streams[0]) || new MediaStream([ev.track]);
      attachAudio(entry, stream);
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate && !closed) socket.emit("voice_signal", { to: id, data: { candidate: ev.candidate } });
    };
    pc.onconnectionstatechange = () => {
      emitPeers();
      if (pc.connectionState === "failed" && !closed) {
        // 尝试 ICE 重启，避免一次网络抖动后彻底静音
        try { pc.restartIce(); } catch (e) { /* ignore */ }
      }
    };
    peers.set(id, entry);

    if (localStream && micOn) sender.replaceTrack(localStream.getAudioTracks()[0]).catch(() => {});
    if (initiator) {
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => socket.emit("voice_signal", { to: id, data: { sdp: pc.localDescription } }))
        .catch(e => notify("建立语音连接失败：" + e.message));
    }
    emitPeers();
    startSpeakLoop();
    return entry;
  }

  function closePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch (e) { /* ignore */ }
    try { p.audio.srcObject = null; } catch (e) { /* ignore */ }
    peers.delete(id);
    emitPeers();
    if (!peers.size && speakTimer) { clearInterval(speakTimer); speakTimer = null; }
  }

  async function onSignal({ from, data }) {
    if (closed || !from || !data) return;
    const entry = ensurePeer(from, (peers.get(from) || {}).name, false);
    try {
      if (data.sdp) {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        // 队列中的候选必须在 setRemoteDescription 之后才能加，否则会抛错被静默吞掉 → 连接卡在 checking
        for (const c of entry.pendingIce.splice(0)) {
          try { await entry.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { /* ignore */ }
        }
        if (data.sdp.type === "offer") {
          const answer = await entry.pc.createAnswer();
          await entry.pc.setLocalDescription(answer);
          socket.emit("voice_signal", { to: from, data: { sdp: entry.pc.localDescription } });
        }
      } else if (data.candidate) {
        if (!entry.pc.remoteDescription || !entry.pc.remoteDescription.type) entry.pendingIce.push(data.candidate);
        else await entry.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (e) { /* 候选早于远端描述到达等情况可安全忽略 */ }
  }

  // ---------- 对外 API ----------
  async function setMic(on) {
    if (closed) return;
    if (on) {
      // 非安全上下文（http + 局域网 IP）下 navigator.mediaDevices 直接是 undefined，
      // 不先拦下来的话抛的是 "Cannot read properties of undefined"，玩家完全看不懂。
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        micOn = false;
        notify(window.isSecureContext
          ? "此浏览器不支持麦克风采集"
          : "浏览器禁止在非安全页面使用麦克风：请用 http://localhost 或 HTTPS 访问（局域网 IP + http 会被浏览器拦截）");
        socket.emit("voice_state", { roomCode, micOn, listenOn });
        return micOn;
      }
      try {
        if (!localStream) {
          localStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
        }
        const track = localStream.getAudioTracks()[0];
        // 关麦时把 track.enabled 置了 false，重开必须显式恢复，否则"麦克风已开"但实际是静音的
        if (track) track.enabled = true;
        for (const p of peers.values()) { try { await p.sender.replaceTrack(track); } catch (e) { /* ignore */ } }
        if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
        micOn = true;
      } catch (e) {
        const name = e && e.name;
        micOn = false;
        if (name === "NotAllowedError") notify("麦克风被拒绝：请在浏览器地址栏允许麦克风权限后重试");
        else if (name === "NotFoundError") notify("未检测到麦克风设备");
        else if (!window.isSecureContext) notify("当前不是安全上下文：请用 http://localhost 或 HTTPS 访问才能使用麦克风");
        else notify("无法开启麦克风：" + (e.message || name));
      }
    } else {
      micOn = false;
      for (const p of peers.values()) { try { await p.sender.replaceTrack(null); } catch (e) { /* ignore */ } }
      if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    }
    socket.emit("voice_state", { roomCode, micOn, listenOn });
    return micOn;
  }

  function setListen(on) {
    if (closed) return listenOn;
    listenOn = !!on;
    for (const p of peers.values()) p.audio.muted = !listenOn;
    if (listenOn && audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    if (listenOn) startSpeakLoop();
    socket.emit("voice_state", { roomCode, micOn, listenOn });
    return listenOn;
  }

  function join() {
    if (closed || joined) return;
    joined = true;
    socket.emit("voice_join", { roomCode });
  }

  function stopLocalStream() {
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  }

  function leave() {
    if (!joined) return;
    joined = false;
    socket.emit("voice_leave", { roomCode });
    for (const id of [...peers.keys()]) closePeer(id);
    // 退出语音必须真的放掉麦克风：否则浏览器标签页的录音指示灯常亮，玩家会认为被偷听
    stopLocalStream();
    micOn = false;
    listenOn = false;
    socket.emit("voice_state", { roomCode, micOn: false, listenOn: false });
  }

  function destroy() {
    closed = true;
    if (speakTimer) { clearInterval(speakTimer); speakTimer = null; }
    for (const id of [...peers.keys()]) closePeer(id);
    stopLocalStream();
    if (audioCtx) { try { audioCtx.close(); } catch (e) { /* ignore */ } } audioCtx = null;
  }

  // ---------- Socket 事件 ----------
  const handlers = {
    // 服务端告知"已在语音中的成员"，由我逐一发起 offer（方向固定，避免双方同时发起）
    // 同时带上名字表：名册里只有 socketId，没有名字的话新加入者的列表全是乱码 ID
    voice_roster: ({ peers: list, names: rosterNames }) => {
      Object.entries(rosterNames || {}).forEach(([id, n]) => peerNames.set(id, n));
      (list || []).forEach(id => ensurePeer(id, peerNames.get(id), true));
    },
    // 有人加入语音：等他发 offer，这里先记住名字（offer 到达时才有 peer 条目）
    voice_join: ({ playerId, playerName }) => {
      if (playerName) peerNames.set(playerId, playerName);
      const p = peers.get(playerId);
      if (p && playerName) { p.name = playerName; emitPeers(); }
    },
    voice_signal: (payload) => { onSignal(payload); },
    voice_leave: ({ playerId }) => { closePeer(playerId); },
  };
  Object.entries(handlers).forEach(([ev, fn]) => socket.on(ev, fn));

  function detach() {
    Object.entries(handlers).forEach(([ev, fn]) => socket.off(ev, fn));
    destroy();
  }

  // ---------- 诊断 ----------
  // 真机上"没声音"的可能原因很多（没授权 / 未收到远端音轨 / ICE 没连通 / 播放被浏览器拦），
  // 只靠现象无法区分，这里把每一步的真实状态暴露出来供自检面板显示。
  function diagnostics() {
    const localTracks = localStream ? localStream.getAudioTracks() : [];
    return {
      joined,
      closed,
      micOn,
      listenOn,
      localStream: !!localStream,
      localTracks: localTracks.map(t => ({ label: t.label || "(未授权时无标签)", enabled: t.enabled, muted: t.muted, readyState: t.readyState })),
      audioCtx: audioCtx ? audioCtx.state : "未创建",
      peers: [...peers.values()].map(p => {
        const stream = p.audio.srcObject;
        const tracks = stream && stream.getAudioTracks ? stream.getAudioTracks() : [];
        return {
          playerId: p.id,
          playerName: p.name,
          connectionState: p.pc.connectionState,
          iceConnectionState: p.pc.iceConnectionState,
          signalingState: p.pc.signalingState,
          pendingIce: p.pendingIce.length,
          gotRemoteTrack: tracks.length > 0,
          remoteTrackMuted: tracks.length ? tracks.map(t => t.muted).join(",") : "-",
          remoteTrackState: tracks.length ? tracks.map(t => t.readyState).join(",") : "-",
          playbackMuted: p.audio.muted,
          playbackPaused: p.audio.paused,
        };
      }),
    };
  }

  return {
    join, leave, detach, setMic, setListen, diagnostics,
    get micOn() { return micOn; },
    get listenOn() { return listenOn; },
    get peerCount() { return peers.size; },
  };
}
