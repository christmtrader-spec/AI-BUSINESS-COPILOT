#!/usr/bin/env node
/**
 * scripts/github-device-flow.cjs — R178.G THE GITHUB BRIDGE
 *
 * One-shot bridge: obtains a GitHub OAuth token via the OFFICIAL device flow
 * (RFC 8628) with the GitHub CLI's public client_id, then immediately pushes
 * the full local history to the operator's repo. The user's only act is to
 * open https://github.com/login/device and type the one-time code.
 *
 * Scope discipline: `public_repo` ONLY — the repo is public and zero
 * .github/workflows exist in all history, so nothing broader is needed.
 *
 * Runtime state lives in .zscripts/ (gitignored). Verdicts are logged to
 * .zscripts/github-bridge.log (plain text + JSONL, R111 spirit).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CLIENT_ID = '178c6fc778ccc68e1d6a'; // GitHub CLI — public, well-known client id
const SCOPE = 'public_repo';
const ROOT = '/home/z/my-project';
const REPO_URL = 'https://github.com/christmtrader-spec/AI-BUSINESS-COPILOT.git';
const LOG = path.join(ROOT, '.zscripts', 'github-bridge.log');
const STATE = path.join(ROOT, '.zscripts', 'github-bridge-state.json');
const CRED_FILE = path.join(os.homedir(), '.git-credentials');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) { /* best effort */ }
}

function writeState(obj) {
  try { fs.writeFileSync(STATE, JSON.stringify(obj, null, 2)); } catch (_) { /* best effort */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function githubPost(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'abc-erp-device-flow-bridge',
    },
    body: new URLSearchParams(params).toString(),
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* non-json error body */ }
  return { status: res.status, data };
}

async function requestDeviceCode() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { status, data } = await githubPost('https://github.com/login/device/code', {
        client_id: CLIENT_ID,
        scope: SCOPE,
      });
      if (status === 200 && data.device_code) return data;
      throw new Error(`device/code HTTP ${status}: ${JSON.stringify(data)}`);
    } catch (err) {
      log(`device-code attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt === 3) throw err;
      await sleep(2000 * attempt);
    }
  }
}

async function pollForToken(deviceCode, intervalSec, expiresSec) {
  let interval = Math.max(5, intervalSec || 5) * 1000;
  const deadline = Date.now() + (expiresSec || 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    let resp;
    try {
      resp = await githubPost('https://github.com/login/oauth/access_token', {
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    } catch (err) {
      log(`poll network hiccup (will retry): ${err.message}`);
      continue;
    }
    const { data } = resp;
    if (data.access_token) return data;
    const errType = data.error || 'unknown';
    if (errType === 'authorization_pending') {
      writeState({ stage: 'awaiting_user_authorization' });
      continue;
    }
    if (errType === 'slow_down') { interval += 5000; continue; }
    if (errType === 'expired_token') throw new Error('EXPIRED: the one-time code expired before authorization');
    if (errType === 'access_denied') throw new Error('DENIED: authorization was refused on github.com/login/device');
    throw new Error(`unexpected poll error: ${JSON.stringify(data)}`);
  }
  throw new Error('EXPIRED: authorization window elapsed');
}

function installCredentials(token) {
  const line = `https://oauth2:${token}@github.com\n`;
  let existing = '';
  try { existing = fs.readFileSync(CRED_FILE, 'utf8'); } catch (_) { /* first token */ }
  const kept = existing.split('\n').filter((l) => l.trim() !== '' && !/https:\/\/[^/]*github\.com/.test(l));
  fs.writeFileSync(CRED_FILE, kept.concat(['https://oauth2:' + token + '@github.com']).join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(CRED_FILE, 0o600);
  execFileSync('git', ['config', '--global', 'credential.helper', 'store']);
  log('credentials installed (~/.git-credentials, mode 0600, helper=store)');
}

function pushHistory() {
  log(`pushing full history to ${REPO_URL} ...`);
  const out = execFileSync('git', ['push', 'origin', 'main', '--progress'], {
    cwd: ROOT,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  const text = out ? out.toString() : '';
  return text;
}

function verifyRemote() {
  const remote = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd: ROOT }).toString().trim().split(/\s+/)[0];
  const local = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
  return { remote, local, match: remote === local };
}

(async () => {
  writeState({ stage: 'requesting_device_code', startedAt: new Date().toISOString() });
  log('=== GITHUB DEVICE FLOW BRIDGE START ===');
  log(`target: ${REPO_URL}  scope: ${SCOPE}  client: GitHub CLI (public id)`);

  const dc = await requestDeviceCode();
  log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  log(`USER CODE: ${dc.user_code}`);
  log(`OPEN THIS URL: ${dc.verification_uri_complete || dc.verification_uri}`);
  log(`(bare URL: ${dc.verification_uri}  — expires in ~${Math.round((dc.expires_in || 900) / 60)} min)`);
  log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  writeState({ stage: 'awaiting_user_authorization', userCode: dc.user_code, verificationUri: dc.verification_uri_complete || dc.verification_uri });

  let token;
  try {
    const tok = await pollForToken(dc.device_code, dc.interval, dc.expires_in);
    token = tok.access_token;
    log(`token granted (scope=${tok.scope || SCOPE})`);
  } catch (err) {
    log(`VERDICT: FAILED — ${err.message}`);
    writeState({ stage: 'failed', reason: err.message, endedAt: new Date().toISOString() });
    process.exit(2);
  }

  try {
    installCredentials(token);
    const pushOut = pushHistory();
    const tail = pushOut.split('\n').filter(Boolean).slice(-12).join(' | ');
    log(`push output tail: ${tail}`);
    const { remote, local, match } = verifyRemote();
    if (match) {
      log(`VERDICT: SUCCESS — remote main = local HEAD = ${local}`);
      writeState({ stage: 'pushed', pushedAt: new Date().toISOString(), head: local, remote: REPO_URL });
    } else {
      log(`VERDICT: MISMATCH — local=${local} remote=${remote}`);
      writeState({ stage: 'mismatch', local, remote });
      process.exit(3);
    }
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString().split('\n').filter(Boolean).slice(-6).join(' | ') : err.message;
    log(`VERDICT: FAILED — push/install error: ${msg}`);
    writeState({ stage: 'failed', reason: msg, endedAt: new Date().toISOString() });
    process.exit(4);
  }
})();
