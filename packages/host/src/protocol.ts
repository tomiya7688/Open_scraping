import type {
  ChildProcessWithoutNullStreams
} from "node:child_process";

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export class WorkerExitedError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(code: number | null, signal: NodeJS.Signals | null) {
    super(
      `Worker exited before the request completed (code=${String(code)}, signal=${String(signal)})`
    );
    this.name = "WorkerExitedError";
    this.code = code;
    this.signal = signal;
  }
}

export interface JsonRpcPeerOptions {
  max_frame_bytes?: number;
  on_notification?: (method: string, params: unknown) => void;
  on_request?: (method: string, params: unknown) => Promise<unknown>;
  on_diagnostic?: (code: string, message: string) => void;
  on_failure?: (error: Error) => void;
}

export function encodeFramedMessage(
  message: unknown,
  maxFrameBytes = 4 * 1024 * 1024
): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");

  if (body.byteLength > maxFrameBytes) {
    throw new ProtocolError(
      `JSON-RPC frame exceeds limit: ${body.byteLength} > ${maxFrameBytes}`
    );
  }

  const header = Buffer.from(
    `Content-Length: ${body.byteLength}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`,
    "ascii"
  );

  return Buffer.concat([header, body]);
}

export class ContentLengthMessageParser {
  readonly #maxFrameBytes: number;
  readonly #maxHeaderBytes: number;
  #buffer = Buffer.alloc(0);
  #expectedBodyBytes: number | undefined;

  constructor(
    maxFrameBytes = 4 * 1024 * 1024,
    maxHeaderBytes = 8192
  ) {
    this.#maxFrameBytes = maxFrameBytes;
    this.#maxHeaderBytes = maxHeaderBytes;
  }

