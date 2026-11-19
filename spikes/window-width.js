// 시험 B: 새 문서 창 하나를 (활성화하지 않고) 열어 폭을 390 으로 줄이고,
// 실제 창 폭과 그 창 페이지의 innerWidth 를 한 줄 JSON 으로 출력한다.
// 닫는 것은 이 스크립트가 직접 만든 창(만들 때 받은 id)뿐이다.
// 실행: osascript -l JavaScript spikes/window-width.js
function run() {
  const Safari = Application("Safari");
  const REQUEST = 390;

  const idsBefore = Safari.windows().map((w) => w.id());
  Safari.make({ new: "document" });
  // 새 창이 목록에 뜨기까지 잠깐 걸릴 수 있어 최대 10초 기다린다.
  const findNew = () => Safari.windows().filter((w) => idsBefore.indexOf(w.id()) < 0);
  let created = findNew();
  for (let i = 0; i < 20 && created.length === 0; i++) {
    delay(0.5);
    created = findNew();
  }
  if (created.length !== 1) {
    throw new Error("새 창을 하나로 특정하지 못함: " + created.length);
  }
  const win = created[0];
  const myId = win.id();
  const out = { 요청: REQUEST };

  try {
    const b = win.bounds();
    win.bounds = { x: b.x, y: b.y, width: REQUEST, height: b.height };
    delay(0.5);
    out.창폭 = win.bounds().width;
    try {
      const tab = win.currentTab();
      tab.url = "about:blank";
      delay(0.5);
      out.innerWidth = Safari.doJavaScript("window.innerWidth", { in: tab });
    } catch (e) {
      out.innerWidth = null;
      out.innerWidth오류 = String(e.message || e);
    }
  } finally {
    // 만들 때 받은 id 로 다시 찾아 그 창만 닫는다.
    const find = () => Safari.windows().filter((w) => w.id() === myId);
    const mine = find();
    if (mine.length === 1) mine[0].close();
    // 닫기는 바로 먹지 않고 잠깐(길면 십수 초) 뒤에야 목록에서 사라진다. 최대 30초 기다린다.
    const t0 = Date.now();
    while (find().length > 0 && Date.now() - t0 < 30000) delay(0.5);
    out.닫힘 = find().length === 0;
    out.닫기_걸린초 = Math.round((Date.now() - t0) / 100) / 10;
  }
  out.열린창_전후 = [idsBefore.length, Safari.windows().length];
  return JSON.stringify(out);
}
