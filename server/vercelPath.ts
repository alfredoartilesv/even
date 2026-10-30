/**
 * Vercel matched `api/[[...route]].ts` for one path segment only: /api/health reached the function,
 * /api/v1/me got Vercel's own 404. So vercel.json now rewrites every API path to the single
 * function `api/index.ts` and carries the original path in `__path`; this puts it back so the app
 * routes the request as it would in the Docker container. Other query parameters are kept.
 */
export function restorePath(req: Request): Request {
  const url = new URL(req.url);
  const path = url.searchParams.get("__path");
  if (path === null || !path.startsWith("/")) return req;
  url.searchParams.delete("__path");
  url.pathname = path;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  // duplex is required by Node's fetch when the body is a stream; the DOM types do not know it.
  return new Request(url, { method: req.method, headers: req.headers, body: hasBody ? req.body : null, duplex: "half" } as RequestInit);
}
