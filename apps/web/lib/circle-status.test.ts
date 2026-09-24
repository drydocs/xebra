import { afterEach, describe, expect, it, vi } from "vitest";
import { getCircleHealth, getDelivery } from "./circle-status";

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
