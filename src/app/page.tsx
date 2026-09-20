'use client'

import { Providers } from "@/components/providers";
import { AppRoot } from "@/modules/shell/app-root";

export default function Home() {
  return (
    <Providers>
      <AppRoot />
    </Providers>
  )
}
