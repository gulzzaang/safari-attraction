// 앱 로컬 서버의 답(NDJSON 줄) 읽기 + 패널(content script)로 넘길 메시지 걸러내기 — 순수 함수.
// 패널로 가는 메시지는 여기서 만든 허용 목록 모양만 지나간다(서버가 준 객체를 그대로 넘기지 않는다 · 토큰 값은 지운다).
(function (g) {
  "use strict";
  const lib = (g.SAPanelLib = g.SAPanelLib || {});

  const MAX_TEXT = 200000; // 한 덩어리 글 상한(서버는 그보다 작게 보낸다)
  const MAX_MESSAGE = 500;

  /** 줄 하나를 읽는다. 빈 줄 · 깨진 줄 · 객체가 아닌 줄 · `t` 가 글이 아닌 줄은 null. */
  function parseLine(line) {
    const s = line.trim();
    if (!s) return null;
    let obj;
    try { obj = JSON.parse(s); } catch (_) { return null; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || typeof obj.t !== "string") return null;
    return obj;
  }

  /**
   * 바이트(또는 글) 조각을 받아 완성된 줄만 객체로 돌려준다.
   * 조각 경계가 줄 가운데여도, 한글 한 글자(UTF-8 3바이트) 가운데여도 이어 붙인다.
   */
  class NdjsonReader {
    constructor() {
      this.decoder = new TextDecoder("utf-8");
      this.buffer = "";
      this.skipped = 0; // 읽지 못해 건너뛴 줄 수
    }
    push(chunk) {
      this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
      const out = [];
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        const obj = parseLine(line);
        if (obj) out.push(obj); else if (line.trim()) this.skipped++;
      }
      return out;
    }
    /** 스트림이 끝났을 때 — 줄바꿈 없이 끝난 마지막 줄을 읽는다. */
    end() {
      this.buffer += this.decoder.decode();
      const line = this.buffer;
      this.buffer = "";
      const obj = parseLine(line);
      if (obj) return [obj];
      if (line.trim()) this.skipped++;
      return [];
    }
  }

  function scrub(value, secret) {
    let s = typeof value === "string" ? value : "";
    if (secret && secret.length >= 8) s = s.split(secret).join("…");
    return s;
  }

  /** 서버 줄 → 패널 메시지(허용 목록). 모르는 줄이면 null. `secret` 은 토큰 — 어느 글에도 남기지 않는다. */
  function toPanelMessage(obj, secret) {
    if (!obj || typeof obj !== "object") return null;
    switch (obj.t) {
      case "delta":
        if (typeof obj.text !== "string" || obj.text === "") return null;
        return { t: "delta", text: scrub(obj.text.slice(0, MAX_TEXT), secret) };
      case "done":
        return { t: "done" };
      case "error": {
        const m = typeof obj.message === "string" && obj.message.trim() ? obj.message : "앱이 오류로 답했어요";
        return { t: "error", message: scrub(m.slice(0, MAX_MESSAGE), secret) };
      }
      default:
        return null;
    }
  }

  /** `/info` 답 → 패널 메시지. `loggedIn` 은 true · false · null(모름)만. */
  function toInfoMessage(obj, secret) {
    const o = obj && typeof obj === "object" ? obj : {};
    const str = (v) => (typeof v === "string" ? scrub(v.slice(0, 100), secret) : null);
    return {
      t: "info",
      cli: str(o.cli),
      cliName: str(o.cliName),
      model: str(o.model),
      loggedIn: typeof o.loggedIn === "boolean" ? o.loggedIn : null,
    };
  }

  /**
   * 패널 쪽 거르개 — 답 줄(delta · done · error)은 지금 묻기 번호와 같을 때만 받는다(멈춘 뒤 · 새 질문 뒤에 늦게 온 옛 줄 버림).
   * 그 밖의 메시지(info 등)는 번호와 상관없이 받는다. `currentId` 가 null 이면(묻는 중이 아님) 답 줄은 모두 버린다.
   */
  function acceptForAsk(msg, currentId) {
    if (!msg || typeof msg !== "object") return false;
    if (msg.t === "delta" || msg.t === "done" || msg.t === "error") {
      return currentId !== null && currentId !== undefined && msg.id === currentId;
    }
    return true;
  }

  lib.acceptForAsk = acceptForAsk;
  lib.scrub = scrub;
  lib.NdjsonReader = NdjsonReader;
  lib.parseLine = parseLine;
  lib.toPanelMessage = toPanelMessage;
  lib.toInfoMessage = toInfoMessage;
})(typeof globalThis !== "undefined" ? globalThis : this);
