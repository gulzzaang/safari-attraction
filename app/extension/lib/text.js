// 패널에 보이는 한국어 문구 · 답 글 안의 링크 가르기 — 순수 함수.
(function (g) {
  "use strict";
  const lib = (g.SAPanelLib = g.SAPanelLib || {});

  const APP_OFF = "사파리-어트랙션 앱을 켜 주세요(메뉴 막대 나침반)";
  const HOST_HINT = "사파리 설정 → 확장 → 사파리-어트랙션 → 웹사이트에서 127.0.0.1 허락";

  const MESSAGES = {
    app_off: APP_OFF,
    // 연결 정보는 있는데 닿지 않는다 — 앱이 꺼졌거나(강제 종료로 파일이 남음) 사파리가 막았거나. 둘 다 알린다.
    app_unreachable: APP_OFF + ". 앱이 켜져 있는데도 안 되면 " + HOST_HINT + " 를 확인해 주세요",
    host_permission: "사파리가 이 확장의 127.0.0.1 접근을 막고 있어요 — " + HOST_HINT + " 를 해 주세요",
    native_unavailable: "확장의 앱 연결 부품이 응답하지 않아요 — 사파리에서 사파리-어트랙션 확장을 껐다 켜 보세요",
    bad_link: "앱이 준 연결 정보가 올바르지 않아요 — 앱을 껐다 켜 주세요",
    stale: "앱과 확장의 연결 정보가 맞지 않아요 — 앱을 껐다 켠 뒤 다시 해 주세요",
    busy: "다른 질문이 끝나면 다시 시도해 주세요",
    too_long: "질문이 너무 길어요 — 「이 페이지 함께」 를 끄거나 질문을 줄여 주세요",
    disconnected: "연결이 끊겼어요",
  };

  function clean(value, max) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
  }

  /** 오류 코드 → 한국어 문구. 모르는 코드는 `detail`(서버가 준 한국어 글)이나 일반 안내. */
  function errorText(code, detail) {
    if (MESSAGES[code]) return MESSAGES[code];
    return clean(detail, 300) || "알 수 없는 오류가 났어요";
  }

  /** HTTP 상태 + (있다면) 서버의 `{"error":"한국어"}` 글 → 오류 코드 · 문구. */
  function httpError(status, serverMessage) {
    const detail = clean(serverMessage, 300);
    if (status === 403) return { code: "stale", message: errorText("stale") };
    if (status === 413) return { code: "too_long", message: errorText("too_long") };
    if (status === 429) return { code: "busy", message: detail || errorText("busy") };
    if (detail) return { code: "http_" + status, message: detail };
    return { code: "http_" + status, message: "앱이 오류로 답했어요(" + status + ")" };
  }

  // 마크다운 링크 `[글](주소)` 또는 맨 주소. 맨 주소는 ASCII 글자만 — 뒤에 붙은 한글 조사에서 끊긴다.
  const LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)|https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%()[\]]{1,2000}/g;

  function safeHref(candidate) {
    try {
      const u = new URL(candidate);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch (_) {
      return null;
    }
  }

  function trimTrailing(url) {
    let s = url;
    for (;;) {
      const last = s[s.length - 1];
      if (last && ".,;:!?*]".includes(last)) { s = s.slice(0, -1); continue; }
      if (last === ")") {
        const open = (s.match(/\(/g) || []).length;
        const close = (s.match(/\)/g) || []).length;
        if (close > open) { s = s.slice(0, -1); continue; }
      }
      return s;
    }
  }

  /**
   * 답 글을 [{ text }, { text, href }] 조각으로 가른다. 링크는 http · https 만.
   * 화면에는 조각마다 textContent 로 넣고 링크만 `<a target=_blank rel=noopener>` 로 만든다(글을 HTML 로 읽지 않는다).
   */
  function splitLinks(input) {
    const text = typeof input === "string" ? input : "";
    const out = [];
    let last = 0;
    LINK_RE.lastIndex = 0;
    let m;
    const push = (seg) => { if (seg.text) out.push(seg); };
    while ((m = LINK_RE.exec(text))) {
      let start = m.index;
      let end = start + m[0].length;
      let label;
      let href;
      if (m[1] !== undefined) {
        href = safeHref(m[2]);
        label = m[1];
      } else {
        const trimmed = trimTrailing(m[0]);
        end = start + trimmed.length;
        LINK_RE.lastIndex = end;
        href = safeHref(trimmed);
        label = trimmed;
      }
      if (!href) {
        // 링크로 못 만들면 글자 그대로 둔다.
        continue;
      }
      push({ text: text.slice(last, start) });
      push({ text: label, href });
      last = end;
    }
    push({ text: text.slice(last) });
    return out;
  }

  lib.errorText = errorText;
  lib.httpError = httpError;
  lib.splitLinks = splitLinks;
  lib.APP_OFF = APP_OFF;
})(typeof globalThis !== "undefined" ? globalThis : this);
