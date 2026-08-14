import { type Meter, type Tracer, metrics, trace } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { loadObservabilityConfig, parseOtlpHeaders } from "./config.js";

export interface Observability {
  tracer: Tracer;
  meter: Meter;
  shutdown: () => Promise<void>;
}

/**
 * Wires traces + metrics to an OTLP/HTTP endpoint — Grafana Cloud in staging/production, a local
 * collector in dev (docs/architecture.md §11). No auto-instrumentation: every service already
 * logs structured events via pino, so the value here is the five day-one alert signals (relay
 * SOL balance, solver inventory, unclaimed-intent window, CCTP attestation age, arbiter KMS
 * failures — see each service's own use of `registerPolledGauge`/`meter`) plus manually-created
 * spans where they earn their cost, not blanket HTTP/DB instrumentation nobody asked for.
 */
export function startObservability(opts: {
  serviceName: string;
  serviceVersion?: string;
  env?: NodeJS.ProcessEnv;
}): Observability {
  const config = loadObservabilityConfig(opts.env);
  const headers = parseOtlpHeaders(config.OTEL_EXPORTER_OTLP_HEADERS);

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? "0.0.0",
    "deployment.environment": config.ENVIRONMENT,
  });

  const traceExporter = new OTLPTraceExporter({
    url: `${config.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
    headers,
  });
  const metricExporter = new OTLPMetricExporter({
    url: `${config.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`,
    headers,
  });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: config.OTEL_METRIC_EXPORT_INTERVAL_MS,
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReaders: [metricReader],
  });
  sdk.start();

  return {
    tracer: trace.getTracer(opts.serviceName),
    meter: metrics.getMeter(opts.serviceName),
    shutdown: () => sdk.shutdown(),
  };
}
