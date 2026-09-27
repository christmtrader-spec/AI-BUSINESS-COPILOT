/**
 * /pricing — PUBLIC pricing page — Prompt 25.
 *
 * SEO-ready server metadata; the interactive view is the client root that
 * shares the app's locale/theme infrastructure. No authentication required.
 */
import type { Metadata } from "next";
import { PricingRoot } from "@/components/public/pricing-root";

export const metadata: Metadata = {
  title: "Pricing — AI Business Copilot",
  description:
    "Simple, honest plans for your business: customers, sales, expenses and an AI copilot that answers from your real numbers. Start free.",
  keywords: ["pricing", "plans", "business", "AI copilot", "SaaS", "invoicing"],
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing — AI Business Copilot",
    description:
      "Simple, honest plans with an AI copilot that answers from your real numbers. Start free.",
    type: "website",
  },
  robots: { index: true, follow: true },
};

export default function PricingPage() {
  return <PricingRoot />;
}
