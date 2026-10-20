import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { FlowCatalog } from "./flow-catalog.js";
import type { CatalogWriteResult, StoredFlow } from "./flow-catalog.js";
import type { ComponentRegistry } from "./registry.js";

export interface LoopbackApiOptions {
  registry: ComponentRegistry;
  /** Must be supplied by the caller, kept out of logs and URLs. */
  token: string;
  port?: number;
  /** Explicit browser origins; no Origin header is expected from CLI clients. */
  allowed_origins?: readonly string[];
  max_body_bytes?: number;
}

export interface LoopbackApiHandle {
  base_url: string;
  close(): Promise<void>;
}

type RequestMethod = "GET" | "POST" | "PATCH";

const METHODS = new Set<RequestMethod>(["GET", "POST", "PATCH"]);

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(
  response: ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(data));
}

function problem(response: ServerResponse, error: ApiError): void {
  const headers =
    error.status === 401 ? { "WWW-Authenticate": "Bearer" } : {};
  send(
    response,
    error.status,
    { error: { code: error.code, message: error.message } },
    headers
  );
}

function safeRequestPath(request: IncomingMessage): URL {
  const raw = request.url;
  if (raw === undefined || !raw.startsWith("/") || raw.startsWith("//")) {
    throw new ApiError(400, "INVALID_PATH", "An origin-form request path is required");
  }
  try {
    return new URL(raw, "http://127.0.0.1");
  } catch {
    throw new ApiError(400, "INVALID_PATH", "Invalid request path");
  }
}

function flowId(path: string): string {
  try {
    const id = decodeURIComponent(path);
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(id)) {
      throw new Error("invalid");
    }
    return id;
  } catch {
    throw new ApiError(400, "INVALID_FLOW_ID", "Invalid Flow identifier");
  }
}

async function jsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const type = request.headers["content-type"];
  if (typeof type !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }

  const length = request.headers["content-length"];
  if (length !== undefined && Number(length) > limit) {
    throw new ApiError(413, "BODY_TOO_LARGE", "JSON body exceeds the size limit");
  }

  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > limit) {
      throw new ApiError(413, "BODY_TOO_LARGE", "JSON body exceeds the size limit");
    }
    parts.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}

function entryHeaders(entry: StoredFlow): Record<string, string> {
  return { ETag: '"' + entry.revision + '"' };
}

function writeFailure(response: ServerResponse, result: Exclude<CatalogWriteResult, { ok: true }>): void {
  const status = result.reason === "invalid" || result.reason === "id_mismatch" ? 422
    : result.reason === "exists" ? 409
    : result.reason === "not_found" ? 404 : 412;
  send(response, status, {
    error: { code: result.reason.toUpperCase(), message: "Flow registration was rejected" },
    diagnostics: result.diagnostics
  });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateOptions(options: LoopbackApiOptions): {
  port: number;
  tokenHash: Buffer;
  allowedOrigins: ReadonlySet<string>;
  maxBodyBytes: number;
} {
  if (typeof options.token !== "string" || Buffer.byteLength(options.token) < 32) {
    throw new Error("Loopback API requires a caller-supplied token of at least 32 bytes");
  }

  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid loopback API port");
  }

  const maxBodyBytes = options.max_body_bytes ?? 1024 * 1024;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 4 * 1024 * 1024) {
    throw new Error("Invalid maximum JSON body size");
  }

  const allowedOrigins = new Set<string>();
  for (const origin of options.allowed_origins ?? []) {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error("Allowed Origins must be exact HTTP(S) origins");
    }
    allowedOrigins.add(origin);
  }

  return {
    port,
    tokenHash: createHash("sha256").update(options.token).digest(),
    allowedOrigins,
    maxBodyBytes
  };
}

/**
 * Loopback-only, authenticated v0 flow catalog transport.
 * Deliberately does not expose run/start/resume/invoke before the
 * emergency-stop monitor and run persistence are integrated.
 */
