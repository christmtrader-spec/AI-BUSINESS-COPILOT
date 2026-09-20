/**
 * NextAuth configuration — Constitution A14.
 * Credentials provider + JWT session strategy (SPA-friendly).
 * Session carries userId; the ACTIVE business is NOT a trusted session
 * claim — every API request re-verifies membership server-side (tenant.ts).
 */
import type { NextAuthOptions } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { findUserForSignIn } from "@/lib/auth-security";

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

/**
 * Session-version policy (Prompt 18 §16): the JWT is stamped with `sv` —
 * the User.sessionVersion at sign-in time. Password change/reset increments
 * the stored version; every older JWT then fails the freshness check in
 * getAuthContext (business APIs) and assertFreshSession (account APIs).
 * JWTs issued before this feature carry no `sv` and are treated as 0 —
 * matching every existing user's default, so nobody is logged out.
 */

export const authOptions: NextAuthOptions = {
  // STABLE secret is mandatory: without it next-auth v4 derives an ad-hoc
  // dev key per route-module instance / restart, and session JWTs issued
  // by one instance can never be decrypted by another (JWEDecryptionFailed
  // → random 401s). Production still fails fast (NO_SECRET throw) if the
  // env var is missing; the literal fallback is dev-only convenience.
  secret:
    process.env.NEXTAUTH_SECRET ??
    (process.env.NODE_ENV !== "production"
      ? "ai-business-copilot-dev-secret-stable"
      : undefined),
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  },
  pages: {
    signIn: "/", // SPA handles sign-in view at root
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        const parsed = credentialsSchema.safeParse(credentials ?? {});
        if (!parsed.success) return null;

        const { email, password } = parsed.data;

        // Brute-force guard per email+ip (A14). authorize() runs on the server.
        const { rateLimit } = await import("@/lib/rate-limit");
        const ip =
          (req as { headers?: Record<string, string> } | null)?.headers?.[
            "x-forwarded-for"
          ] ?? "unknown";
        const rl = rateLimit(`login:${email}:${ip}`, 10, 5 * 60 * 1000);
        if (!rl.allowed) return null;

        const user = await findUserForSignIn(email);
        if (!user) return null;

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return null;

        // sessionVersion rides along so the jwt callback can stamp it.
        return { id: user.id, email: user.email, name: user.name, sessionVersion: user.sessionVersion };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.sv = (user as { sessionVersion?: number }).sessionVersion ?? 0;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      // Exposed to server helpers via getServerSession; harmless client-side.
      session.user.sessionVersion = typeof token.sv === "number" ? token.sv : 0;
      return session;
    },
  },
};
