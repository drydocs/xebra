import { z } from "zod";

const ConfigSchema = z.object({
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default("http://localhost:4318"),
  /** "key1=value1,key2=value2" per the OTel spec's env-var header format. */
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
  ENVIRONMENT: z.string().default("development"),
  OTEL_METRIC_EXPORT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
});

export type ObservabilityConfig = z.infer<typeof ConfigSchema>;

export function loadObservabilityConfig(env: NodeJS.ProcessEnv = process.env): ObservabilityConfig {
  return ConfigSchema.parse(env);
}

/**
 * Parses OTEL_EXPORTER_OTLP_HEADERS's "k1=v1,k2=v2" format — this is how Grafana Cloud's
 * Basic-auth OTLP gateway token gets attached (Authorization=Basic <base64(instanceId:token)>,
 * base64-encoded by whoever sets the env var, not by this package).
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [key, ...rest] = pair.split("=");
    if (!key || rest.length === 0) continue;
    headers[key.trim()] = rest.join("=").trim();
  }
  return headers;
}
