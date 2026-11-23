import { readMachineState } from "./activity.js";
import { localDate, localTime, machineName, type HomeKind, type MemoryHome } from "./home.js";

/** 기억 폴더를 살피는 일의 상한. 아이클라우드가 멈춰도 status · doctor 가 막히지 않게 한다. */
export const STATUS_TIMEOUT_MS = 2000;

const KIND_LABEL: Record<HomeKind, string> = { icloud: "iCloud", local: "이 맥에만", env: "환경 변수" };
const MAX_NAMES = 3;
const UNKNOWN = "확인하지 못했어요";

const TIMED_OUT: unique symbol = Symbol("timeout");
type TimedOut = typeof TIMED_OUT;

/** 일을 돌리되 ms 안에 안 끝나거나 던지면 TIMED_OUT 으로 돌려준다(던지지 않는다). */
async function bounded<T>(work: () => Promise<T>, ms: number): Promise<T | TimedOut> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T | TimedOut>([
      work().catch((): TimedOut => TIMED_OUT),
      new Promise<TimedOut>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } catch {
    return TIMED_OUT;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 마지막 정리 시각을 이 맥 시간대의 `YYYY-MM-DD HH:MM` 으로. 없거나 깨졌으면 「아직 없음」. */
function formatTidy(iso: string | undefined): string {
  const t = iso ? new Date(iso) : undefined;
  if (!t || Number.isNaN(t.getTime())) return "아직 없음";
  return `${localDate(t)} ${localTime(t)}`;
}

/**
 * status 도구와 `safari-attraction doctor` 가 함께 쓰는 기억 폴더 점검 글(줄 모음).
 * 사파리 점검(runDoctor)과 따로 돈다 — 어떤 일이 실패 · 지연되어도 던지지 않고 그 줄만 「확인하지 못했어요」 로 쓴다.
 * writable 은 폴더를 쓸 수 있는지(확인 못 했으면 false).
 */
export async function memoryStatusLines(
  home: MemoryHome,
  kind: HomeKind,
  opts: { timeoutMs?: number } = {},
): Promise<{ lines: string[]; writable: boolean }> {
  const ms = opts.timeoutMs ?? STATUS_TIMEOUT_MS;
  const [w, conflicts, state] = await Promise.all([
    bounded(() => home.writable(), ms),
    bounded(() => home.conflicts(), ms),
    bounded(() => readMachineState(home), ms),
  ]);

  const writable = w !== TIMED_OUT && w.ok;
  const lines = [`${writable ? "✓" : "✗"} 기억 폴더: ${home.dir} · ${KIND_LABEL[kind]}`];

  if (w === TIMED_OUT) {
    lines.push(`  쓰기: ${UNKNOWN}`);
  } else if (w.ok) {
    lines.push("  쓰기: 가능");
  } else {
    lines.push(`  쓰기: 안 돼요 — ${w.reason}`);
    lines.push("  사파리 조작은 그대로 되고, 기억 · 프로젝트 도구만 못 써요. 폴더 권한이나 iCloud Drive 를 확인해 주세요.");
  }

  if (conflicts === TIMED_OUT) {
    lines.push(`  충돌본: ${UNKNOWN}`);
  } else if (conflicts.length === 0) {
    lines.push("  충돌본: 없음");
  } else {
    const shown = conflicts.slice(0, MAX_NAMES).join(", ");
    const rest = conflicts.length > MAX_NAMES ? ` 외 ${conflicts.length - MAX_NAMES}개` : "";
    lines.push(`  충돌본 ${conflicts.length}개: ${shown}${rest} (아이클라우드가 만든 복사본이에요. 합치지 않았으니 직접 확인해 주세요)`);
  }

  lines.push(`  이 맥 이름: ${machineName()}`);
  lines.push(`  마지막 정리: ${state === TIMED_OUT ? "아직 없음" : formatTidy(state.lastTidy)}`);
  return { lines, writable };
}
