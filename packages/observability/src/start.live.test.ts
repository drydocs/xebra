import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { registerPolledGauge } from "./gauge.js";
import { type Observability, startObservability } from "./start.js";

/**
 * Verifies the real export path end-to-end against a genuine local HTTP server standing in for
 * Grafana Cloud's OTLP gateway — no Grafana credentials exist in this environment, but the SDK
 * wiring (exporter construction, URL building, the periodic export loop actually firing an HTTP
 * request) is fully verifiable without them, and that's what would silently break if any of the
 * package-version API surface in start.ts (resourceFromAttributes, metricReaders, exporter
 * config) drifted.
 */
describe("startObservability — live OTLP export", () => {
  let server: http.Server | undefined;
  let obs: Observability | undefined;

  afterEach(async () => {
    await obs?.shutdown();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it("actually POSTs metrics to the configured OTLP endpoint", async () => {
    const receivedPaths: string[] = [];
    const receivedMetrics = new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        receivedPaths.push(req.url ?? "");
        res.writeHead(200).end();
        if (req.url === "/v1/metrics") resolve();
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));

    const address = server?.address();
    if (!address || typeof address === "string") {
      throw new Error("expected the test server to bind to a network address");
    }

    obs = startObservability({
      serviceName: "observability-live-test",
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
        OTEL_METRIC_EXPORT_INTERVAL_MS: "100",
      },
    });

    registerPolledGauge(obs.meter, "test_gauge", { description: "test gauge" }, () => 42);

    await Promise.race([
      receivedMetrics,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for a real OTLP export POST")), 5000),
      ),
    ]);

    expect(receivedPaths).toContain("/v1/metrics");
  });
});
