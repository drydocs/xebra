import { afterEach, describe, expect, it, vi } from "vitest";
import { handOffToRelay } from "./relay.js";

const HASH = "92421fa248da1b1d4418784d5bd91adc4238dae72120e8f740920db7381905a7";

function mockFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => vi.unstubAllGlobals());

describe("handOffToRelay", () => {
  it("reports a queued mint", async () => {
    mockFetch(() => Response.json({ status: "queued", jobId: "job-1" }));
    expect(await handOffToRelay(HASH)).toEqual({ status: "queued", jobId: "job-1" });
  });

  it("reports the reason when no relay is configured", async () => {
    mockFetch(() =>
      Response.json({ status: "unavailable", reason: "no relay is configured" }, { status: 503 }),
    );
    expect(await handOffToRelay(HASH)).toEqual({
      status: "unavailable",
      reason: "no relay is configured",
    });
  });

  it("never throws when the network fails", async () => {
    // The burn is already on chain. An exception here would be shown as a failed transfer for
    // one that actually succeeded.
    mockFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await handOffToRelay(HASH)).toEqual({
      status: "unavailable",
      reason: "Failed to fetch",
    });
  });

  it("never throws when the response is not JSON", async () => {
    mockFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    const result = await handOffToRelay(HASH);
    expect(result.status).toBe("unavailable");
  });
});
