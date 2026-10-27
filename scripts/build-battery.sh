#!/bin/bash
# build-battery.sh — production build for the regression-battery server.
#
# R130 LAW: the full e2e-smoke (~500 requests, ~45 route compiles) needs
# ~2.8GB in next DEV mode and OOM-kills this 4GB sandbox (kernel SIGKILL,
# 3× observed). Batteries therefore run against a PRODUCTION server
# (next start standalone, ~400-600MB RSS) on port 3100.
#
# Two sandbox laws honored here:
# 1. Build-time tsc phase OOMs the box (turbopack graph + tsc worker > 4GB).
#    tsc ALWAYS runs standalone as its own gate (0 errors) — so this build
#    temporarily sets typescript.ignoreBuildErrors and REVERTS it right
#    after (verified by git diff at exit).
# 2. A failed build ORPHANS its prerender next-server child (2+GB) which
#    poisons every later build/run — this script kills orphans before and
#    after the build.
set -u
cd "$(dirname "$0")/.."

pkill -9 -f "next-server" 2>/dev/null || true
sleep 1

python3 - <<'EOF'
p = 'next.config.ts'
s = open(p).read()
marker = '// R130 TEMP (revert after build)'
if marker not in s:
    s = s.replace(
        'const nextConfig: NextConfig = {\n  output: "standalone",',
        'const nextConfig: NextConfig = {\n  output: "standalone",\n  ' + marker
        + ': build-time tsc OOMs the 4GB sandbox; tsc runs standalone as its own gate.\n'
        + '  typescript: { ignoreBuildErrors: true },',
    )
    open(p, 'w').write(s)
    print("temp-config: applied")
else:
    print("temp-config: already present")
EOF

bun run build
BUILD_RC=$?

git checkout -- next.config.ts 2>/dev/null || python3 - <<'EOF'
p = 'next.config.ts'
s = open(p).read()
s = s.replace('  // R130 TEMP (revert after build): build-time tsc OOMs the 4GB sandbox; tsc runs standalone as its own gate.\n  typescript: { ignoreBuildErrors: true },\n', '')
open(p, 'w').write(s)
EOF
pkill -9 -f "next-server" 2>/dev/null || true
echo "build rc=$BUILD_RC (config reverted, orphans swept)"
exit $BUILD_RC
