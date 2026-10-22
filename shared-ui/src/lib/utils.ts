import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// Keep semantic type utilities in the font-size group, separate from text colors.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["meta", "caption", "body", "card", "section", "detail", "page", "number"],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
