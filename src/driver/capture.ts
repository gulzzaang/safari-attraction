import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafariError } from "./types.js";

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 명령 하나를 돌린다(셸을 거치지 않는다). 시험에서는 가짜로 바꿔 끼운다. */
export type RunCmd = (cmd: string, args: string[]) => Promise<CmdResult>;

/** 찍은 그림의 긴 변 한도(px). */
export const MAX_CAPTURE_EDGE = 1568;

export const defaultRun: RunCmd = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 20_000 }, (err, stdout, stderr) => {
      // err.code 는 종료 코드(숫자)이거나 못 띄운 이유(ENOENT 같은 글)다.
      const code = !err ? 0 : typeof err.code === "number" ? err.code : 1;
      resolve({ code, stdout, stderr: err && typeof err.code !== "number" ? `${stderr}${err.message}` : stderr });
    });
  });

const DENIED_MESSAGE = "창을 찍지 못함(화면 기록 권한이 없거나 화면이 잠겨 있을 수 있음)";

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * 사파리 창(id = 창 번호)을 PNG 로 찍는다. `screencapture -l <id> -o -x <임시 파일>` 으로 찍고
 * `sips -Z 1568` 로 긴 변을 1568px 이하로 줄인 뒤 Buffer 로 돌려준다. 임시 파일은 실패해도 지운다.
 * 찍기에 실패했거나(`could not create image`) 파일이 비면 SCREEN_CAPTURE_DENIED.
 */
export async function captureWindowPng(windowId: number, run: RunCmd = defaultRun): Promise<Buffer> {
  const tmp = join(tmpdir(), `safari-attraction-${process.pid}-${randomBytes(6).toString("hex")}.png`);
  try {
    const shot = await run("screencapture", ["-l", String(windowId), "-o", "-x", tmp]);
    const out = `${shot.stdout}\n${shot.stderr}`;
    if (/could not create image/i.test(out) || (await fileSize(tmp)) === 0) {
      throw new SafariError("SCREEN_CAPTURE_DENIED", `${DENIED_MESSAGE}: ${out.trim() || "빈 그림"}`);
    }
    if (shot.code !== 0) throw new SafariError("SAFARI_ERROR", `screencapture 가 실패함(${shot.code}): ${out.trim()}`);
    const resize = await run("sips", ["-Z", String(MAX_CAPTURE_EDGE), tmp]);
    if (resize.code !== 0) throw new SafariError("SAFARI_ERROR", `sips 로 그림을 줄이지 못함(${resize.code}): ${`${resize.stdout}\n${resize.stderr}`.trim()}`);
    const png = await readFile(tmp);
    if (png.length === 0) throw new SafariError("SCREEN_CAPTURE_DENIED", DENIED_MESSAGE);
    return png;
  } finally {
    await rm(tmp, { force: true });
  }
}
