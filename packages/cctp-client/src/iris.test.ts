import { describe, expect, it, vi } from "vitest";
import { IrisApiError, createIrisClient } from "./iris.js";

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("createIrisClient", () => {
  it("parses messages from a successful response", async () => {
    const fetchImpl = mockFetch(200, {
      messages: [{ message: "0xdead", attestation: "0xbeef", eventNonce: "1", status: "complete" }],
    });
    const client = createIrisClient("https://iris.example", fetchImpl);

    const messages = await client.getMessages(2, "abc123");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.status).toBe("complete");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://iris.example/v2/messages/2?transactionHash=abc123",
    );
  });

  it("returns an empty array when the message hasn't been indexed yet", async () => {
    const fetchImpl = mockFetch(200, { messages: [] });
    const client = createIrisClient("https://iris.example", fetchImpl);
    expect(await client.getMessages(2, "abc123")).toEqual([]);
  });

  it("throws IrisApiError on a non-2xx response", async () => {
    const fetchImpl = mockFetch(404, "not found");
    const client = createIrisClient("https://iris.example", fetchImpl);
    await expect(client.getMessages(2, "abc123")).rejects.toBeInstanceOf(IrisApiError);
  });
});
