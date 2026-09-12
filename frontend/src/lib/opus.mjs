// Opus 编码参数调优（纯逻辑，不依赖浏览器 API，便于单元测试）
//
// 背景：WebRTC 默认给语音的 Opus 码率偏低（约 32kbps，是为弱网省带宽设计的），
// 这是音质最直接的瓶颈。DTX（静音期间停止发包）默认开启，会在停顿处掐断传输，
// 导致词头被削掉、听感一顿一顿。两者都可以通过改写 SDP 的 a=fmtp 行来覆盖，
// 这是 WebRTC 调音质的标准做法（在 setLocalDescription 之前改，改晚了无效）。

/** 单声道语音在 64kbps 已接近透明；6 人网状即上行约 320kbps，局域网毫无压力 */
export const OPUS_MAX_BITRATE = 64000;

export const OPUS_PARAMS = {
  maxaveragebitrate: OPUS_MAX_BITRATE, // 平均码率上限
  useinbandfec: 1,                     // 带内前向纠错：丢包时靠冗余恢复，明显减少断续
  usedtx: 0,                           // 关掉静音抑制，避免词头被削
  stereo: 0,                           // 语音走单声道，同样的带宽换更高音质
  "sprop-stereo": 0,
  minptime: 10,                        // 10ms 打包，降低端到端延迟
  maxplaybackrate: 48000,
  "sprop-maxcapturerate": 48000,
};

/**
 * 在 SDP 里找到 opus 的 payload type，合并并覆盖 a=fmtp 参数。
 * 刻意写得保守：找不到 opus、输入不是字符串、SDP 为空，一律原样返回。
 * 宁可音质不提升，也绝不能因为匹配失败把 SDP 改坏导致通话建立不了。
 *
 * @param {string} sdp
 * @returns {string}
 */
export function tuneOpusSdp(sdp) {
  if (typeof sdp !== "string" || !sdp) return sdp;
  const m = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i);
  if (!m) return sdp;
  const pt = m[1];
  const fmtpRe = new RegExp("a=fmtp:" + pt + " ([^\\r\\n]*)");
  const fm = sdp.match(fmtpRe);
  const params = {};
  if (fm) {
    fm[1].split(";").forEach((kv) => {
      const i = kv.indexOf("=");
      if (i > 0) params[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
  }
  Object.entries(OPUS_PARAMS).forEach(([k, v]) => { params[k] = String(v); });
  const line = "a=fmtp:" + pt + " " + Object.entries(params).map(([k, v]) => k + "=" + v).join(";");
  if (fm) return sdp.replace(fmtpRe, line);
  // 原本没有 fmtp 行（部分浏览器/参数下会出现）：补一行在 rtpmap 之后
  return sdp.replace(new RegExp("(a=rtpmap:" + pt + "\\s+opus/48000[^\\r\\n]*)", "i"), "$1\r\n" + line);
}

/**
 * 把码率上限也写到发送端参数上。SDP 里的 maxaveragebitrate 与这里的 maxBitrate
 * 是两条独立路径，同时设置更保险；任一路径失败都不应影响通话。
 * @param {RTCRtpSender} sender
 */
export function applySenderBitrate(sender) {
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = OPUS_MAX_BITRATE;
    sender.setParameters(p).catch(() => {});
  } catch (e) { /* ignore */ }
}

/** 读出当前连接实际的 Opus 参数，供诊断面板确认调优是否真的生效 */
export function opusInfoOf(pc) {
  try {
    const sdp = (pc.localDescription && pc.localDescription.sdp) || "";
    const m = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i);
    let fmtp = "";
    if (m) {
      const f = sdp.match(new RegExp("a=fmtp:" + m[1] + " ([^\\r\\n]*)"));
      if (f) fmtp = f[1];
    }
    let senderBitrate = "未设置";
    try {
      const senders = pc.getSenders();
      if (senders[0]) {
        const p = senders[0].getParameters();
        const enc = p.encodings && p.encodings[0];
        senderBitrate = enc && enc.maxBitrate ? enc.maxBitrate : "未设置";
      }
    } catch (e) { /* ignore */ }
    return { fmtp: fmtp || "(SDP 中未找到 opus fmtp)", senderBitrate };
  } catch (e) { return { fmtp: "读取失败", senderBitrate: "读取失败" }; }
}
