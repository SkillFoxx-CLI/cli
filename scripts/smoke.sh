#!/bin/bash
# packages/cli/scripts/smoke.sh: сборка и запуск собранного CLI под Node 18 и текущей версией,
# состав пакета для npm. Запуск: bash scripts/smoke.sh 
set -euo pipefail
cd "$(dirname "$0")/.."
node build.mjs
node dist/cli.js --version
npx -y node@18 dist/cli.js --version
npx -y node@18 dist/cli.js --help >/dev/null
TMP="$(mktemp -d)"
SKILLFOXX_HOME="$TMP/sf" DO_NOT_TRACK=1 node dist/cli.js list --json
npm pack --dry-run --json > "$TMP/pack.json"
node -e '
  const files = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[0].files.map((f) => f.path).sort()
  const expected = ["LICENSE", "README.en.md", "README.md", "dist/THIRD_PARTY_LICENSES.txt", "dist/cli.js", "package.json"]
  if (JSON.stringify(files) !== JSON.stringify(expected)) { console.error("состав пакета:", files); process.exit(1) }
  console.log("состав пакета верный")
' "$TMP/pack.json"
rm -rf "$TMP"
