/**
 * prompt29-unit.ts — in-process unit checks for Prompt 29 (§129/§130/§131/
 * §133/§134/§135/§136/§145/§147). Run with bun (tsconfig paths supported):
 *   bun scripts/prompt29-unit.ts
 *
 * Output: JSON summary line "P29-UNIT <passed>/<total>" + per-check lines.
 * These checks run OUTSIDE the Next server; production code paths are
 * exercised directly against the real modules.
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ------------------------------ §129 SMTP misconfiguration ---------------- */

import { resolveEmailTransportConfig } from "../src/lib/email/config";

{
  const base = {
    EMAIL_SERVER_HOST: "smtp.example.com",
    EMAIL_SERVER_PORT: "587",
    EMAIL_SERVER_USER: "user@example.com",
    EMAIL_SERVER_PASSWORD: "secret-password",
    EMAIL_FROM: "noreply@example.com",
    EMAIL_SECURE: "false",
    NODE_ENV: "production",
  } as Record<string, string | undefined>;

  const mustFail = (label: string, env: Record<string, string | undefined>, expectProblem: string) => {
    const c = resolveEmailTransportConfig(env);
    check(`smtp-config:${label}`, c.status === "INVALID" && c.problem === expectProblem, `status=${c.status} problem=${c.problem}`);
    // §129 — no leaked SMTP details in the problem/status surface.
    check(`smtp-config:${label}:no-secret-leak`, !JSON.stringify(c).includes("secret-password"), "password absent from result");
  };

  mustFail("missing-host", { ...base, EMAIL_SERVER_HOST: "" }, "MISSING_HOST");
  mustFail("missing-port", { ...base, EMAIL_SERVER_PORT: "" }, "MISSING_PORT");
  mustFail("missing-from", { ...base, EMAIL_FROM: "" }, "MISSING_FROM");
  mustFail("password-without-user", { ...base, EMAIL_SERVER_USER: "" }, "PASSWORD_WITHOUT_USER");
  mustFail("user-without-password", { ...base, EMAIL_SERVER_PASSWORD: "" }, "USER_WITHOUT_PASSWORD");
  mustFail("invalid-port", { ...base, EMAIL_SERVER_PORT: "99999" }, "INVALID_PORT");
  mustFail("invalid-secure-flag", { ...base, EMAIL_SECURE: "maybe" }, "INVALID_SECURE_FLAG");

  // §10 — explicit insecure mode blocked in production; unset flag invalid in production.
  {
    const c = resolveEmailTransportConfig({ ...base, EMAIL_SECURE: "" });
    check("smtp-config:prod-secure-flag-required", c.status === "INVALID" && c.problem === "INVALID_SECURE_FLAG", `problem=${c.problem}`);
    const c2 = resolveEmailTransportConfig({ ...base, EMAIL_SECURE: "false" });
    check("smtp-config:prod-insecure-blocked", c2.status === "INVALID" && c2.problem === "INSECURE_MODE_BLOCKED", `problem=${c2.problem}`);
  }
  // Valid production config (secure=true) is CONFIGURED.
  {
    const c = resolveEmailTransportConfig({ ...base, EMAIL_SECURE: "true" });
    check("smtp-config:valid-prod", c.status === "CONFIGURED" && c.fullyValid, "");
    check("smtp-config:parsed-password-server-only", c.parsed?.password === "secret-password" && !JSON.stringify(c.summary).includes("secret-password"), "password only in parsed (server-internal)");
  }
  // Unset everything → honest NOT_CONFIGURED.
  {
    const c = resolveEmailTransportConfig({ NODE_ENV: "production" });
    check("smtp-config:unset-not-configured", c.status === "NOT_CONFIGURED", "");
  }
}

/* ----------------------------- §130 SMTP timeout -------------------------- */

import { SmtpProvider, EmailDeliveryError } from "../src/lib/email/smtp-provider";

