import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

const handler = NextAuth(authOptions);

/**
 * R65 hardening (Prompt 65 §15 — production error handling): next-auth v4's
 * getBody() throws an unhandled SyntaxError when a client posts the
 * credentials callback with a JSON content-type (it only parses
 * form-urlencoded). The browser client and every sanctioned integration send
 * form-urlencoded, so this is never hit in normal flows — but an attacker or
 * a buggy client must receive a CLEAN 400, not a 500 with a stack trace.
 * NextAuth's own controlled errors (e.g. the MFA_REQUIRED redirect) are
 * handled INSIDE the handler and never reach this catch. The route context
 * is forwarded untouched — next-auth derives req.query.nextauth from
 * ctx.params and must keep receiving it.
 */
export { handler as GET };

type NextAuthContext = { params: Promise<Record<string, string | string[]>> };

const POST = async (req: Request, ctx: NextAuthContext) => {
  try {
    return await handler(req, ctx);
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: { code: "INVALID_REQUEST", message: "Invalid sign-in request." } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
};

export { POST };
