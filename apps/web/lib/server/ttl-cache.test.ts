import { describe, expect, it, vi } from "vitest";
import { createTtlCache } from "./ttl-cache";

describe("createTtlCache", () => {
  it("answers from cache within the ttl and reloads after it", async () => {
    let t = 0;
    const get = createTtlCache<number>(1000, () => t);
    const load = vi.fn(async () => t);
    expect(await get("k", load)).toBe(0);
    t = 999;
    expect(await get("k", load)).toBe(0);
    expect(load).toHaveBeenCalledTimes(1);
    t = 1000;
    expect(await get("k", load)).toBe(1000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight call between concurrent askers", async () => {
    const get = createTtlCache<string>(1000);
    let release: (v: string) => void = () => undefined;
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const all = Promise.all([get("k", load), get("k", load), get("k", load)]);
    release("x");
    expect(await all).toEqual(["x", "x", "x"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure", async () => {
    const get = createTtlCache<string>(1000);
    const load = vi.fn().mockRejectedValueOnce(new Error("no")).mockResolvedValueOnce("yes");
    await expect(get("k", load)).rejects.toThrow("no");
    expect(await get("k", load)).toBe("yes");
  });

  it("keeps keys apart and stays bounded", async () => {
    const get = createTtlCache<string>(1000, Date.now, 2);
    const a = vi.fn(async () => "a");
    await get("a", a);
    await get("b", async () => "b");
    await get("c", async () => "c"); // evicts "a"
    await get("a", a);
    expect(a).toHaveBeenCalledTimes(2);
  });
});
