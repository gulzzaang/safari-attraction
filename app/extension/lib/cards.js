// 페이지 패널의 허락 카드 표시 데이터 — 순수 함수(DOM · HTML 없음, content.js 가 textContent 로만 넣는다).
(function (g) {
  "use strict";
  const lib = (g.SAPanelLib = g.SAPanelLib || {});

  const DEFAULT_TITLES = {
    action: "사이트에서 할 일 — 허락할까요?",
    danger: "되돌릴 수 없어 보이는 일",
    code: "이 코드를 실행해도 될까요?",
  };

  /**
   * 서버에서 온 카드 객체 `{ id, kind, title, detail, host, canAlwaysAllow }` 를
   * 화면에 그릴 평문 · 단추 목록으로 바꾼다.
   */
  function cardView(card) {
    if (!card || typeof card !== "object" || typeof card.id !== "string" || !card.id) return null;
    const kind = card.kind === "danger" || card.kind === "code" ? card.kind : "action";
    const isDanger = kind === "danger" || kind === "code";
    const isCode = kind === "code";
    const title = typeof card.title === "string" && card.title ? card.title : DEFAULT_TITLES[kind];
    const host = typeof card.host === "string" ? card.host : "";
    const detail = typeof card.detail === "string" ? card.detail : "";
    const buttons = [
      { answer: "allow", label: "허락", primary: true },
      { answer: "deny", label: "거절", primary: false },
    ];
    if (!isDanger && card.canAlwaysAllow === true) {
      buttons.push({ answer: "always", label: "이 사이트 늘 허락", primary: false });
    }
    return { id: card.id, kind, isDanger, isCode, title, host, detail, buttons };
  }

  /** 닫힌 카드에 남길 한국어 한 줄. */
  function cardResultLabel(result) {
    switch (result) {
      case "allowed": return "허락함";
      case "denied": return "거절함";
      case "withdrawn": return "거두었어요";
      default: return "끝났어요";
    }
  }

  lib.cardView = cardView;
  lib.cardResultLabel = cardResultLabel;
})(typeof globalThis !== "undefined" ? globalThis : this);