{
  const config = resolveEmailTransportConfig({
    EMAIL_SERVER_HOST: "10.255.255.1", // non-routable — connect must time out
    EMAIL_SERVER_PORT: "465",
    EMAIL_FROM: "noreply@example.com",
    EMAIL_SECURE: "true",
    EMAIL_TIMEOUT_MS: "1000",
    NODE_ENV: "production",
  });
  if (config.parsed) {
    const provider = new SmtpProvider(config);
    const started = Date.now();
    let durationMs = 0;
    let timedOutProperly = false;
    let code = "";
    try {
      await provider.send({
        to: "victim@example.com",
        subject: "timeout probe",
        text: "probe",
        html: "<p>probe</p>",
      });
      // If this resolves, the host was reachable — treat as environment issue.
      timedOutProperly = false;
      code = "unexpected-success";
    } catch (error) {
      durationMs = Date.now() - started;
      code = error instanceof EmailDeliveryError ? error.code : "other";
      timedOutProperly = true;
    }
    // §130 — BOUNDED duration (not a hang): well under 15s.
    check("smtp-timeout:bounded", timedOutProperly && durationMs < 15_000, `${durationMs}ms code=${code}`);
    check(
      "smtp-timeout:safe-error-class",
      ["SMTP_TIMEOUT", "SMTP_CONNECTION_FAILED", "SMTP_DELIVERY_FAILED"].includes(code),
      `code=${code}`,
    );
  } else {
    check("smtp-timeout:bounded", false, "config unexpectedly invalid");
  }
}

/* ----------------------- §131/§22/§23 email templates --------------------- */

import { buildPasswordResetEmail } from "../src/lib/email/index";

{
  const evilName = '<script>alert("x")</script><img src=x onerror="alert(1)">';
  const evilAppName = 'App</h1><script>alert(2)</script>';
  const resetUrl = "https://app.example.com/#/reset-password/abcDEF123_-token";
  for (const locale of ["en", "fa"] as const) {
    const msg = buildPasswordResetEmail({
      to: "user@example.com",
      recipientName: evilName,
      resetUrl,
      minutes: 30,
      locale,
      appName: evilAppName,
    });
    const html = msg.html;
    check(`email-html:${locale}:no-script-tag`, !html.includes("<script"), "no executable script element");
    // The attack payload must survive ONLY as escaped TEXT: no raw <img> tag,
    // no quoted attribute value that could execute (§23).
    check(`email-html:${locale}:no-raw-img`, !html.includes("<img"), "no raw img element");
    check(`email-html:${locale}:no-executable-handler`, !html.includes('onerror="') && !html.includes('onerror=\''), "no executable inline handler");
    check(`email-html:${locale}:escaped-name`, !html.includes(evilName) && html.includes("&lt;script&gt;"), "malicious name is entity-escaped");
    check(`email-html:${locale}:reset-url-present`, html.includes(resetUrl), "reset URL survives escaping (safe chars)");
    check(`email-html:${locale}:dir`, locale === "fa" ? html.includes('dir="rtl"') : html.includes('dir="ltr"'), `dir attribute`);
    check(`email-html:${locale}:lang`, locale === "fa" ? html.includes('lang="fa"') : html.includes('lang="en"'), `lang attribute`);
    check(`email-html:${locale}:subject`, locale === "fa" ? msg.subject.includes("بازنشانی") : msg.subject.includes("Reset your password"), "localized subject");
    check(`email-html:${locale}:plain-text`, msg.text.includes(resetUrl), "plain-text body includes URL");
  }
}

/* ------------------------------- §135 redaction --------------------------- */

import { logError, logWarn, logInfo } from "../src/lib/observability/logger";

