"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

/**
 * Modern brand switch (r52 restyle — presentation only, API unchanged).
 *
 * Fixes over the old gray-pill look:
 * - CHECKED  → emerald→teal gradient track + soft brand glow, so an enabled
 *              option is unmistakable at a glance (and in screenshots).
 * - UNCHECKED→ clearly "off": muted track + visible border, never mistaken
 *              for checked.
 * - DISABLED + CHECKED ("locked on", e.g. mandatory channels) keeps the
 *              gradient at a slightly softened opacity — it must still read
 *              as ON; the surrounding UI adds the lock badge/label.
 * - DISABLED + UNCHECKED is extra muted so the two disabled states differ.
 * - RTL-correct: the thumb is positioned with logical inset (start-*) and
 *   animates inset-inline-start, so it sits at the inline start when off
 *   and slides to the inline end when on — mirrored automatically in FA.
 * - Larger geometry (h-5 / w-9, size-4 thumb) with a ≥44px effective touch
 *   target via the wrapping label in call sites.
 */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-5 w-9 shrink-0 rounded-full border border-transparent outline-none transition-colors",
        "focus-visible:border-ring focus-visible:ring-ring/45 focus-visible:ring-[3px]",
        // Unchecked: clearly off.
        "data-[state=unchecked]:bg-input data-[state=unchecked]:border-border/70 dark:data-[state=unchecked]:bg-input/70",
        // Checked: brand gradient + glow.
        "data-[state=checked]:bg-gradient-to-r data-[state=checked]:from-emerald-600 data-[state=checked]:to-teal-500 data-[state=checked]:shadow-[0_0_10px_-2px] data-[state=checked]:shadow-emerald-500/50",
        "dark:data-[state=checked]:from-emerald-500 dark:data-[state=checked]:to-teal-400",
        // Disabled: locked-on stays readable, off fades further.
        "disabled:cursor-not-allowed disabled:data-[state=checked]:opacity-80 disabled:data-[state=unchecked]:opacity-45",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "bg-background pointer-events-none absolute top-1/2 block size-4 -translate-y-1/2 rounded-full shadow-sm ring-0",
          "start-[2px] transition-[inset-inline-start] duration-200 ease-out",
          "data-[state=checked]:start-[calc(100%-1.125rem)]",
          "dark:data-[state=unchecked]:bg-muted-foreground/70 dark:data-[state=checked]:bg-white"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
