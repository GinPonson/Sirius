import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const helperPath = new URL("../src/domain/aiChatRegeneration.ts", import.meta.url);
const componentPath = new URL("../src/components/AiChatPanel.tsx", import.meta.url);
const helperSource = await readFile(helperPath, "utf8");
const componentSourceText = await readFile(componentPath, "utf8");
const componentSource = ts.createSourceFile(
  componentPath.pathname,
  componentSourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

/** 编译并加载无外部 import 的 TypeScript 回调或 domain helper。 */
function evaluateTypeScript(source, context = {}) {
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return vm.runInNewContext(javascript, context);
}

/** 从 AiChatPanel 的变量声明中取出 useCallback 的真实回调源码。 */
function extractComponentCallback(variableName) {
  let callbackSource;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "useCallback"
    ) {
      callbackSource = node.initializer.arguments[0]?.getText(componentSource);
    }
    ts.forEachChild(node, visit);
  }
  visit(componentSource);
  assert.ok(callbackSource, `未找到 ${variableName} 的 useCallback`);
  return callbackSource;
}

const helperModuleSource = ts.transpileModule(helperSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const helperContext = { exports: {} };
vm.runInNewContext(helperModuleSource, helperContext);
const helpers = helperContext.exports;

class MockStreamAggregator {
  streams = new Map();

  track(receipt) {
    this.streams.set(receipt.messageId, {
      sessionId: receipt.sessionId,
      messageId: receipt.messageId,
      text: "",
      status: "streaming",
    });
  }

  consume(event) {
    const previous = this.streams.get(event.messageId);
    if (!previous || previous.sessionId !== event.sessionId) return null;
    if (event.done) {
      this.streams.delete(event.messageId);
      return {
        ...previous,
        status: event.error ? "error" : "done",
        error: event.error,
      };
    }
    const next = { ...previous, text: previous.text + event.delta, status: "streaming" };
    this.streams.set(event.messageId, next);
    return next;
  }
}

/** 为真实面板回调注入最小可控的 React 状态、refs、服务和事件聚合器。 */
function createHarness({ entries = [], sessionId = "session-a", send }) {
  const state = { entries };
  const calls = [];
  const streamMapRef = { current: new Map() };
  const aggregator = new MockStreamAggregator();
  const context = { scope: "网盘", page: "cloud-files", folderId: "folder-1" };
  const sandbox = {
    activeSessionRef: { current: sessionId },
    entriesRef: { current: entries },
    sendingRef: { current: false },
    streamingRef: { current: false },
    getPageContext: () => context,
    toContextPayload: (value) => value,
    contextIdentity: () => null,
    scopeLabel: (value) => value?.scope ?? "新页面",
    lastContextKeyRef: { current: null },
    looksLikeOrganizeIntent: () => false,
    setSendError: (value) => { state.sendError = value; },
    setSending: (value) => { state.sending = value; },
    chat: {
      send: (...args) => {
        calls.push(args);
        return send(...args);
      },
    },
    runAnalyze: async () => {},
    setEntries: (update) => {
      state.entries = typeof update === "function" ? update(state.entries) : update;
    },
    updateAssistantEntry: helpers.updateAssistantEntry,
    isCurrentChatSession: helpers.isCurrentChatSession,
    streamMapRef,
    aggregatorRef: { current: aggregator },
    reloadHistoryRef: { current: async () => {} },
    openRef: { current: true },
    setUnseen: () => {},
  };
  const sendMessage = evaluateTypeScript(`(${extractComponentCallback("sendMessage")})`, sandbox);
  sandbox.sendMessage = sendMessage;
  const regenerate = evaluateTypeScript(`(${extractComponentCallback("regenerate")})`, sandbox);
  const handleTokenEvent = evaluateTypeScript(`(${extractComponentCallback("handleTokenEvent")})`, sandbox);
  return { state, calls, sandbox, sendMessage, regenerate, handleTokenEvent, streamMapRef, aggregator };
}

test("real regenerate callback replaces the historical assistant and maps stream events to it", async () => {
  const originalContext = { scope: "网盘", page: "cloud-files", folderId: "folder-1" };
  const entries = [
    { kind: "user", id: "user-1", content: "第一轮", context: originalContext },
    { kind: "assistant", id: "assistant-1", content: "旧回复", status: "done", replyToId: "user-1" },
    { kind: "user", id: "user-2", content: "后续问题", context: null },
    { kind: "assistant", id: "assistant-2", content: "后续回复", status: "done", replyToId: "user-2" },
  ];
  const harness = createHarness({
    entries,
    send: async () => ({ sessionId: "session-a", messageId: "assistant-1", userMessageId: "user-1" }),
  });

  await harness.regenerate("assistant-1");

  assert.deepEqual(harness.calls[0], ["session-a", "第一轮", originalContext, "assistant-1"]);
  assert.equal(harness.state.entries.length, entries.length);
  assert.equal(harness.state.entries[0], entries[0]);
  assert.equal(harness.state.entries[1].id, "assistant-1");
  assert.equal(harness.state.entries[1].status, "streaming");
  assert.equal(harness.state.entries[2], entries[2]);
  assert.equal(harness.state.entries[3], entries[3]);
  const regenerationMapping = harness.streamMapRef.current.get("assistant-1");
  assert.equal(regenerationMapping.entryId, "assistant-1");
  assert.equal(regenerationMapping.sessionId, "session-a");

  harness.handleTokenEvent({
    sessionId: "session-a",
    messageId: "assistant-1",
    delta: "新回复",
    done: false,
  });
  assert.equal(harness.state.entries[1].content, "新回复");
  assert.equal(harness.state.entries[1].status, "streaming");
  assert.equal(harness.state.entries[0], entries[0]);
  assert.equal(harness.state.entries[2], entries[2]);

  harness.handleTokenEvent({
    sessionId: "session-a",
    messageId: "assistant-1",
    delta: "",
    done: true,
  });
  assert.equal(harness.state.entries[1].status, "done");
  assert.equal(harness.streamMapRef.current.has("assistant-1"), false);
});

test("a freshly sent assistant uses its receipt ID for the next regeneration", async () => {
  const receipts = [
    { sessionId: "session-a", messageId: "assistant-fresh", userMessageId: "user-fresh" },
    { sessionId: "session-a", messageId: "assistant-fresh", userMessageId: "user-fresh" },
  ];
  const harness = createHarness({ entries: [], send: async () => receipts.shift() });

  await harness.sendMessage("刚发送的问题");
  assert.equal(harness.state.entries.length, 2);
  assert.equal(harness.state.entries[0].id, "user-fresh");
  assert.equal(harness.state.entries[1].id, "assistant-fresh");

  harness.sandbox.entriesRef.current = harness.state.entries;
  await harness.regenerate("assistant-fresh");

  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[1][3], "assistant-fresh");
  assert.equal(harness.state.entries.length, 2);
  assert.equal(harness.state.entries[0].id, "user-fresh");
  assert.equal(harness.state.entries[1].id, "assistant-fresh");
  assert.equal(harness.state.entries[1].replyToId, "user-fresh");
  assert.equal(harness.state.entries[1].status, "streaming");
});

