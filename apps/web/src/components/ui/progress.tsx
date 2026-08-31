import { cn } from "@/lib/utils";

export function Progress({ value, className }: { value: number; className?: string }) {
  return <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} className={cn("relative h-2.5 overflow-hidden rounded-full bg-muted", className)}>
    {value > 0 ? <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${value}%` }} /> : <div className="h-full w-1/3 animate-shimmer rounded-full bg-primary/70" />}
  </div>;
}