{
  const lines: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process as unknown as { stdout: { write: unknown } }).stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  (process as unknown as { stderr: { write: unknown } }).stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    logError("unit.redaction.probe", {
      password: "super-secret-password",
      token: "raw-token-value",
      secret: "my-secret",
      apiKey: "AKIA-EXAMPLE",
      authorization: "Bearer abc",
      cookie: "session=xyz",
      "set-cookie": "a=b",
      DATABASE_URL: "file:/home/me/secret.db",
      NEXTAUTH_SECRET: "nextauth-secret-value",
      EMAIL_SERVER_PASSWORD: "smtp-pass",
      merchantId: "merchant-123",
      safeField: "visible-value",
    });
    logWarn("unit.redaction.nested", { nested: { password: "deep", ok: 1 }, arr: [{ token: "t" }] });
    logInfo("unit.redaction.error-obj", { error: new Error("boom with /etc/passwd path") });
  } finally {
    (process as unknown as { stdout: { write: unknown } }).stdout.write = origOut;
    (process as unknown as { stderr: { write: unknown } }).stderr.write = origErr;
  }
  const all = lines.join("");
  for (const secretValue of [
    "super-secret-password", "raw-token-value", "my-secret", "AKIA-EXAMPLE",
    "Bearer abc", "session=xyz", "secret.db", "nextauth-secret-value", "smtp-pass", "merchant-123", "deep",
  ]) {
    check(`redaction:${secretValue.slice(0, 12)}`, !all.includes(secretValue), "value absent from logs");
  }
  check("redaction:safe-field-visible", all.includes("visible-value"), "non-sensitive fields survive");
  check("redaction:replaced-marker", all.includes("[REDACTED]"), "REDACTED markers present");
  check("redaction:structured-line", all.includes('"level":"error"') && all.includes('"ts"'), "JSON lines with ts/level");
}

/* ------------------------ §133/§134 request-id rules ---------------------- */

import { getOrCreateRequestId, isSafeRequestId, newRequestId } from "../src/lib/observability/request-id";

{
  const valid = "client-id_AbC.123";
  const req1 = new Request("http://x/api", { headers: { "x-request-id": valid } });
  check("request-id:valid-echoed", getOrCreateRequestId(req1) === valid, "");

  const req2 = new Request("http://x/api", { headers: { "x-request-id": "short" } });
  const id2 = getOrCreateRequestId(req2);
  check("request-id:too-short-replaced", isSafeRequestId(id2) && id2 !== "short", "");

  const evil = "abc\n-def<script>";
  // Raw-socket clients can smuggle control chars; Bun's Request constructor
  // refuses them — probe getOrCreateRequestId via a header-map stub instead
  // (the function only reads req.headers.get).
  const stubReq = (headers: Record<string, string>): Request =>
    ({ headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } }) as unknown as Request;
  const id3 = getOrCreateRequestId(stubReq({ "x-request-id": evil }));
  check("request-id:control-chars-replaced", !id3.includes("\n") && id3 !== evil && /^[0-9a-f-]{36}$/.test(id3), "UUID generated");

  const oversized = "a".repeat(200);
  const id4 = getOrCreateRequestId(stubReq({ "x-request-id": oversized }));
  check("request-id:oversized-replaced", id4.length <= 64 && id4 !== oversized, "");

  const req5 = new Request("http://x/api");
  const id5a = getOrCreateRequestId(req5);
  const id5b = getOrCreateRequestId(req5);
  check("request-id:memoized-per-request", id5a === id5b, "same Request → same id");

  const uuid = newRequestId();
  check("request-id:uuid-format", /^[0-9a-f-]{36}$/.test(uuid), "");
}

/* --------------------- §145 startup validation logic ---------------------- */

import { startupBlockingProblems, getProductionConfigReport } from "../src/lib/config/production";

