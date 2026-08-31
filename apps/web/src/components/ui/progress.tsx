import { cn } from "@/lib/utils";

export function Progress({ value, className }: { value: number; className?: string }) {
  const safe = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("relative h-2.5 w-full overflow-hidden rounded-full bg-muted", className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={safe}>
      {safe > 0 ? <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${safe}%` }} /> : <div className="h-full w-1/3 animate-shimmer rounded-full bg-primary/70" />}
    </div>
  );
}