test("a delayed send receipt and its events cannot write session A into session B", async () => {
  let resolveReceipt;
  const delayedReceipt = new Promise((resolve) => { resolveReceipt = resolve; });
  const bEntries = [
    { kind: "user", id: "user-b", content: "B 的问题", context: null },
    { kind: "assistant", id: "assistant-b", content: "B 的回复", status: "done", replyToId: "user-b" },
  ];
  const harness = createHarness({
    entries: [],
    sessionId: "session-a",
    send: () => delayedReceipt,
  });

  const pendingSend = harness.sendMessage("A 的问题");
  harness.sandbox.activeSessionRef.current = "session-b";
  harness.sandbox.entriesRef.current = bEntries;
  harness.state.entries = bEntries;
  resolveReceipt({ sessionId: "session-a", messageId: "assistant-a", userMessageId: "user-a" });
  await pendingSend;

  assert.equal(harness.state.entries, bEntries);
  const delayedMapping = harness.streamMapRef.current.get("assistant-a");
  assert.equal(delayedMapping.entryId, "assistant-a");
  assert.equal(delayedMapping.sessionId, "session-a");

  harness.handleTokenEvent({
    sessionId: "session-a",
    messageId: "assistant-a",
    delta: "A 的回复",
    done: false,
  });
  harness.handleTokenEvent({
    sessionId: "session-a",
    messageId: "assistant-a",
    delta: "",
    done: true,
  });

  assert.equal(harness.state.entries, bEntries);
  assert.deepEqual(harness.state.entries.map((entry) => entry.id), ["user-b", "assistant-b"]);
  assert.equal(harness.streamMapRef.current.has("assistant-a"), false);
});

test("session result guard rejects stale and mismatched sessions", () => {
  assert.equal(helpers.isCurrentChatSession("session-a", "session-b", "session-a"), false);
  assert.equal(helpers.isCurrentChatSession("session-a", "session-a", "session-b"), false);
  assert.equal(helpers.isCurrentChatSession("session-a", "session-a", "session-a"), true);
});
