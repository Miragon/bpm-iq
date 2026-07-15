import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** merge conditional + conflicting Tailwind classes (shadcn convention) */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
