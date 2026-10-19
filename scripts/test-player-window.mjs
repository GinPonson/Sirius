import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// 执行真实窗口通信服务，用可控事件模拟跨 WebView 异步返回，避免只检查源码形状。
const source = await readFile(new URL("../src/services/playerWindowService.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

/** 建立不含真实 IPC 的可控会话，返回服务、结果投递入口与资源释放记录。 */
function createHarness() {
  let resultListener;
  let timeoutCallback;
  let removed = 0;
  let timersCleared = 0;
  let resolveSent;
  const sent = new Promise((resolve) => { resolveSent = resolve; });
  const context = {
    exports: {},
    crypto: { randomUUID: () => "request-1" },
    window: {
      setTimeout: (callback) => { timeoutCallback = callback; return 1; },
      clearTimeout: () => { timersCleared += 1; },
    },
    require: (name) => {
      if (name === "@tauri-apps/api/core") return { invoke: async () => undefined };
      if (name === "@tauri-apps/api/event") return {
        listen: async (event, listener) => {
          assert.equal(event, "player-window-result");
          resultListener = listener;
          return () => { removed += 1; };
        },
        emitTo: async (target, event, payload) => {
          assert.equal(target, "main");
          assert.equal(event, "player-window-action");
          resolveSent(payload);
        },
      };
      throw new Error(`Unexpected import: ${name}`);
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return {
    service: new context.exports.PlayerWindowService(),
    sent,
    reply: (id, error = null) => resultListener({ payload: { id, error } }),
    expire: () => timeoutCallback(),
    resources: () => ({ removed, timersCleared }),
  };
}

test("player action waits for its own execution result and releases its listener", async () => {
  const harness = createHarness();
  let completed = false;
  const operation = harness.service.perform({ type: "pause" }).then(() => { completed = true; });
  const request = await harness.sent;
  assert.equal(request.action.type, "pause");
  assert.equal(completed, false);
  harness.reply("stale-request");
  await Promise.resolve();
  assert.equal(completed, false);
  harness.reply(request.id);
  await operation;
  assert.equal(completed, true);
  assert.deepEqual(harness.resources(), { removed: 1, timersCleared: 1 });
});

test("player action exposes native errors instead of confirming success", async () => {
  const harness = createHarness();
  const operation = harness.service.perform({ type: "seek", seconds: 42 });
  const request = await harness.sent;
  harness.reply(request.id, "播放跳转失败");
  await assert.rejects(operation, /播放跳转失败/);
  assert.deepEqual(harness.resources(), { removed: 1, timersCleared: 1 });
});

test("an unanswered player action times out and removes the pending listener", async () => {
  const harness = createHarness();
  const operation = harness.service.perform({ type: "mute" });
  await harness.sent;
  harness.expire();
  await assert.rejects(operation, /响应超时/);
  assert.deepEqual(harness.resources(), { removed: 1, timersCleared: 1 });
});
