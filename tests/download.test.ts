import { createServer, get } from "node:http";
import type { IncomingMessage } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it } from "vitest";
import { saveDownload } from "../packages/core/network.js";
it("bounds chunked and declared HTTP bodies, cleans partials, and preserves existing files", async () => {
  const root = mkdtempSync(join(tmpdir(), "lens-transfer-"));
  const path = join(root, "source.mp4");
  const server = createServer((req, res) => {
    if (req.url === "/declared") res.setHeader("content-length", "6");
    res.write("abc");
    res.end("def");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string")
    throw new Error("test port unavailable");
  const response = (route: string) =>
    new Promise<IncomingMessage>((resolve, reject) =>
      get({ host: "127.0.0.1", port: addr.port, path: route }, resolve).once(
        "error",
        reject,
      ),
    );
  try {
    for (const route of ["/declared", "/chunked"]) {
      await expect(
        saveDownload(await response(route), path, 3, 10),
      ).rejects.toMatchObject({
        code: "SIZE_LIMIT",
        message: expect.stringContaining(
          route === "/declared" ? "响应声明 6 字节" : "已收到至少 6 字节",
        ),
        details: {
          limitBytes: 10,
          remainingBytes: 3,
          ...(route === "/declared"
            ? { declaredBytes: 6 }
            : { receivedBytes: 6 }),
        },
      });
      expect(existsSync(path)).toBe(false);
    }
    await saveDownload(await response("/chunked"), path, 6);
    expect(readFileSync(path, "utf8")).toBe("abcdef");
    await expect(
      saveDownload(await response("/chunked"), path, 6),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(path, "utf8")).toBe("abcdef");
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
