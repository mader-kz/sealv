import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind class combinator every shadcn component imports. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
