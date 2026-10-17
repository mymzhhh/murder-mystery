// Opus SDP 调优的单元测试
//
// 为什么值得单独测：tuneOpusSdp 直接改写 SDP 文本，改错一步就会让 setLocalDescription
// 失败或协商不出音频 —— 整个语音功能全废。这是本次改动里风险最高的一段纯逻辑，
// 而且它在浏览器里才能跑到，本机没法端到端验证，所以必须用字符串级测试把边界钉死。
import test from "node:test";
import assert from "node:assert";
import { tuneOpusSdp, OPUS_PARAMS, OPUS_MAX_BITRATE } from "../../frontend/src/lib/opus.mjs";

// Chrome 实际生成的音频 SDP 片段（节选，保留结构）
const CHROME_SDP = [
  "v=0",
  "o=- 1234567890 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 110",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:abcd",
  "a=mid:0",
  "a=sendrecv",
  "a=rtpmap:111 opus/48000/2",
  "a=rtcp-fb:111 transport-cc",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "a=rtpmap:9 G722/8000",
  "a=rtpmap:0 PCMU/8000",
].join("\r\n");

test("覆盖已有 fmtp 参数，并保留原有的未知参数", () => {
  const out = tuneOpusSdp(CHROME_SDP);
  const m = out.match(/a=fmtp:111 ([^\r\n]*)/);
  assert.ok(m, "应当仍然存在 a=fmtp:111 行");
  const p = Object.fromEntries(m[1].split(";").map(kv => kv.split("=")));
  assert.strictEqual(p.maxaveragebitrate, String(OPUS_MAX_BITRATE), "码率上限应当被写入");
  assert.strictEqual(p.usedtx, "0", "DTX 应当被关闭");
  assert.strictEqual(p.useinbandfec, "1", "应当开启带内纠错");
  assert.strictEqual(p.stereo, "0", "语音应当走单声道");
  assert.strictEqual(p.minptime, "10", "原有参数应当保留");
});

test("不会破坏 SDP 的其它部分（m 行/rtpmap/其它编解码都在）", () => {
  const out = tuneOpusSdp(CHROME_SDP);
  assert.ok(out.includes("m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 110"));
  assert.ok(out.includes("a=rtpmap:63 red/48000/2"));
  assert.ok(out.includes("a=rtpmap:0 PCMU/8000"));
  assert.ok(out.includes("a=ice-ufrag:abcd"));
  assert.strictEqual(out.split("\r\n").length >= CHROME_SDP.split("\r\n").length, true);
  // 不能出现重复的 fmtp 行
  assert.strictEqual((out.match(/a=fmtp:111 /g) || []).length, 1, "fmtp 行不应重复");
});

test("原本没有 fmtp 行时补一行", () => {
  const sdp = [
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=rtpmap:111 opus/48000/2",
    "a=sendrecv",
  ].join("\r\n");
  const out = tuneOpusSdp(sdp);
  const m = out.match(/a=fmtp:111 ([^\r\n]*)/);
  assert.ok(m, "应当补出 a=fmtp:111 行");
  assert.ok(m[1].includes("maxaveragebitrate=" + OPUS_MAX_BITRATE));
  // 必须补在 rtpmap 之后、sendrecv 之前，不能把别的行挤掉
  assert.ok(out.indexOf("a=rtpmap:111") < out.indexOf("a=fmtp:111"));
  assert.ok(out.includes("a=sendrecv"));
});

test("payload type 不是 111 时也能正确定位", () => {
  const sdp = "m=audio 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 opus/48000/2\r\na=fmtp:96 minptime=10";
  const out = tuneOpusSdp(sdp);
  assert.ok(/a=fmtp:96 [^\r\n]*maxaveragebitrate=/.test(out));
  assert.ok(!out.includes("a=fmtp:111"), "不应误改不存在的 payload type");
});

test("找不到 opus 时原样返回（宁可不动，也不能改坏）", () => {
  const sdp = "m=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=rtpmap:0 PCMU/8000";
  assert.strictEqual(tuneOpusSdp(sdp), sdp);
});

test("异常输入不抛异常且原样返回", () => {
  for (const bad of [null, undefined, "", 123, {}, []]) {
    assert.doesNotThrow(() => tuneOpusSdp(bad));
  }
  assert.strictEqual(tuneOpusSdp(""), "");
  assert.strictEqual(tuneOpusSdp(null), null);
});

test("参数表本身合法：值都是可写入 SDP 的简单标量", () => {
  for (const [k, v] of Object.entries(OPUS_PARAMS)) {
    assert.ok(/^[A-Za-z-]+$/.test(k), `参数名不合法: ${k}`);
    assert.ok(["string", "number"].includes(typeof v), `参数值类型不合法: ${k}`);
    assert.ok(!String(v).includes(";"), `参数值不能含分号（会破坏 fmtp）: ${k}`);
    assert.ok(!String(v).includes("\r") && !String(v).includes("\n"));
  }
});
