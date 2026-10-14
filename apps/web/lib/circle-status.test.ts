import { afterEach, describe, expect, it, vi } from "vitest";
import { getCircleHealth, getDelivery, getRouteHealth, requestReattest } from "./circle-status";

const reply = (body: unknown, status = 200) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body, { status })),
  );

afterEach(() => vi.unstubAllGlobals());

describe("getDelivery", () => {
  it("passes a known state through", async () => {
    reply({ status: "known", state: "delivered", forwardTxHash: "0x1", reason: null });
    expect(await getDelivery("ab")).toMatchObject({ status: "known", state: "delivered" });
  });

  it("reports unknown, never waiting, when the server cannot say", async () => {
    reply({ status: "unknown", reason: "paused" });
    expect((await getDelivery("ab")).status).toBe("unknown");
    reply({}, 502);
    expect((await getDelivery("ab")).status).toBe("unknown");
    reply({ status: "known" }); // known without a state is not an answer
    expect((await getDelivery("ab")).status).toBe("unknown");
  });

  it("does not throw when the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    expect((await getDelivery("ab")).status).toBe("unknown");
  });
});

describe("getCircleHealth", () => {
  it("returns the server's verdict", async () => {
    reply({ status: "down", reasons: ["x"], quote: null });
    expect((await getCircleHealth("solana", false))?.status).toBe("down");
  });

  it("asks for the account-creation quote only when told to", async () => {
    const f = vi.fn(async () => Response.json({ status: "ok", reasons: [] }));
    vi.stubGlobal("fetch", f);
    await getCircleHealth("solana", true);
    await getCircleHealth("arc", false);
    expect(f.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual([
      "/api/circle-health?dest=solana&newAccount=1",
      "/api/circle-health?dest=arc",
    ]);
  });

  it("returns null, not down, when the check itself cannot run", async () => {
    reply({}, 500);
    expect(await getCircleHealth("arc", false)).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    expect(await getCircleHealth("arc", false)).toBeNull();
    reply({ status: "banana" });
    expect(await getCircleHealth("arc", false)).toBeNull();
  });
});

describe("naming the source of a burn", () => {
  const spy = () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ status: "known", state: "waiting", forwardTxHash: null, reason: null }),
    );
    vi.stubGlobal("fetch", f);
    return f;
  };

  it("sends a bare hash for a Stellar burn, exactly as before", async () => {
    const f = spy();
    await getDelivery("ab");
    expect(f.mock.calls[0]?.[0]).toBe("/api/delivery?tx=ab");
  });

  it("names the chain for an EVM burn, zero included", async () => {
    const f = spy();
    await getDelivery("0xab", 6);
    expect(f.mock.calls[0]?.[0]).toBe("/api/delivery?tx=0xab&src=6");
    await getDelivery("0xab", 0);
    expect(f.mock.calls[1]?.[0]).toBe("/api/delivery?tx=0xab&src=0");
  });
});

describe("getRouteHealth", () => {
  it("asks by the two domains and returns the verdict", async () => {
    const f = vi.fn(async (_url: string) => Response.json({ status: "ok", reasons: [] }));
    vi.stubGlobal("fetch", f);
    expect((await getRouteHealth(6, 26))?.status).toBe("ok");
    expect(f.mock.calls[0]?.[0]).toBe("/api/circle-health?src=6&dst=26");
    await getRouteHealth(26, 5, true);
    expect(f.mock.calls[1]?.[0]).toBe("/api/circle-health?src=26&dst=5&newAccount=1");
  });

  it("is null, not down, when the check itself could not run", async () => {
    reply({}, 500);
    expect(await getRouteHealth(6, 26)).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    expect(await getRouteHealth(6, 26)).toBeNull();
  });
});

describe("requestReattest", () => {
  it("posts the nonce and reports that it was asked", async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ status: "requested" }),
    );
    vi.stubGlobal("fetch", f);
    expect(await requestReattest("0xabc")).toEqual({ ok: true });
    expect(f.mock.calls[0]?.[0]).toBe("/api/reattest");
    expect(f.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ nonce: "0xabc" }));
  });

  it("gives the reason when Circle says no, and never throws", async () => {
    reply({ status: "failed", reason: "nonce not found" }, 404);
    expect(await requestReattest("0xabc")).toEqual({ ok: false, reason: "nonce not found" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    expect((await requestReattest("0xabc")).ok).toBe(false);
  });
});
