"use client";

/**
 * Sign-out companion — Prompt 30 §79/§84/§88.
 *
 * NextAuth's client signOut clears the cookie but cannot revoke the
 * server-side UserSession registry row. This helper fires a BEST-EFFORT
 * revoke-current request first (so a stolen cookie copy cannot be
 * resurrected) and then signs out regardless of the outcome.
 */
export async function signOutWithRevoke(callbackUrl: string = "/") {
  const { signOut } = await import("next-auth/react");
  try {
    await fetch("/api/v1/me/security/sessions/revoke-current", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    // Best-effort: sign-out must always proceed.
  }
  await signOut({ callbackUrl });
}

/** redirect:false variant for flows that manage the transition themselves. */
export async function signOutWithRevokeNoRedirect() {
  const { signOut } = await import("next-auth/react");
  try {
    await fetch("/api/v1/me/security/sessions/revoke-current", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    // Best-effort.
  }
  await signOut({ redirect: false });
}
