import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      /** Session-version stamp (Prompt 18) — compared against User.sessionVersion. */
      sessionVersion: number;
    } & DefaultSession["user"];
  }

  interface User {
    /** Fetched in authorize() so the jwt callback can stamp `sv`. */
    sessionVersion?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    sub?: string;
    /** Session version at issue time — see src/lib/auth-security.ts. */
    sv?: number;
  }
}
