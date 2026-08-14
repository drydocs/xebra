import { describe, expect, it } from "vitest";
import { loadObservabilityConfig, parseOtlpHeaders } from "./config.js";

describe("parseOtlpHeaders", () => {
  it("returns an empty object for undefined", () => {
    expect(parseOtlpHeaders(undefined)).toEqual({});
  });

  it("parses a single key=value pair", () => {
    expect(parseOtlpHeaders("Authorization=Basic abc123")).toEqual({
      Authorization: "Basic abc123",
    });
  });

  it("parses multiple comma-separated pairs", () => {
    expect(parseOtlpHeaders("a=1,b=2")).toEqual({ a: "1", b: "2" });
  });

  it("preserves '=' characters inside the value (e.g. base64 padding)", () => {
    expect(parseOtlpHeaders("Authorization=Basic dXNlcjpwYXNz==")).toEqual({
      Authorization: "Basic dXNlcjpwYXNz==",
    });
  });

  it("skips malformed pairs with no '='", () => {
    expect(parseOtlpHeaders("a=1,garbage,b=2")).toEqual({ a: "1", b: "2" });
  });
});

describe("loadObservabilityConfig", () => {
  it("applies documented defaults when nothing is set", () => {
    const config = loadObservabilityConfig({});
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://localhost:4318");
    expect(config.ENVIRONMENT).toBe("development");
    expect(config.OTEL_METRIC_EXPORT_INTERVAL_MS).toBe(15_000);
  });

  it("reads real env overrides", () => {
    const config = loadObservabilityConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp-gateway-prod.grafana.net/otlp",
      ENVIRONMENT: "production",
      OTEL_METRIC_EXPORT_INTERVAL_MS: "5000",
    });
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://otlp-gateway-prod.grafana.net/otlp");
    expect(config.ENVIRONMENT).toBe("production");
    expect(config.OTEL_METRIC_EXPORT_INTERVAL_MS).toBe(5000);
  });

  it("rejects a non-URL endpoint", () => {
    expect(() => loadObservabilityConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url" })).toThrow();
  });
});
