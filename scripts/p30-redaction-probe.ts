import "server-only";
import { logDebug } from "../src/lib/observability/logger";

/**
 * Redaction probe for the Prompt 30 logger extensions (§207). Emits one
 * structured log line carrying lookalike-secret keys; the harness asserts
 * the EMITTED line (captured from stdout by the caller) redacts every one
 * of them while leaving safe fields intact.
 *
 * The `server-only` import mirrors real service modules — the p29-preload
 * stub satisfies it in out-of-process runs.
 */

const sensitive = {
  otp: "123456",
  mfaCode: "654321",
  mfa: "totp-secret-shape",
  recoveryCode: "ABCD-2345-6789-JKLM",
  recoveryCodes: ["ABCD-2345-6789-JKLM"],
  mfaAssertion: "assertion-value-should-vanish",
  challenge: "challenge-value-should-vanish",
  encryptedSecret: "v1.iv.tag.payload",
  verificationToken: "verification-token-value",
};

const safe = {
  requestId: "probe-123",
  userId: "user-1",
  route: "/probe",
  success: true,
};

export const REDACTION_PROBE: { allRedacted: boolean; safeFieldsSurvive: boolean; leakedKeys?: string[] } = (() => {
  let captured = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: (chunk: string | Uint8Array) => boolean }).write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    logDebug("probe.redaction", { ...sensitive, ...safe });
  } finally {
    (process.stdout as { write: (chunk: string | Uint8Array) => boolean }).write = originalWrite;
  }
  const line = captured.split("\n").find((l) => l.includes("probe.redaction")) ?? "";
  const sensitiveKeys = Object.keys(sensitive);
  const leakedKeys = sensitiveKeys.filter((k) => new RegExp(`"${k}":"?[^"]*${k === "recoveryCodes" ? "." : "."}`).test(line) && !line.includes(`"${k}":"[REDACTED]"`));
  return {
    allRedacted: sensitiveKeys.every((k) => line.includes(`"${k}":"[REDACTED]"`)),
    safeFieldsSurvive: line.includes('"requestId":"probe-123"') && line.includes('"success":true'),
    leakedKeys: leakedKeys.length > 0 ? leakedKeys : undefined,
  };
})();

void logDebug;
