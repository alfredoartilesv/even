import type { ToolCaller } from "./freddy";

/**
 * Tiny MCP-over-HTTP client, just enough to call tools on freddy's endpoint.
 *
 * Why not the official SDK: freddy's CORS preflight only allows the headers
 * content-type, authorization and mcp-session-id. The SDK also sends
 * mcp-protocol-version, which a WebView would block. This client sends only those three.
 *
 * Errors never contain the URL or the key.
 */
export interface McpHttpOptions {
  url: string;
  apiKey?: string;
  /** Inject for tests, or a native-HTTP fetch on the phone. Defaults to global fetch. */
  fetch?: typeof fetch;
  clientName?: string;
}

interface RpcReply {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "McpHttpError";
  }
}

/** Pick the JSON-RPC reply for `id` out of a JSON body or a text/event-stream body. */
export function parseRpcBody(contentType: string, text: string, id: number): RpcReply | null {
  if (!text.trim()) return null;
  if (contentType.includes("text/event-stream")) {
    const replies: RpcReply[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        replies.push(JSON.parse(payload) as RpcReply);
      } catch {
        /* ignore non-JSON keep-alives */
      }
    }
    return replies.find((r) => r.id === id) ?? null;
  }
  const parsed = JSON.parse(text) as RpcReply | RpcReply[];
  return Array.isArray(parsed) ? (parsed.find((r) => r.id === id) ?? null) : parsed;
}

export class McpHttpCaller implements ToolCaller {
  private nextId = 1;
  private sessionId: string | null = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly opts: McpHttpOptions) {
    if (!opts.url) throw new McpHttpError("MCP URL is empty");
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.initialize();
    const reply = await this.rpc("tools/call", { name, arguments: args });
    const result = reply.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
    const text = (result?.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
    if (result?.isError) throw new McpHttpError(`freddy tool "${name}" failed: ${text.slice(0, 300)}`);
    return text;
  }

  private initialize(): Promise<void> {
    this.ready ??= (async () => {
      await this.rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: this.opts.clientName ?? "health-app", version: "0.1.0" },
      });
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    })().catch((e) => {
      this.ready = null; // allow a retry on the next call
      throw e;
    });
    return this.ready;
  }

  private async rpc(method: string, params: unknown): Promise<RpcReply> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    const text = await res.text();
    let reply: RpcReply | null;
    try {
      reply = parseRpcBody(res.headers.get("content-type") ?? "", text, id);
    } catch {
      throw new McpHttpError(`Unreadable reply to ${method}`, res.status);
    }
    if (!reply) throw new McpHttpError(`No reply to ${method}`, res.status);
    if (reply.error) throw new McpHttpError(`${method} failed: ${reply.error.message}`, res.status);
    return reply;
  }

  private async post(body: unknown): Promise<Response> {
    const doFetch = this.opts.fetch ?? fetch;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    let res: Response;
    try {
      res = await doFetch(this.opts.url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      // Do not forward e.message: some runtimes include the URL in it.
      throw new McpHttpError(`Network error contacting freddy (${(e as { cause?: { code?: string } }).cause?.code ?? "unreachable"})`);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 401 || res.status === 403) {
      throw new McpHttpError(`freddy rejected the credentials (HTTP ${res.status}). Check the MCP key.`, res.status);
    }
    if (!res.ok) throw new McpHttpError(`freddy answered HTTP ${res.status}`, res.status);
    return res;
  }
}
