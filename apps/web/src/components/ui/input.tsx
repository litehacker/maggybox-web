import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn("flex h-12 w-full rounded-lg border bg-white px-4 text-base shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50", className)} {...props} />
));
Input.displayName = "Input";
