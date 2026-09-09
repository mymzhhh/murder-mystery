// SSE 流式读取：fetch + ReadableStream 逐块解析  → 事件回调
// 纯函数（不依赖 React），供 usePipelineSSE 和模型测试等多处复用

/**
 * 读取 SSE 流并分发事件
 * @param {Response} res - fetch 返回的响应
 * @param {object} handlers - { onProgress(stage,msg), onPhase(phase,msg), onOutline(data), onComplete(data), onError(msg), onRawEvent(event,data) }
 * @param {AbortSignal} [signal]
 */
export async function readSSE(res, handlers = {}, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let et = "";

  function dispatch(dataStr, eventType) {
    let d;
    try { d = JSON.parse(dataStr); } catch (e) { return; }
    if (eventType === "progress" && handlers.onProgress) handlers.onProgress(d.stage, d.message);
    else if (eventType === "phase" && handlers.onPhase) handlers.onPhase(d.phase, d.message, d);
    else if (eventType === "outline" && handlers.onOutline) handlers.onOutline(d);
    else if (eventType === "complete" && handlers.onComplete) handlers.onComplete(d);
    else if (eventType === "error" && handlers.onError) handlers.onError(d && d.message ? d.message : "未知错误");
    if (handlers.onRawEvent) handlers.onRawEvent(eventType, d);
  }

  let aborted = false;
  if (signal) {
    if (signal.aborted) aborted = true;
    else signal.addEventListener("abort", () => { aborted = true; try { reader.cancel(); } catch (e) {} });
  }

  try {
    for (;;) {
      if (aborted) throw new Error("已取消");
      const rd = await reader.read();
      if (rd.done) break;
      buf += dec.decode(rd.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      lines.forEach((line) => {
        if (line.startsWith("event: ")) { et = line.slice(7); return; }
        if (!line.startsWith("data: ")) return;
        const dataStr = line.slice(6);
        dispatch(dataStr, et);
        et = "";
      });
    }
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }
}

/**
 * React Hook：POST 一个 SSE 端点，管理状态
 * @param {string|null} url - null 时不发起
 * @param {object} body - POST body
 * @param {object} opts - { onProgress, onPhase, onOutline, onComplete, onError }
 */
export function useSSE(url, body, opts = {}) {
  return null; // 骨架：实际用法见 PipelinePage 内联（保持纯函数可测试性）
}