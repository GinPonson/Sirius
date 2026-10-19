import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// 执行真实画质切换回调，确保跨服务参数不会把 fileId 与 pickCode 混用。
const source = ts.createSourceFile("App.tsx", await readFile(new URL("../src/App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
let muteCallback;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "switchQuality") callback = node.getText(source);
  if (ts.isFunctionDeclaration(node) && node.name?.text === "toggleMute") muteCallback = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(callback, "App 中必须存在实际使用的画质切换回调");
const code = ts.transpileModule(`${callback}\nglobalThis.switchQuality = switchQuality;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

test("quality switching keeps the provider pick code, subtitles and playback position", async () => {
  const opened = [];
  const sought = [];
  const context = {
    playingMedia: { id: "cloud115-file-123" },
    playingCloudFileId: "file-123",
    activePickCode: "pick-code-abc",
    activeSubtitles: [{ url: "https://example.invalid/subtitle.srt" }],
    activeUserAgent: "test-agent",
    snapshot: { positionSeconds: 42 },
    cloud115Service: { playbackSource: async (pickCode) => {
      assert.equal(pickCode, "pick-code-abc");
      return { url: "https://example.invalid/fresh", quality: "720P", fallbackOptions: [] };
    } },
    playbackService: {
      openRemote: async (...args) => { opened.push(args); return { initialized: true }; },
      seek: async (seconds) => { sought.push(seconds); return { initialized: true, positionSeconds: seconds }; },
    },
    setSnapshot: () => {},
    setActiveQuality: (quality) => assert.equal(quality, "720P"),
    setError: (error) => assert.equal(error, null),
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  await context.switchQuality({ url: "https://example.invalid/expired", quality: "720P" });
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0].url, "https://example.invalid/fresh");
  assert.equal(opened[0][2], "pick-code-abc");
  assert.equal(opened[0][1], context.activeSubtitles);
  assert.equal(opened[0][4], 42, "恢复位置必须随新媒体一起交给 Rust，不能在未 ready 时单独 seek");
  assert.deepEqual(sought, []);
});

test("unmuting restores the actual initial player volume before any slider adjustment", () => {
  assert.ok(muteCallback, "App 中必须存在实际使用的静音回调");
  const changes = [];
  const context = {
    snapshot: { volume: 100 },
    lastVolumeRef: { current: 60 },
    changeVolume: (volume) => changes.push(volume),
  };
  vm.createContext(context);
  const muteCode = ts.transpileModule(`${muteCallback}\nglobalThis.toggleMute = toggleMute;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInContext(muteCode, context);
  context.toggleMute();
  context.snapshot.volume = 0;
  context.toggleMute();
  assert.deepEqual(changes, [0, 100]);
});
