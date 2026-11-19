import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { captureWindowPng, type RunCmd } from "../../src/driver/capture.js";

/** 서명 + IHDR 머리만 있는 가짜 PNG(너비 · 높이는 16~23 바이트). 뒤는 표시용 채움. */
function fakePng(width: number, height: number, fill: string): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.from(fill.repeat(16), "hex")]);
}
const PNG_BIG = fakePng(3000, 2000, "aa");
const PNG_SMALL = fakePng(1568, 1045, "bb");

describe("captureWindowPng(창 찍기)", () => {
  test("screencapture 가 could not create image 를 내면 SCREEN_CAPTURE_DENIED", async () => {
    const seen: string[] = [];
    const run: RunCmd = async (cmd, args) => {
      seen.push(cmd);
      seen.push(args.at(-1)!);
      return { code: 1, stdout: "", stderr: "could not create image from window 81114" };
    };
    await expect(captureWindowPng(81114, run)).rejects.toMatchObject({ code: "SCREEN_CAPTURE_DENIED" });
    expect(seen[0]).toBe("screencapture");
    expect(existsSync(seen[1]!)).toBe(false); // 임시 파일이 남지 않는다
  });

  test("끝났는데 파일이 비었으면 SCREEN_CAPTURE_DENIED", async () => {
    const run: RunCmd = async (_cmd, args) => {
      writeFileSync(args.at(-1)!, Buffer.alloc(0));
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(captureWindowPng(5, run)).rejects.toMatchObject({ code: "SCREEN_CAPTURE_DENIED" });
  });

  test("성공하면 sips 로 줄인 PNG 를 돌려주고 임시 파일을 지운다", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let tmp = "";
    const run: RunCmd = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "screencapture") {
        tmp = args.at(-1)!;
        writeFileSync(tmp, PNG_BIG);
      } else {
        expect(readFileSync(args.at(-1)!).equals(PNG_BIG)).toBe(true); // sips 는 찍은 파일을 받는다
        writeFileSync(args.at(-1)!, PNG_SMALL); // 제자리에서 줄인다
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const png = await captureWindowPng(81114, run);
    expect(png.equals(PNG_SMALL)).toBe(true);
    const shot = calls[0]!;
    expect(shot.cmd).toBe("screencapture");
    expect(shot.args).toEqual(expect.arrayContaining(["-l", "81114", "-o", "-x"]));
    expect(shot.args.indexOf("81114")).toBe(shot.args.indexOf("-l") + 1);
    const resize = calls[1]!;
    expect(resize.cmd).toBe("sips");
    expect(resize.args).toEqual(expect.arrayContaining(["-Z", "1568"]));
    expect(resize.args.indexOf("1568")).toBe(resize.args.indexOf("-Z") + 1);
    expect(resize.args.at(-1)).toBe(tmp);
    expect(existsSync(tmp)).toBe(false);
  });

  test("긴 변이 1568 이하면 sips 를 부르지 않고 찍은 그대로 돌려준다(작은 그림을 키우지 않는다)", async () => {
    const small = fakePng(300, 200, "cc");
    const cmds: string[] = [];
    let tmp = "";
    const run: RunCmd = async (cmd, args) => {
      cmds.push(cmd);
      tmp = args.at(-1)!;
      writeFileSync(tmp, small);
      return { code: 0, stdout: "", stderr: "" };
    };
    const png = await captureWindowPng(7, run);
    expect(cmds).toEqual(["screencapture"]);
    expect(png.equals(small)).toBe(true);
    expect(existsSync(tmp)).toBe(false);
  });

  test("긴 변이 딱 1568 이면 줄이지 않고, 높이가 길어도 긴 변을 본다", async () => {
    for (const [w, h, expectSips] of [[1568, 900, false], [900, 1568, false], [900, 1569, true]] as const) {
      const cmds: string[] = [];
      const run: RunCmd = async (cmd, args) => {
        cmds.push(cmd);
        if (cmd === "screencapture") writeFileSync(args.at(-1)!, fakePng(w, h, "dd"));
        return { code: 0, stdout: "", stderr: "" };
      };
      await captureWindowPng(7, run);
      expect(cmds.includes("sips")).toBe(expectSips);
    }
  });

  test("sips 가 실패해도 임시 파일을 지운다", async () => {
    let tmp = "";
    const run: RunCmd = async (cmd, args) => {
      tmp = args.at(-1)!;
      if (cmd === "screencapture") {
        writeFileSync(tmp, PNG_BIG);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "boom" };
    };
    await expect(captureWindowPng(5, run)).rejects.toMatchObject({ code: "SAFARI_ERROR" });
    expect(existsSync(tmp)).toBe(false);
  });
});
