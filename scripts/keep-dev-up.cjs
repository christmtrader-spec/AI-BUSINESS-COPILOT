// Double-fork daemon starter — keeps the Next.js dev server alive across
// tool-call sessions in the sandbox (pattern from round 04 worklog).
const { spawn } = require("child_process");
const fs = require("fs");

const LOG = "/home/z/my-project/dev.log";

function isUp() {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync(
      "curl",
      ["-s", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", "http://localhost:3000/"],
      { encoding: "utf8" },
    );
    return out.trim() === "200";
  } catch {
    return false;
  }
}

if (isUp()) {
  console.log("dev server already up");
  process.exit(0);
}

// Second stage: fully detached daemon (session leader, own process group).
function stage2() {
  const out = fs.openSync(LOG, "a");
  const child = spawn("bun", ["run", "dev"], {
    cwd: "/home/z/my-project",
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  console.log("dev server spawned pid:", child.pid);
  process.exit(0);
}

// First stage: detach from the tool-call session.
const intermediate = spawn(process.execPath, [__filename, "--stage2"], {
  detached: true,
  stdio: "ignore",
});
intermediate.on("exit", () => process.exit(0));
intermediate.unref();

if (process.argv.includes("--stage2")) stage2();