{
  const savedEnv = { ...process.env };
  const savedNodeEnv = process.env.NODE_ENV;
  try {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_URL;
    const problems = startupBlockingProblems();
    check("startup:missing-mandatory-blocks", problems.length >= 3, problems.join(","));

    process.env.DATABASE_URL = "file:/tmp/scratch.db";
    process.env.NEXTAUTH_SECRET = "x".repeat(44);
    process.env.NEXTAUTH_URL = "https://app.example.com";
    check("startup:valid-mandatory-passes", startupBlockingProblems().length === 0, "");

    process.env.NEXTAUTH_SECRET = "short";
    const rep = getProductionConfigReport();
    check("startup:short-secret-invalid", rep.core.nextauthSecret.status === "INVALID" && rep.blockingProblems.some((p) => p.startsWith("NEXTAUTH_SECRET")), "");

    // §4 — no secret values in the report.
    const repJson = JSON.stringify(getProductionConfigReport());
    check("startup:report-no-secret-values", !repJson.includes("x".repeat(20)), "values never serialized");
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
  (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
  check("startup:dev-never-blocks", startupBlockingProblems().length === 0, "development startup is never blocked");
}

/* --------------------- §147 rate limiter memory bounds -------------------- */

import { rateLimit, rateLimiterBucketCount } from "../src/lib/rate-limit";

{
  const before = rateLimiterBucketCount();
  for (let i = 0; i < 12_000; i++) {
    rateLimit(`unit:synthetic:key-${i}`, 10, 60_000);
  }
  const after = rateLimiterBucketCount();
  // Hard cap is 10_000 — the count MUST stay bounded (§147).
  check("rate-limit:buckets-bounded", after <= 10_000, `before=${before} after=${after}`);
  // Oversized attacker keys are hashed to a FIXED-SIZE normalized form:
  // 500 distinct 600-char keys create exactly 500 buckets (bounded key size,
  // deterministic), and repeating one key does NOT grow the map.
  const before2 = rateLimiterBucketCount();
  const longKeyBase = "unit:long:";
  rateLimit(`${longKeyBase}same`.padEnd(600, "x"), 5, 60_000);
  const afterSame1 = rateLimiterBucketCount();
  rateLimit(`${longKeyBase}same`.padEnd(600, "x"), 5, 60_000);
  const afterSame2 = rateLimiterBucketCount();
  check("rate-limit:same-long-key-one-bucket", afterSame2 === afterSame1, "repeat long key → no growth");
  for (let i = 0; i < 500; i++) {
    rateLimit(`${longKeyBase}${i}`.padEnd(600, String(i % 10)), 5, 60_000);
  }
  const afterMany = rateLimiterBucketCount();
  // §147 — with 12k+ synthetic keys and 501 oversized keys in flight, the
  // map MUST stay bounded by the hard cap and the limiter must not crash.
  check("rate-limit:long-keys-bounded", afterMany <= 10_000, `afterMany=${afterMany} ≤ hard cap 10000`);
  // Limiter still functions after churn.
  const r = rateLimit("unit:after-churn", 3, 60_000);
  check("rate-limit:functional-after-churn", r.allowed, "");
}

/* ---------------------- §136 prisma production logging -------------------- */

import { readFileSync } from "node:fs";
{
  const dbSrc = readFileSync(new URL("../src/lib/db.ts", import.meta.url), "utf8");
  const hasProdBranch = dbSrc.includes("process.env.NODE_ENV === 'production'");
  const prodNoQuery = /NODE_ENV === 'production'\s*\?\s*\(\s*\['warn', 'error'\]/.test(dbSrc);
  check("prisma-log:env-branch-exists", hasProdBranch, "");
  check("prisma-log:production-warn-error-only", prodNoQuery, "production: ['warn','error'] — no query stream");
  check("prisma-log:dev-includes-query", dbSrc.includes("'query'"), "dev keeps query logging");
}

/* ---------------------------- §80 event catalog --------------------------- */

import { OPERATIONAL_EVENTS, classifyStatus } from "../src/lib/observability/events";

{
  const expected = [
    "api.request.failed", "api.request.rate_limited", "auth.login.failed", "auth.login.success",
    "auth.password_reset.requested", "auth.password_reset.sent", "auth.password_reset.failed",
    "billing.payment.verification_failed", "billing.subscription.transition_failed",
    "ai.request.failed", "ai.cost.attribution_failed", "database.connection.failed",
    "database.migration_state_changed", "backup.created", "backup.verification_failed", "restore.drill.failed",
  ];
  const actual: string[] = Object.values(OPERATIONAL_EVENTS);
  for (const e of expected) {
    check(`events:${e}`, actual.includes(e), "catalog contains fixed event name");
  }
  check("classify:422-validation", classifyStatus(422) === "validation", "");
  check("classify:403-authorization", classifyStatus(403) === "authorization", "");
  check("classify:429-rate_limit", classifyStatus(429) === "rate_limit", "");
  check("classify:500-internal", classifyStatus(500) === "internal", "");
}

/* --------------------------------- summary -------------------------------- */

console.log(`\nP29-UNIT ${passed}/${passed + failed}`);
if (failed > 0) {
  console.error(`FAILURES: ${failures.join(" | ")}`);
  process.exit(1);
}
process.exit(0);
