import test from "node:test";
import assert from "node:assert/strict";
import { toBubble } from "../src/features/chat/bubbles";
import type { StoredMessage } from "../src/features/chat/store";

const msg = (role: StoredMessage["role"], content: unknown): StoredMessage => ({ id: "m1", seq: 0, role, content: content as StoredMessage["content"], model: null, stopReason: null, createdAt: 0 });

test("chat bubbles: the owner's text and photos, without the app's clock line", () => {
  const b = toBubble(
    msg("user", [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
      { type: "text", text: "  Log this lunch  " },
      { type: "text", text: "[App] Now: Monday 2026-10-26, 13:05 (time zone Europe/Madrid)." },
    ]),
  );
  assert.deepEqual(b, { id: "m1", role: "user", texts: ["Log this lunch"], images: ["data:image/jpeg;base64,AAAA"] });
});

test("chat bubbles: tool calls, tool results and thinking are hidden; a message of only those is skipped", () => {
  assert.equal(toBubble(msg("user", [{ type: "tool_result", tool_use_id: "t1", content: "{}" }])), null);
  const b = toBubble(
    msg("assistant", [
      { type: "thinking", thinking: "…" },
      { type: "tool_use", id: "t1", name: "log_food", input: {} },
      { type: "text", text: "Logged: 590 kcal." },
    ]),
  );
  assert.deepEqual(b?.texts, ["Logged: 590 kcal."]);
  assert.deepEqual(b?.images, []);
  assert.equal(toBubble(msg("assistant", [{ type: "tool_use", id: "t2", name: "get_profile", input: {} }])), null);
});

test("chat bubbles: plain string content is one text", () => {
  assert.deepEqual(toBubble(msg("assistant", "Hello"))?.texts, ["Hello"]);
});
