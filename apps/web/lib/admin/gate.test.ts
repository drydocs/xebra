import { describe, expect, it } from "vitest";
import { basicPassword, decideGate, safeEqual } from "./gate";

const PW = "correct-horse-battery-staple";
const basic = (pw: string, user = "admin") => `Basic ${btoa(`${user}:${pw}`)}`;
const base = { password: PW, allowedIps: undefined, authorization: null, clientIp: "1.2.3.4" };

describe("safeEqual", () => {
  it("compares whole strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("basicPassword", () => {
  it("extracts the password and ignores the user", () => {
    expect(basicPassword(basic(PW, "anyone"))).toBe(PW);
  });
  it("keeps colons inside the password", () => {
    expect(basicPassword(basic("a:b:c"))).toBe("a:b:c");
  });
  it("rejects other schemes and junk", () => {
    expect(basicPassword(null)).toBeNull();
    expect(basicPassword("Bearer x")).toBeNull();
    expect(basicPassword("Basic !!!not-base64")).toBeNull();
  });
});

describe("decideGate", () => {
  it("does not exist without a password", () => {
    expect(decideGate({ ...base, password: undefined })).toEqual({
      allow: false,
      status: 404,
      challenge: false,
    });
  });
  it("does not exist with a weak password", () => {
    expect(decideGate({ ...base, password: "short", authorization: basic("short") }).allow).toBe(
      false,
    );
  });
  it("challenges when no credentials are given", () => {
    expect(decideGate(base)).toEqual({ allow: false, status: 401, challenge: true });
  });
  it("refuses a wrong password", () => {
    expect(decideGate({ ...base, authorization: basic("nope") }).allow).toBe(false);
  });
  it("lets the right password in", () => {
    expect(decideGate({ ...base, authorization: basic(PW) })).toEqual({ allow: true });
  });
  it("enforces an IP allowlist before the password", () => {
    const withIps = { ...base, allowedIps: "9.9.9.9, 8.8.8.8", authorization: basic(PW) };
    expect(decideGate(withIps)).toEqual({ allow: false, status: 403, challenge: false });
    expect(decideGate({ ...withIps, clientIp: "8.8.8.8" })).toEqual({ allow: true });
    expect(decideGate({ ...withIps, clientIp: null }).allow).toBe(false);
  });
});
