/**
 * Next.js's instrumentation hook (stable since Next 15, no experimental flag needed) — the one
 * place server startup code can run before any route handler. `@xebra/observability`'s
 * `startObservability` is Node-SDK-based (NodeSDK, OTLP/HTTP exporters), so it's only invoked
 * under the nodejs runtime; the edge runtime, which only the admin gate (`middleware.ts`) runs
 * in, has no equivalent here.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startObservability } = await import("@xebra/observability");
    startObservability({ serviceName: "web" });
  }
}
