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

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
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

        const user = await db.user.findUnique({ where: { email } });
        if (!user) return null;

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
};
