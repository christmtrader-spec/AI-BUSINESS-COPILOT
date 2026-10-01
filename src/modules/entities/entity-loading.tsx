"use client";

/**
 * Prompt 34 — loading skeleton (§79): header + metric strip + related
 * records, consistent with the app's skeleton language. Never a blank
 * screen while a detail is fetching.
 */

import { Skeleton } from "@/components/ui/skeleton";

export function EntityLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-live="polite">
      {/* Header skeleton */}
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-28 rounded-md" />
        <div className="flex items-center gap-3">
          <Skeleton className="size-11 rounded-lg" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
      </div>
      {/* Metric strip skeleton */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-6 w-24" />
          </div>
        ))}
      </div>
      {/* Related-record skeleton */}
      <div className="rounded-xl border">
        <div className="border-b px-4 py-3">
          <Skeleton className="h-4 w-36" />
        </div>
        <div className="flex flex-col gap-3 p-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-8 rounded-md" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
