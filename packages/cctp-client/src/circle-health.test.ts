import { describe, expect, it } from "vitest";
import {
  type CheckDeps,
  MAX_SANE_FORWARD_FEE_UNITS,
  checkCircle,
  parseForwardQuote,
} from "./circle-health.js";
import { createBudgetedFetch, createMemoryBudgetStore } from "./iris-budget.js";

const T0 = 1_800_000_000_000;
const GOOD_QUOTE = [
  {
    finalityThreshold: 1000,
    minimumFee: 0,
    forwardFee: { low: 133_000, med: 140_000, high: 162_000 },
  },
  {
    finalityThreshold: 2000,
    minimumFee: 0,
    forwardFee: { low: 133_000, med: 140_000, high: 162_000 },
  },
];
const GOOD_KEYS = { publicKeys: [{ publicKey: "0x04aa", cctpVersion: 2 }] };

type Route = () => Response | Promise<Response>;

/** A fake Iris: routes by path, and counts calls. */
function fakeIris(routes: { fees?: Route; keys?: Route }) {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v2/burn/USDC/fees/"))
      return (routes.fees ?? (() => Response.json(GOOD_QUOTE)))();
    if (url.includes("/v2/publicKeys")) return (routes.keys ?? (() => Response.json(GOOD_KEYS)))();
    return new Response("nope", { status: 404 });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

function deps(iris: ReturnType<typeof fakeIris>, over: Partial<CheckDeps> = {}) {
  const store = createMemoryBudgetStore({ limitPerSecond: 30, blockMs: 330_000 });
  return {
    baseUrl: "https://iris.example",
    sourceDomain: 27,
    destDomain: 5,
    fetch: createBudgetedFetch(store, iris.impl, () => T0, 330_000),
    store,
    now: () => T0,
    ...over,
  } satisfies CheckDeps;
}

describe("parseForwardQuote", () => {
  it("reads the Standard tier and returns the three fees", () => {
    expect(parseForwardQuote(GOOD_QUOTE)).toEqual({
      ok: true,
      quote: { low: 133_000, med: 140_000, high: 162_000 },
    });
  });

  it("accepts the spec's `medium` as well as the live API's `med`", () => {
    const body = [{ finalityThreshold: 2000, forwardFee: { low: 1, medium: 2, high: 3 } }];
    expect(parseForwardQuote(body)).toEqual({ ok: true, quote: { low: 1, med: 2, high: 3 } });
  });

  it("refuses a route Circle does not offer forwarding on", () => {
    const body = [{ finalityThreshold: 2000, minimumFee: 0 }];
    const r = parseForwardQuote(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not offering delivery/);
  });

  it("refuses a body without a Standard tier", () => {
    expect(
      parseForwardQuote([{ finalityThreshold: 1000, forwardFee: { low: 1, med: 1, high: 1 } }]).ok,
    ).toBe(false);
  });

  it("refuses non-numbers, zero, negatives and fractions", () => {
    for (const bad of [0, -5, 1.5, "162000", null]) {
      const body = [{ finalityThreshold: 2000, forwardFee: { low: 1, med: 1, high: bad } }];
      expect(parseForwardQuote(body).ok, String(bad)).toBe(false);
    }
  });

  it("refuses an absurd fee rather than sign it", () => {
    const body = [
      {
        finalityThreshold: 2000,
        forwardFee: { low: 1, med: 2, high: MAX_SANE_FORWARD_FEE_UNITS + 1 },
      },
    ];
    const r = parseForwardQuote(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unusually high/);
    // exactly at the ceiling is fine
    expect(
      parseForwardQuote([
        {
          finalityThreshold: 2000,
          forwardFee: { low: 1, med: 2, high: MAX_SANE_FORWARD_FEE_UNITS },
        },
      ]).ok,
    ).toBe(true);
  });

  it("refuses an inconsistent quote and anything that is not an array", () => {
    expect(
      parseForwardQuote([{ finalityThreshold: 2000, forwardFee: { low: 9, med: 5, high: 3 } }]).ok,
    ).toBe(false);
    expect(parseForwardQuote({ error: "x" }).ok).toBe(false);
    expect(parseForwardQuote(null).ok).toBe(false);
  });
});

describe("checkCircle", () => {
  it("is ok, and returns the fee, when both calls are healthy", async () => {
    const h = await checkCircle(deps(fakeIris({})));
    expect(h.status).toBe("ok");
    expect(h.reasons).toEqual([]);
    expect(h.quote).toEqual({ low: 133_000, med: 140_000, high: 162_000 });
  });

  it("asks for the account-creation quote only when told to", async () => {
    const a = fakeIris({});
    await checkCircle(deps(a));
    expect(a.calls.find((u) => u.includes("/fees/"))).not.toContain("includeRecipientSetup");
    const b = fakeIris({});
    await checkCircle(deps(b, { includeRecipientSetup: true }));
    expect(b.calls.find((u) => u.includes("/fees/"))).toContain("includeRecipientSetup=true");
  });

  it("is down when the fee service errors", async () => {
    const h = await checkCircle(
      deps(fakeIris({ fees: () => new Response("boom", { status: 503 }) })),
    );
    expect(h.status).toBe("down");
    expect(h.reasons[0]).toMatch(/fee service is returning errors/);
    expect(h.quote).toBeNull();
  });

  it("is down, saying so plainly, when Circle no longer offers the route", async () => {
    const h = await checkCircle(
      deps(fakeIris({ fees: () => new Response("{}", { status: 400 }) })),
    );
    expect(h.status).toBe("down");
    expect(h.reasons[0]).toMatch(/does not currently offer this route/);
  });

  it("is down when the quote comes back without forwarding", async () => {
    const h = await checkCircle(
      deps(fakeIris({ fees: () => Response.json([{ finalityThreshold: 2000, minimumFee: 0 }]) })),
    );
    expect(h.status).toBe("down");
  });

  it("is down when the attestation keys are missing or empty", async () => {
    expect(
      (await checkCircle(deps(fakeIris({ keys: () => new Response("x", { status: 500 }) }))))
        .status,
    ).toBe("down");
    expect(
      (await checkCircle(deps(fakeIris({ keys: () => Response.json({ publicKeys: [] }) })))).status,
    ).toBe("down");
  });

  it("is down when a call times out, and reports it as a timeout", async () => {
    const never = () => new Promise<Response>(() => {});
    const iris = fakeIris({ fees: never });
    const h = await checkCircle(deps(iris, { timeoutMs: 30 }));
    // this fetch ignores the abort signal, so only the check's own timer can end it
    expect(h.status).toBe("down");
    expect(h.reasons[0]).toMatch(/timed out/);
  }, 5_000);

  it("believes a failure only when it repeats: one cold-start timeout is not an outage", async () => {
    let calls = 0;
    const iris = fakeIris({
      fees: () => {
        calls++;
        return calls === 1
          ? Promise.reject(new Error("socket hang up"))
          : Response.json(GOOD_QUOTE);
      },
    });
    const h = await checkCircle(deps(iris));
    expect(h.status).toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries a 5xx once, and is down when it repeats", async () => {
    let calls = 0;
    const iris = fakeIris({
      fees: () => {
        calls++;
        return new Response("boom", { status: 503 });
      },
    });
    expect((await checkCircle(deps(iris))).status).toBe("down");
    expect(calls).toBe(2);
  });

  it("does not retry an answer that is a real no", async () => {
    let calls = 0;
    const iris = fakeIris({
      fees: () => {
        calls++;
        return new Response("{}", { status: 400 });
      },
    });
    expect((await checkCircle(deps(iris))).status).toBe("down");
    expect(calls).toBe(1);
  });

  it("is degraded, not down, when Circle answers but slowly", async () => {
    let t = T0;
    const iris = fakeIris({
      fees: () => {
        t += 4_000;
        return Response.json(GOOD_QUOTE);
      },
    });
    const h = await checkCircle(deps(iris, { now: () => t, slowMs: 3_000 }));
    expect(h.status).toBe("degraded");
    expect(h.reasons.join(" ")).toMatch(/slowly/);
    expect(h.quote).not.toBeNull();
  });

  it("is degraded when our own budget is nearly used up", async () => {
    const iris = fakeIris({});
    const d = deps(iris);
    for (let i = 0; i < 26; i++) await d.store.acquire(T0);
    const h = await checkCircle({ ...d, budgetWarnAt: 0.75 });
    expect(h.status).toBe("degraded");
    expect(h.reasons.join(" ")).toMatch(/budget/);
  });

  it("treats our rate limit as degraded, never down — Circle can still mint the burn", async () => {
    const iris = fakeIris({});
    const d = deps(iris, {
      store: createMemoryBudgetStore({ limitPerSecond: 30, blockMs: 330_000 }),
    });
    await d.store.markRateLimited(T0);
    const blockedFetch = createBudgetedFetch(d.store, iris.impl, () => T0, 330_000);
    const h = await checkCircle({ ...d, fetch: blockedFetch });
    expect(h.status).toBe("degraded");
    expect(h.status).not.toBe("down");
    expect(iris.calls).toHaveLength(0);
    expect(h.budget.blockedUntil).not.toBeNull();
  });

  it("starts a block when Circle answers 429, and reports degraded", async () => {
    const iris = fakeIris({ fees: () => new Response("slow down", { status: 429 }) });
    const d = deps(iris);
    const h = await checkCircle(d);
    expect(h.status).toBe("degraded");
    expect((await d.store.usage(T0)).blockedUntil).not.toBeNull();
  });

  it("spends only two calls of budget per healthy check", async () => {
    const d = deps(fakeIris({}));
    await checkCircle(d);
    expect((await d.store.usage(T0)).perSecond).toBe(2);
  });
});
