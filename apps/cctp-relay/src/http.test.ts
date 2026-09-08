import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRelayHandler } from "./http.js";

const TOKEN = "shared-secret";
const HASH = "92421fa248da1b1d4418784d5bd91adc4238dae72120e8f740920db7381905a7";

async function call(
  handler: ReturnType<typeof createRelayHandler>,
  init: { method: string; url: string; auth?: string; body?: unknown },
) {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  req.method = init.method;
  req.url = init.url;
  req.headers = init.auth ? { authorization: init.auth } : {};

  let status = 0;
  let payload = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as unknown as ServerResponse;

  const done = handler(req, res);
  req.end(init.body === undefined ? undefined : JSON.stringify(init.body));
  await done;
  return { status, body: payload ? JSON.parse(payload) : undefined };
}

function handler(overrides: Partial<Parameters<typeof createRelayHandler>[0]> = {}) {
  const submitted: string[] = [];
  const h = createRelayHandler({
    submitToken: TOKEN,
    submit: async (txHash) => {
      submitted.push(txHash);
      return { jobId: "job-1", created: true };
    },
    ...overrides,
  });
  return { h, submitted };
}

describe("POST /burns", () => {
  it("queues an authorized burn", async () => {
    const { h, submitted } = handler();
    const res = await call(h, {
      method: "POST",
      url: "/burns",
      auth: `Bearer ${TOKEN}`,
      body: { txHash: HASH },
    });
    expect(res.status).toBe(201);
    expect(submitted).toEqual([HASH]);
  });

  it("rejects a caller with no token", async () => {
    // An open endpoint would let anyone have this service sponsor strangers' mints — 867,621
    // lamports of rent each, permanently, with no fee against it.
    const { h, submitted } = handler();
    const res = await call(h, { method: "POST", url: "/burns", body: { txHash: HASH } });
    expect(res.status).toBe(401);
    expect(submitted).toEqual([]);
  });

  it("rejects a wrong token", async () => {
    const { h, submitted } = handler();
    const res = await call(h, {
      method: "POST",
      url: "/burns",
      auth: "Bearer wrong",
      body: { txHash: HASH },
    });
    expect(res.status).toBe(401);
    expect(submitted).toEqual([]);
  });

  it("rejects a token of a different length without throwing", async () => {
    // `timingSafeEqual` throws on unequal-length buffers; hashing first is what avoids both
    // the throw and a length-based branch.
    const { h } = handler();
    const res = await call(h, {
      method: "POST",
      url: "/burns",
      auth: "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      body: { txHash: HASH },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed transaction hash", async () => {
    const { h, submitted } = handler();
    for (const txHash of ["", "not-hex", HASH.toUpperCase(), `${HASH}00`, HASH.slice(0, 63)]) {
      const res = await call(h, {
        method: "POST",
        url: "/burns",
        auth: `Bearer ${TOKEN}`,
        body: { txHash },
      });
      expect(res.status, txHash).toBe(400);
    }
    expect(submitted).toEqual([]);
  });

  it("answers 200, not a conflict, when the burn was already queued", async () => {
    // The frontend retries on a flaky network. A duplicate must read as success.
    const { h } = handler({ submit: async () => ({ jobId: "job-1", created: false }) });
    const res = await call(h, {
      method: "POST",
      url: "/burns",
      auth: `Bearer ${TOKEN}`,
      body: { txHash: HASH },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jobId: "job-1", created: false });
  });

  it("does not leak the internal error to the caller", async () => {
    const { h } = handler({
      submit: async () => {
        throw new Error("postgres: password authentication failed for user relay");
      },
    });
    const res = await call(h, {
      method: "POST",
      url: "/burns",
      auth: `Bearer ${TOKEN}`,
      body: { txHash: HASH },
    });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("password");
  });
});

describe("GET /health", () => {
  it("needs no token", async () => {
    const { h } = handler();
    expect((await call(h, { method: "GET", url: "/health" })).status).toBe(200);
  });

  it("reports 503 when the check fails, so a load balancer drains the task", async () => {
    const { h } = handler({ health: async () => ({ ok: false, detail: { db: "down" } }) });
    const res = await call(h, { method: "GET", url: "/health" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, detail: { db: "down" } });
  });
});

describe("routing", () => {
  it("404s anything else", async () => {
    const { h } = handler();
    expect((await call(h, { method: "GET", url: "/burns" })).status).toBe(404);
    expect((await call(h, { method: "POST", url: "/mint" })).status).toBe(404);
  });
});
