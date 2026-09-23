export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(
    `Content-Length: ${body.byteLength}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`,
    "ascii",
  );
  return Buffer.concat([header, body]);
}

export function createMessageParser(onMessage) {
  let buffered = Buffer.alloc(0);
  let expectedBodyBytes = null;

  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);

    while (true) {
      if (expectedBodyBytes === null) {
        const headerEnd = buffered.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;

        const rawHeader = buffered.subarray(0, headerEnd).toString("ascii");
        buffered = buffered.subarray(headerEnd + 4);

        const headers = Object.fromEntries(
          rawHeader
            .split("\r\n")
            .map((line) => line.split(/:\s*/, 2))
            .map(([key, value]) => [key.toLowerCase(), value]),
        );

        const contentLength = Number(headers["content-length"]);
        if (!Number.isInteger(contentLength) || contentLength < 0) {
          throw new Error("Missing or invalid Content-Length header");
        }

        expectedBodyBytes = contentLength;
      }

      if (buffered.byteLength < expectedBodyBytes) return;

      const body = buffered.subarray(0, expectedBodyBytes);
      buffered = buffered.subarray(expectedBodyBytes);
      expectedBodyBytes = null;

      onMessage(JSON.parse(body.toString("utf8")));
    }
  };
}
