// 페이지 글 모으기 — 순수 함수(확장 content script · node 시험이 같이 쓴다. 빌드 도구 없이 그대로 복사되는 클래식 스크립트).
// 비밀번호 칸의 값은 읽지 않는다: 본문(innerText)에는 입력 칸 값이 들어가지 않고, 고른 글은 비밀번호 칸에 초점이 있으면 비운다.
(function (g) {
  "use strict";
  const lib = (g.SAPanelLib = g.SAPanelLib || {});

  // 서버가 다시 한 번 자른다(고른 글 2,000 · 본문 4,000). 여기서는 보내는 양을 줄이려고 같은 값으로 자른다.
  const LIMITS = { title: 300, url: 2000, selection: 2000, text: 4000 };

  /** 글자(코드 포인트) 수로 자른다 — 이모지 · 한자 쌍이 반쪽으로 잘리지 않게. */
  function truncate(value, max) {
    const s = typeof value === "string" ? value : "";
    if (s.length <= max) return s;
    return Array.from(s.slice(0, max * 2)).slice(0, max).join("");
  }

  function oneLine(value) {
    return (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();
  }

  /** 줄 끝 공백 · 3줄 이상 빈 줄을 줄이고 앞뒤를 다듬는다. */
  function normalize(value) {
    return (typeof value === "string" ? value : "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t ]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function isPasswordField(el) {
    if (!el || typeof el.tagName !== "string" || el.tagName.toUpperCase() !== "INPUT") return false;
    let type = el.type;
    if ((type === undefined || type === null) && typeof el.getAttribute === "function") type = el.getAttribute("type");
    return String(type || "").toLowerCase() === "password";
  }

  function isTextControl(el) {
    if (!el || typeof el.tagName !== "string") return false;
    const tag = el.tagName.toUpperCase();
    return tag === "TEXTAREA" || tag === "INPUT";
  }

  /** 고른 글. 비밀번호 칸에 초점이 있으면 빈 글. 입력 칸 안에서 고른 글은 그 칸의 선택 범위. */
  function readSelection(doc, win) {
    const active = doc && doc.activeElement;
    if (isPasswordField(active)) return "";
    if (isTextControl(active)) {
      try {
        if (typeof active.selectionStart === "number" && typeof active.selectionEnd === "number" && active.selectionEnd > active.selectionStart) {
          return String(active.value || "").slice(active.selectionStart, active.selectionEnd);
        }
      } catch (_) { /* 어떤 입력 종류는 선택 범위를 읽으면 오류 */ }
    }
    try {
      const sel = win && typeof win.getSelection === "function" ? win.getSelection() : null;
      return sel ? String(sel.toString()) : "";
    } catch (_) {
      return "";
    }
  }

  /** 서버로 보낼 모양으로 다듬는다: { title, url, selection, text }. */
  function buildPage(raw) {
    const r = raw || {};
    return {
      title: truncate(oneLine(r.title), LIMITS.title),
      url: truncate(typeof r.url === "string" ? r.url.trim() : "", LIMITS.url),
      selection: truncate(normalize(r.selection), LIMITS.selection),
      text: truncate(normalize(truncate(typeof r.text === "string" ? r.text : "", LIMITS.text * 3)), LIMITS.text),
    };
  }

  /** 지금 문서에서 모은다. `selectionOverride` 가 있으면(패널을 열 때 적어 둔 고른 글) 지금 고른 글이 비었을 때 그것을 쓴다. */
  function collectPage(doc, win, selectionOverride) {
    let selection = readSelection(doc, win);
    if (!selection.trim() && typeof selectionOverride === "string") selection = selectionOverride;
    let text = "";
    try {
      const body = doc && doc.body;
      text = body && typeof body.innerText === "string" ? body.innerText : "";
    } catch (_) {
      text = "";
    }
    return buildPage({
      title: doc && doc.title,
      url: win && win.location && win.location.href,
      selection,
      text,
    });
  }

  lib.LIMITS = LIMITS;
  lib.truncate = truncate;
  lib.normalize = normalize;
  lib.isPasswordField = isPasswordField;
  lib.readSelection = readSelection;
  lib.buildPage = buildPage;
  lib.collectPage = collectPage;
})(typeof globalThis !== "undefined" ? globalThis : this);