export async function startLoopbackApi(options: LoopbackApiOptions): Promise<LoopbackApiHandle> {
  const config = validateOptions(options);
  const catalog = new FlowCatalog(options.registry);
  let listeningPort = -1;

  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host;
      if (host !== "127.0.0.1:" + listeningPort && host !== "localhost:" + listeningPort) {
        throw new ApiError(400, "INVALID_HOST", "Loopback Host header required");
      }

      const origin = request.headers.origin;
      if (origin !== undefined) {
        if (typeof origin !== "string" || !config.allowedOrigins.has(origin)) {
          throw new ApiError(403, "ORIGIN_DENIED", "Origin is not permitted");
        }
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
      }

      const url = safeRequestPath(request);
      if (request.method === "OPTIONS") {
        if (origin === undefined) {
          throw new ApiError(403, "ORIGIN_REQUIRED", "CORS preflight requires an Origin");
        }
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, PATCH",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match",
          "Cache-Control": "no-store",
          "Vary": "Origin"
        });
        response.end();
        return;
      }

      const authorization = request.headers.authorization ?? "";
      const match = /^Bearer (.+)$/.exec(authorization);
      const candidateHash = createHash("sha256").update(match?.[1] ?? "").digest();
      if (!match || !timingSafeEqual(candidateHash, config.tokenHash)) {
        throw new ApiError(401, "UNAUTHORIZED", "Bearer token required");
      }

      const method = request.method;
      if (method === undefined || !METHODS.has(method as RequestMethod)) {
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not supported");
      }

      if (url.pathname === "/api/v0/components" && method === "GET") {
        send(response, 200, {
          components: options.registry.list().map(({ manifest, manifest_sha256 }) => ({
            id: manifest.id,
            version: manifest.version,
            manifest_sha256
          }))
        });
        return;
      }

      const manifestMatch = /^\/api\/v0\/components\/([^/]+)\/manifest$/.exec(url.pathname);
      if (manifestMatch && method === "GET") {
        const id = flowId(manifestMatch[1] ?? "");
        const version = url.searchParams.get("version");
        if (!version) {
          throw new ApiError(400, "VERSION_REQUIRED", "Explicit component version is required");
        }
        const component = options.registry.get(id, version);
        if (!component) {
          throw new ApiError(404, "NOT_FOUND", "Component is not registered");
        }
        send(response, 200, {
          manifest: component.manifest,
          manifest_sha256: component.manifest_sha256
        });
        return;
      }

      if (url.pathname === "/api/v0/flows/validate" && method === "POST") {
        const raw = await jsonBody(request, config.maxBodyBytes);
        const result = catalog.validate(raw);
        send(response, 200, result.ok
          ? { valid: true, diagnostics: [] }
          : { valid: false, diagnostics: result.diagnostics });
        return;
      }

      if (url.pathname === "/api/v0/flows" && method === "POST") {
        const raw = await jsonBody(request, config.maxBodyBytes);
        const result = catalog.create(raw);
        if (!result.ok) {
          writeFailure(response, result);
          return;
        }
        send(response, 201, result.entry, {
          ...entryHeaders(result.entry),
          Location: "/api/v0/flows/" + encodeURIComponent(result.entry.flow.id)
        });
        return;
      }

      const flowMatch = /^\/api\/v0\/flows\/([^/]+)$/.exec(url.pathname);
      if (flowMatch) {
        const id = flowId(flowMatch[1] ?? "");
        if (method === "GET") {
          const entry = catalog.get(id);
          if (!entry) {
            throw new ApiError(404, "NOT_FOUND", "Flow does not exist");
          }
          send(response, 200, entry, entryHeaders(entry));
          return;
        }
        if (method === "PATCH") {
          const header = request.headers["if-match"];
          if (header === undefined) {
            throw new ApiError(428, "PRECONDITION_REQUIRED", "If-Match revision required");
          }
          if (typeof header !== "string" || !/^"[0-9a-f]{64}"$/.test(header)) {
            throw new ApiError(400, "INVALID_REVISION", "If-Match must contain one quoted revision");
          }
          const raw = await jsonBody(request, config.maxBodyBytes);
          const result = catalog.update(id, raw, header.slice(1, -1));
          if (!result.ok) {
            writeFailure(response, result);
            return;
          }
          send(response, 200, result.entry, entryHeaders(result.entry));
          return;
        }
      }

      // Never return a fake accepted/succeeded result for future operations.
      if (url.pathname.startsWith("/api/v0/runs") ||
          url.pathname.startsWith("/api/v0/operations")) {
        throw new ApiError(501, "NOT_IMPLEMENTED", "Run and operation APIs are not implemented");
      }
      if (isJsonObject(url) && url.pathname.startsWith("/api/v0/components/") && method === "POST") {
        throw new ApiError(501, "NOT_IMPLEMENTED", "Component invoke is not implemented");
      }

      throw new ApiError(404, "NOT_FOUND", "Unknown API endpoint");
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      problem(response, error instanceof ApiError
        ? error
        : new ApiError(500, "INTERNAL_ERROR", "Unexpected API error"));
    }
  });

  server.requestTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  listeningPort = address.port;
  return {
    base_url: "http://127.0.0.1:" + listeningPort,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}
