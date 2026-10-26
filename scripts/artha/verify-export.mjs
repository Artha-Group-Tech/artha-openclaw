import fs from "node:fs";
import path from "node:path";
const root = process.argv[2] ?? "/app";
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
if (pkg.name !== "openclaw" || !/^\d+\.\d+\.\d+$/.test(pkg.version))
  throw Error("Invalid OpenClaw package");
const expectedVersion = process.argv[3];
if (expectedVersion && pkg.version !== expectedVersion)
  throw Error(`Expected OpenClaw ${expectedVersion}, received ${pkg.version}`);
let found = false;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) walk(file);
    else if (/\.(m?js)$/.test(e.name)) {
      const source = fs.readFileSync(file, "utf8");
      if (
        source.includes("x-artha-gateway-context") &&
        source.includes("ARTHA_OFFICE365_CONTEXT_KEY_FILE")
      )
        found = true;
    }
  }
}
walk(path.join(root, "dist"));
if (!found)
  throw Error("Required Artha sender-verification transport is missing from exported dist");
console.log(JSON.stringify({ name: pkg.name, version: pkg.version, signerPresent: true }));
