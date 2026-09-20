import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Vazirmatn } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ChunkRecovery } from "@/components/chunk-recovery";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Persian-first typeface (Vazirmatn variable) — applied when the workspace
// language is FA via `html[lang="fa"] body` in globals.css. English keeps Geist.
const vazirmatn = Vazirmatn({
  variable: "--font-vazir",
  subsets: ["arabic", "latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "AI Business Copilot",
  description:
    "Multi-tenant business management with an AI copilot that answers from your real numbers — never invented ones.",
  keywords: ["business", "copilot", "AI", "invoicing", "expenses", "SaaS"],
  authors: [{ name: "AI Business Copilot" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "AI Business Copilot",
    description: "Your business, understood.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${vazirmatn.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <ChunkRecovery />
        <Toaster />
      </body>
    </html>
  );
}
