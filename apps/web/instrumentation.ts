/**
 * Next.js's instrumentation hook (stable since Next 15, no experimental flag needed) — the one
 * place server startup code can run before any route handler. `@xebra/observability`'s
 * `startObservability` is Node-SDK-based (NodeSDK, OTLP/HTTP exporters), so it's only invoked
 * under the nodejs runtime; the edge runtime has no equivalent here and isn't used by this app.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startObservability } = await import("@xebra/observability");
    startObservability({ serviceName: "web" });
  }
}
