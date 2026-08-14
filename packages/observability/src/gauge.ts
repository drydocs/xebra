import type { Meter, MetricOptions, ObservableGauge } from "@opentelemetry/api";

/**
 * Registers a gauge whose value is computed on each export cycle rather than pushed eagerly —
 * the idiomatic OTel pattern for "check a balance/queue depth periodically" signals like the
 * day-one alerts in docs/architecture.md §11. A poll that throws is swallowed and simply skips
 * that cycle's observation (no logger dependency in this package) — the next export interval
 * tries again, rather than one bad poll killing metric export for the whole process.
 */
export function registerPolledGauge(
  meter: Meter,
  name: string,
  options: MetricOptions,
  poll: () => Promise<number> | number,
  attributes: Record<string, string> = {},
): ObservableGauge {
  const gauge = meter.createObservableGauge(name, options);
  gauge.addCallback(async (result) => {
    try {
      const value = await poll();
      result.observe(value, attributes);
    } catch {
      // skip this cycle
    }
  });
  return gauge;
}
