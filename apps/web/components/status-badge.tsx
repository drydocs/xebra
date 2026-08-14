const STATUS_STYLES: Record<string, string> = {
  open: "bg-blue-500/20 text-blue-300",
  claimed: "bg-amber-500/20 text-amber-300",
  challenged: "bg-red-500/20 text-red-300",
  finalized: "bg-emerald-500/20 text-emerald-300",
  refunded: "bg-slate-500/20 text-slate-300",
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? "bg-slate-500/20 text-slate-300";
  return (
    <span
      className={`inline-block rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wide ${style}`}
    >
      {status}
    </span>
  );
}