  feed(chunk: Buffer): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];

    while (true) {
      if (this.#expectedBodyBytes === undefined) {
        const headerEnd = this.#buffer.indexOf("\r\n\r\n");

        if (headerEnd < 0) {
          if (this.#buffer.byteLength > this.#maxHeaderBytes) {
            throw new ProtocolError("JSON-RPC header exceeds size limit");
          }
          return messages;
        }

        if (headerEnd > this.#maxHeaderBytes) {
          throw new ProtocolError("JSON-RPC header exceeds size limit");
        }

        const rawHeader = this.#buffer
          .subarray(0, headerEnd)
          .toString("ascii");
        this.#buffer = this.#buffer.subarray(headerEnd + 4);

        const headers = new Map<string, string>();

        for (const line of rawHeader.split("\r\n")) {
          const separator = line.indexOf(":");
          if (separator <= 0) {
            throw new ProtocolError("Malformed JSON-RPC frame header");
          }

          headers.set(
            line.slice(0, separator).trim().toLowerCase(),
            line.slice(separator + 1).trim()
          );
        }

        const contentLength = Number(headers.get("content-length"));

        if (
          !Number.isSafeInteger(contentLength) ||
          contentLength < 0
        ) {
          throw new ProtocolError(
            "Missing or invalid Content-Length header"
          );
        }

        if (contentLength > this.#maxFrameBytes) {
          throw new ProtocolError(
            `JSON-RPC frame exceeds limit: ${contentLength} > ${this.#maxFrameBytes}`
          );
        }

        this.#expectedBodyBytes = contentLength;
      }

      if (this.#buffer.byteLength < this.#expectedBodyBytes) {
        return messages;
      }

      const body = this.#buffer.subarray(
        0,
        this.#expectedBodyBytes
      );
      this.#buffer = this.#buffer.subarray(
        this.#expectedBodyBytes
      );
      this.#expectedBodyBytes = undefined;

      try {
        messages.push(JSON.parse(body.toString("utf8")));
      } catch {
        throw new ProtocolError("Worker sent invalid JSON");
      }
    }
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function asRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class JsonRpcPeer {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #parser: ContentLengthMessageParser;
  readonly #maxFrameBytes: number;
  readonly #options: JsonRpcPeerOptions;
  readonly #pending = new Map<string | number, PendingRequest>();
  #nextId = 1;
  #closed = false;

  constructor(
    child: ChildProcessWithoutNullStreams,
    options: JsonRpcPeerOptions = {}
  ) {
    this.#child = child;
    this.#maxFrameBytes =
      options.max_frame_bytes ?? 4 * 1024 * 1024;
    this.#parser = new ContentLengthMessageParser(
      this.#maxFrameBytes
    );
    this.#options = options;

    child.stdout.on("data", (chunk: Buffer) => {
      if (this.#closed) return;

      try {
        for (const message of this.#parser.feed(chunk)) {
          this.#handleMessage(message);
        }
      } catch (error) {
        this.terminate(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.#options.on_diagnostic?.(
        "WORKER_STDERR",
        `Worker emitted ${chunk.byteLength} bytes on stderr; content withheld`
      );
    });

    child.once("exit", (code, signal) => {
      if (this.#closed) return;
      this.#fail(new WorkerExitedError(code, signal), false);
    });

    child.once("error", (error) => {
      if (this.#closed) return;
      this.#fail(error, false);
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error("JSON-RPC peer is closed"));
    }

    const id = this.#nextId;
    this.#nextId += 1;

    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });

    try {
      this.#write({
        jsonrpc: "2.0",
        id,
        method,
        params
      });
    } catch (error) {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      pending?.reject(
        error instanceof Error ? error : new Error(String(error))
      );
    }

    return promise;
  }

  notify(method: string, params: unknown): void {
    if (this.#closed) return;

    this.#write({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;

    const error = new Error("JSON-RPC peer closed");

    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();

    this.#child.kill();
  }

  terminate(error: Error): void {
    if (this.#closed) return;
    this.#fail(error, true);
  }

  #write(message: unknown): void {
    const frame = encodeFramedMessage(
      message,
      this.#maxFrameBytes
    );
    this.#child.stdin.write(frame);
  }

  #handleMessage(value: unknown): void {
    const message = asRecord(value);

    if (message?.jsonrpc !== "2.0") {
      throw new ProtocolError("Worker sent an invalid JSON-RPC message");
    }

    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        const id = message.id;

        if (
          typeof id !== "string" &&
          typeof id !== "number"
        ) {
          throw new ProtocolError(
            "Worker request id must be string or number"
          );
        }

        const handler = this.#options.on_request;
        if (!handler) {
          this.#write({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: "Method not found"
            }
          });
          return;
        }

        void handler(message.method, message.params)
          .then((result) => {
            if (this.#closed) return;
            this.#write({
              jsonrpc: "2.0",
              id,
              result
            });
          })
          .catch((error) => {
            if (this.#closed) return;
            this.#write({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32000,
                message:
                  error instanceof Error
                    ? error.message
                    : String(error)
              }
            });
          });
        return;
      }

      this.#options.on_notification?.(
        message.method,
        message.params
      );
      return;
    }

    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") {
      throw new ProtocolError(
        "Worker response id must be string or number"
      );
    }

    const pending = this.#pending.get(id);
    if (!pending) {
      this.#options.on_diagnostic?.(
        "LATE_OR_UNKNOWN_RESPONSE",
        "Ignored a response for a request that is no longer pending"
      );
      return;
    }

    this.#pending.delete(id);

    if (message.error !== undefined) {
      const errorRecord = asRecord(message.error);
      pending.reject(
        new Error(
          typeof errorRecord?.message === "string"
            ? errorRecord.message
            : "Worker returned a JSON-RPC error"
        )
      );
      return;
    }

    pending.resolve(message.result);
  }

  #fail(error: Error, kill: boolean): void {
    if (this.#closed) return;
    this.#closed = true;

    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();

    this.#options.on_failure?.(error);

    if (kill) this.#child.kill();
  }
}
