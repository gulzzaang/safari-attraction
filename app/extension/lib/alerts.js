// 사이트 알림 → 앱 — 순수 함수(content script · background · node 시험이 같이 쓴다).
// content: 페이지 메시지 읽기 · 제목 숫자 늘어남 · 탭마다 10초 거르기. background: 알림 다듬기 · 지켜볼 사이트 목록으로 거르기 · 보내기.
// 지켜보지 않는 사이트의 알림 글은 앱으로 보내지 않는다(목록을 먼저 받고, 맞을 때만 /alert).
(function (g) {
  "use strict";
  const lib = (g.SAPanelLib = g.SAPanelLib || {});

  const TEXT_LIMIT = 1000; // 제목 · 내용 각각(서버가 다시 200 · 500 으로 자른다)
  const HOSTS_TTL_MS = 5 * 60_000; // 지켜볼 사이트 목록 기억
  const HOSTS_RETRY_MS = 60_000; // 목록을 못 받았을 때 다시 묻기까지
  const KINDS = new Set(["notification", "badge"]);

  function cut(value, max) {
    const s = typeof value === "string" ? value : "";
    if (s.length <= max) return s;
    return Array.from(s.slice(0, max * 2)).slice(0, max).join("");
  }

  /** 탭 제목 앞의 `(N)` · `[N]`(N 은 1~9999, 앞 공백 허용). 없거나 범위 밖이면 0. */
  function readTitleCount(title) {
    if (typeof title !== "string") return 0;
    const m = /^\s*(?:\((\d{1,4})\)|\[(\d{1,4})\])/.exec(title);
    if (!m) return 0;
    const n = parseInt(m[1] !== undefined ? m[1] : m[2], 10);
    return n >= 1 && n <= 9999 ? n : 0;
  }

  /** 제목 숫자가 늘었을 때만 true. 처음 읽은 값은 기준만 잡고, 줄면 기준만 낮춘다. */
  function createBadgeTracker() {
    let base = null;
    return {
      observe(title) {
        const n = readTitleCount(title);
        if (base === null) { base = n; return false; }
        if (n > base) { base = n; return true; }
        if (n < base) base = n;
        return false;
      },
    };
  }

  /** `intervalMs` 에 한 번까지. 시계가 뒤로 가면 다시 허락한다(영영 막히지 않게). */
  function createRateLimiter(intervalMs, now) {
    const clock = typeof now === "function" ? now : () => Date.now();
    let last = null;
    return {
      allow() {
        const t = clock();
        if (last !== null && t >= last && t - last < intervalMs) return false;
        last = t;
        return true;
      },
    };
  }

  /** 페이지 세계(notify-hook.js)가 보낸 메시지. 표식이 정확히 1 일 때만 { title, body }(글자만 · 각 1,000자), 아니면 null. */
  function readAlertMessage(data) {
    if (!data || typeof data !== "object" || data.__safariAttractionAlert !== 1) return null;
    return { title: cut(data.title, TEXT_LIMIT), body: cut(data.body, TEXT_LIMIT) };
  }

  /** 소문자 · 앞뒤 공백 · 끝 점 정리. 호스트 글자(영문 · 숫자 · `.` · `-` · `_`)가 아니면 빈 글. */
  function normalizeHost(value) {
    if (typeof value !== "string") return "";
    const h = value.trim().toLowerCase().replace(/\.+$/, "");
    if (!h || h.length > 253 || h.startsWith(".") || h.includes("..") || !/^[a-z0-9._-]+$/.test(h)) return "";
    return h;
  }

  function hostFromUrl(url) {
    if (typeof url !== "string" || !url) return "";
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return normalizeHost(u.hostname);
    } catch (_) { return ""; }
  }

  /** 알림 호스트 `h` 가 목록의 `x` 와 같거나 `.x` 로 끝날 때(하위 도메인)만. */
  function hostMatches(host, list) {
    const h = normalizeHost(host);
    if (!h || !Array.isArray(list)) return false;
    for (const item of list) {
      const x = normalizeHost(item);
      if (x && (h === x || h.endsWith("." + x))) return true;
    }
    return false;
  }

  /**
   * content script 가 보낸 알림을 앱으로 보낼 모양으로: { host, kind, title, body } 또는 null.
   * 호스트는 보낸 탭의 주소(`senderHost`)가 있으면 그것을, 없으면 메시지의 것을 쓴다.
   */
  function alertPayload(msg, senderHost) {
    if (!msg || typeof msg !== "object" || !KINDS.has(msg.kind)) return null;
    const host = normalizeHost(senderHost) || normalizeHost(msg.host);
    if (!host) return null;
    return { host, kind: msg.kind, title: cut(msg.title, TEXT_LIMIT), body: cut(msg.body, TEXT_LIMIT) };
  }

  function validPayload(p) {
    return !!p && typeof p === "object" && KINDS.has(p.kind) && !!normalizeHost(p.host)
      && typeof p.title === "string" && typeof p.body === "string";
  }

  /**
   * background 의 알림 보내기. `request(path, init)` 은 토큰을 붙여 앱 서버에 묻는 함수(bridge.request).
   * 앱 꺼짐 · 연결 실패 · 403 은 조용히 버린다(던지지 않음, 로그 없음). 결과는 시험용 글: sent · not-watched · failed · invalid.
   */
  function createAlertForwarder(deps) {
    const clock = typeof deps.now === "function" ? deps.now : () => Date.now();
    let hosts = [];
    let fetchedAt = null;
    let ttlMs = 0;
    let inFlight = null;

    async function fetchHosts() {
      let res = null;
      try {
        res = await deps.request("/alert-hosts", { method: "GET" });
        if (!res || !res.ok) {
          try { if (res && res.body && typeof res.body.cancel === "function") await res.body.cancel(); } catch (_) { /* 무시 */ }
          throw new Error("목록 실패");
        }
        const body = await res.json();
        if (!body || !Array.isArray(body.hosts)) throw new Error("목록 모양");
        hosts = body.hosts.map(normalizeHost).filter(Boolean);
        fetchedAt = clock();
        ttlMs = HOSTS_TTL_MS;
      } catch (_) {
        hosts = [];
        fetchedAt = clock();
        ttlMs = HOSTS_RETRY_MS;
      }
    }

    async function watchedHosts() {
      const now = clock();
      if (fetchedAt !== null && now >= fetchedAt && now - fetchedAt < ttlMs) return hosts;
      if (!inFlight) inFlight = fetchHosts().finally(() => { inFlight = null; });
      await inFlight;
      return hosts;
    }

    async function forward(payload) {
      if (!validPayload(payload)) return "invalid";
      const list = await watchedHosts();
      if (!hostMatches(payload.host, list)) return "not-watched";
      try {
        const res = await deps.request("/alert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ host: payload.host, kind: payload.kind, title: payload.title, body: payload.body }),
        });
        try { if (res && res.body && typeof res.body.cancel === "function") await res.body.cancel(); } catch (_) { /* 무시 */ }
        return res && res.ok ? "sent" : "failed";
      } catch (_) {
        return "failed";
      }
    }

    return { forward };
  }

  lib.ALERT_TEXT_LIMIT = TEXT_LIMIT;
  lib.readTitleCount = readTitleCount;
  lib.createBadgeTracker = createBadgeTracker;
  lib.createRateLimiter = createRateLimiter;
  lib.readAlertMessage = readAlertMessage;
  lib.normalizeHost = normalizeHost;
  lib.hostFromUrl = hostFromUrl;
  lib.hostMatches = hostMatches;
  lib.alertPayload = alertPayload;
  lib.createAlertForwarder = createAlertForwarder;
})(typeof globalThis !== "undefined" ? globalThis : this);
