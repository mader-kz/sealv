import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm transition-colors disabled:pointer-events-none disabled:border-hair disabled:text-ink4 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-accent text-accent hover:bg-accent hover:text-accent-ink",
        destructive:
          "border border-bad text-bad hover:bg-bad hover:text-bg",
        outline:
          "border border-line text-ink2 hover:bg-surface2 hover:text-ink hover:border-ink4",
        secondary:
          "border border-line text-ink2 hover:bg-surface2 hover:text-ink",
        ghost: "text-ink3 hover:bg-surface2 hover:text-ink",
        link: "text-ink2 underline-offset-4 hover:text-ink hover:underline",
      },
      size: {
        default: "h-7 px-3",
        sm: "h-6 px-2.5 text-xs",
        lg: "h-8 px-5",
        icon: "h-7 w-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
