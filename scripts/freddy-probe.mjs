// Probe your freddy MCP endpoint from your own computer. Zero dependencies (Node 18+).
//
// It answers four questions about phase 1:
//   1. Does the URL work on its own, or does it need the key as a Bearer token?
//   2. Are responses plain JSON or an event stream (SSE)?  (matters for a phone WebView)
//   3. Does the server send CORS headers for a WebView origin?
//   4. What do list_metrics / query_metrics return, in text?
//
// It never prints the URL or the key. Put them in .env (copy .env.example), then run:
//
//   node --env-file=.env scripts/freddy-probe.mjs
//
// (--env-file needs Node 20.6+.) Or set them for one session in PowerShell:
//
//   $env:FREDDY_MCP_URL = Read-Host "MCP URL"
//   $env:FREDDY_MCP_KEY = Read-Host "MCP key (Enter to skip)"
//   node scripts/freddy-probe.mjs

const url = process.env.FREDDY_MCP_URL;
const key = process.env.FREDDY_MCP_KEY || "";
if (!url) {
  console.error("FREDDY_MCP_URL is empty. Fill it in .env and run: node --env-file=.env scripts/freddy-probe.mjs");
  process.exit(1);
}

const out = [];
const say = (s) => {
  out.push(s);
  console.log(s);
};
const safe = (e) => (e?.cause?.code || e?.name || "error") + (e?.message ? `: ${String(e.message).replaceAll(url, "<url>").replaceAll(key || "\u0000", "<key>")}` : "");

function parseBody(contentType, text) {
  if (contentType.includes("text/event-stream")) {
    const msgs = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return msgs.at(-1) ?? null;
  }
  return text ? JSON.parse(text) : null;
}

let sessionId = null;
let authHeader = null; // null = URL only

async function rpc(message, { expectReply = true } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (authHeader) headers.authorization = authHeader;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
  const ct = res.headers.get("content-type") || "";
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await res.text();
  let body = null;
  if (res.ok && expectReply && text) {
    try {
      body = parseBody(ct, text);
    } catch {
      body = null;
    }
  }
  return { status: res.status, ok: res.ok, contentType: ct.split(";")[0] || "(none)", body, rawLength: text.length };
}

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "health-app-probe", version: "0.1.0" } },
};

async function main() {
  say("== freddy MCP probe ==");

  // 3. CORS preflight as a Capacitor Android WebView would send it (origin https://localhost)
  try {
    const pre = await fetch(url, {
      method: "OPTIONS",
      headers: {
        origin: "https://localhost",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization,mcp-session-id",
      },
    });
    const allow = pre.headers.get("access-control-allow-origin");
    const hdrs = pre.headers.get("access-control-allow-headers");
    say(`CORS preflight: HTTP ${pre.status}, allow-origin=${allow ?? "(none)"}, allow-headers=${hdrs ?? "(none)"}`);
    say(allow ? "  -> a WebView might be allowed to call this directly." : "  -> no CORS headers: a WebView fetch would be blocked. Use native HTTP (Capacitor) instead.");
  } catch (e) {
    say(`CORS preflight failed: ${safe(e)}`);
  }

  // 1. auth mode
  let r;
  try {
    r = await rpc(init);
  } catch (e) {
    say(`initialize failed: ${safe(e)}`);
    return;
  }
  say(`initialize (URL only): HTTP ${r.status}, ${r.contentType}`);
  if (!r.ok && (r.status === 401 || r.status === 403) && key) {
    authHeader = `Bearer ${key}`;
    sessionId = null;
    r = await rpc(init);
    say(`initialize (URL + Bearer key): HTTP ${r.status}, ${r.contentType}`);
  }
  if (!r.ok) {
    say("RESULT: could not initialize. Check the URL/key, or the endpoint needs OAuth.");
    return;
  }
  say(`AUTH MODE: ${authHeader ? "URL + Bearer key" : "URL only (the URL itself is the secret)"}`);
  say(`TRANSPORT: responses come as ${r.contentType === "text/event-stream" ? "an event stream (SSE)" : r.contentType}`);
  say(`SESSION ID: ${sessionId ? "yes" : "no (stateless server)"}`);
  const server = r.body?.result?.serverInfo;
  if (server) say(`SERVER: ${server.name ?? "?"} ${server.version ?? ""}`.trim());

  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { expectReply: false });

  // 4. tools
  const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const names = tools.body?.result?.tools?.map((t) => t.name) ?? [];
  say(`TOOLS (${names.length}): ${names.join(", ") || "(none)"}`);

  const lm = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_metrics", arguments: {} } });
  const lmText = lm.body?.result?.content?.find((c) => c.type === "text")?.text ?? "";
  const metricLines = lmText.split(/\r?\n/).filter((l) => /^[A-Za-z0-9_]+: \d+ records?/.test(l));
  say(`list_metrics: HTTP ${lm.status}, ${metricLines.length} metric lines`);
  if (metricLines[0]) say(`  first line: ${metricLines[0]}`);

  const q = await rpc({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "query_metrics", arguments: { metrics: ["daily_steps"], days: 2 } },
  });
  const qText = q.body?.result?.content?.find((c) => c.type === "text")?.text ?? "";
  say(`query_metrics(daily_steps, 2 days): HTTP ${q.status}, ${qText.split(/\r?\n/).length} lines`);
  for (const l of qText.split(/\r?\n/).slice(0, 8)) say(`  | ${l}`);

  say("== done. Paste this output back into the chat (it contains no URL or key). ==");
}

main().catch((e) => say(`probe crashed: ${safe(e)}`));
