// 확장 background 가 앱 로컬 서버와 말하는 부분 — 연결 정보(포트 · 토큰) 받기, 묻기 · /info, 스트림을 패널 메시지로.
// 토큰은 이 안(background 메모리)에만 있다: 패널(content script)로 가는 메시지는 stream.js 의 허용 목록을 거치고 토큰 값은 지워진다.
// 바깥 의존은 모두 주입한다(getLinkNative · fetch · hasHostPermission) — node 시험이 가짜로 갈아 끼운다.
(function (g) {
  "use strict";
  const lib = (g.SAPanelLib = g.SAPanelLib || {});

  class BridgeError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "BridgeError";
      this.code = code;
    }
  }

  const TOKEN_RE = /^[0-9a-f]{64}$/;

  function validLink(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (!Number.isInteger(obj.port) || obj.port < 1 || obj.port > 65535) return null;
    if (typeof obj.token !== "string" || !TOKEN_RE.test(obj.token)) return null;
    return { port: obj.port, token: obj.token };
  }

  function createBridge(deps) {
    const text = lib;
    let cached = null; // { port, token } — background 메모리에만

    async function readLink() {
      let reply;
      try {
        reply = await deps.getLinkNative();
      } catch (_) {
        throw new BridgeError("native_unavailable", text.errorText("native_unavailable"));
      }
      // 사파리 버전에 따라 답이 { message: {...} } 로 한 겹 싸여 올 수 있다.
      if (reply && typeof reply === "object" && !("port" in reply) && !("error" in reply) && reply.message && typeof reply.message === "object") {
        reply = reply.message;
      }
      const link = validLink(reply);
      if (link) return link;
      // 핸들러가 { error } 를 주면 연결 파일이 없거나 못 읽은 것 — 앱이 꺼진 것으로 본다(고정 문구).
      if (reply && typeof reply === "object" && typeof reply.error === "string") {
        throw new BridgeError("app_off", text.errorText("app_off"));
      }
      throw new BridgeError("bad_link", text.errorText("bad_link"));
    }

    async function getLink(force) {
      if (!force && cached) return cached;
      cached = null;
      cached = await readLink();
      return cached;
    }

    async function classifyNetworkFailure() {
      let allowed = true;
      try { allowed = await deps.hasHostPermission(); } catch (_) { allowed = true; }
      if (allowed === false) return new BridgeError("host_permission", text.errorText("host_permission"));
      return new BridgeError("app_unreachable", text.errorText("app_unreachable"));
    }

    /**
     * 앱 서버에 한 번 요청한다. 연결이 안 되거나 403(옛 토큰)이면 연결 정보를 새로 받아 한 번 더 한다.
     * Response 를 돌려준다(상태가 2xx 가 아닐 수도 있다 — 부르는 쪽이 본다). 끝내 안 되면 BridgeError.
     */
    async function request(path, init, signal) {
      let link = await getLink(false);
      for (let attempt = 0; attempt < 2; attempt++) {
        let res;
        try {
          res = await deps.fetch("http://127.0.0.1:" + link.port + path, {
            ...init,
            headers: { ...(init.headers || {}), "X-SA-Token": link.token },
            signal,
          });
        } catch (e) {
          if (signal && signal.aborted) throw new BridgeError("aborted", "");
          if (attempt === 0) {
            link = await getLink(true); // 앱이 꺼졌다 켜져 포트가 바뀌었을 수 있다(다시 못 읽으면 app_off 가 난다)
            continue;
          }
          throw await classifyNetworkFailure();
        }
        if (res.status === 403 && attempt === 0) {
          try { await res.body?.cancel(); } catch (_) { /* 무시 */ }
          link = await getLink(true);
          continue;
        }
        return res;
      }
      throw new BridgeError("stale", text.errorText("stale"));
    }

    async function serverMessage(res) {
      try {
        const body = JSON.parse(await res.text());
        return body && typeof body.error === "string" ? body.error : "";
      } catch (_) {
        return "";
      }
    }

    /** GET /info → emit(info 메시지) 또는 emit(error 메시지). */
    async function info(emit, signal) {
      try {
        const res = await request("/info", { method: "GET" }, signal);
        if (!res.ok) {
          const e = text.httpError(res.status, await serverMessage(res));
          emit({ t: "info-error", message: lib.scrub(e.message, cached && cached.token) });
          return;
        }
        let body = null;
        try { body = await res.json(); } catch (_) { /* 모양이 틀리면 빈 정보 */ }
        emit(lib.toInfoMessage(body, cached && cached.token));
      } catch (e) {
        if (e instanceof BridgeError && e.code === "aborted") return;
        emit({ t: "info-error", message: e instanceof BridgeError ? e.message : text.errorText("app_unreachable") });
      }
    }

    /**
     * POST /ask — 답을 줄 단위로 emit 한다: delta… 끝에 done 또는 error 하나.
     * done · error 없이 끝나면(앱이 꺼지는 중 · 끊김) 「연결이 끊겼어요」. 취소(signal)하면 아무것도 더 내지 않는다.
     */
    async function ask(req, emit, signal) {
      const body = { question: req.question, webSearch: req.webSearch === true };
      if (req.page) body.page = req.page;
      let finished = false;
      const out = (msg) => {
        if (!msg || finished) return;
        if (msg.t === "done" || msg.t === "error") finished = true;
        emit(msg);
      };
      try {
        const res = await request("/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }, signal);
        if (!res.ok) {
          const e = text.httpError(res.status, await serverMessage(res));
          out({ t: "error", message: lib.scrub(e.message, cached && cached.token) });
          return;
        }
        const secret = cached && cached.token;
        const reader = new lib.NdjsonReader();
        const handle = (objs) => {
          for (const obj of objs) {
            out(lib.toPanelMessage(obj, secret));
            if (finished) return;
          }
        };
        if (!res.body || typeof res.body.getReader !== "function") {
          handle(reader.push(await res.text()));
          if (!finished) handle(reader.end());
        } else {
          const stream = res.body.getReader();
          for (;;) {
            const { done, value } = await stream.read();
            if (done) break;
            handle(reader.push(value));
            if (finished) break;
          }
          if (!finished) handle(reader.end());
          if (finished) { try { await stream.cancel(); } catch (_) { /* 이미 끝남 */ } }
        }
        if (!finished) out({ t: "error", message: text.errorText("disconnected") });
      } catch (e) {
        if (signal && signal.aborted) return;
        if (e instanceof BridgeError) {
          if (e.code !== "aborted") out({ t: "error", message: e.message });
        } else {
          out({ t: "error", message: text.errorText("disconnected") });
        }
      }
    }

    // request 는 알림 보내기(alerts.js)가 쓴다 — 토큰은 여기서 붙고 돌려주는 것은 Response 뿐.
    return { info, ask, getLink, request: (path, init, signal) => request(path, init || {}, signal) };
  }

  /** 패널 묻기 번호 — 정수만(없으면 0). */
  function askIdOf(msg) {
    return msg && Number.isSafeInteger(msg.id) ? msg.id : 0;
  }

  /**
   * 패널이 보낸 묻기를 서버로 보낼 모양으로 다시 다듬는다(모르는 키는 버린다): { id, body: { question, webSearch, page? } }.
   * 질문이 비었으면 null.
   */
  function sanitizeAsk(msg) {
    const question = msg && typeof msg.question === "string" ? msg.question.trim().slice(0, 20000) : "";
    if (!question) return null;
    const body = { question, webSearch: msg.webSearch === true };
    if (msg.page && typeof msg.page === "object") body.page = lib.buildPage(msg.page);
    return { id: askIdOf(msg), body };
  }

  lib.askIdOf = askIdOf;
  lib.sanitizeAsk = sanitizeAsk;
  lib.BridgeError = BridgeError;
  lib.validLink = validLink;
  lib.createBridge = createBridge;
})(typeof globalThis !== "undefined" ? globalThis : this);
