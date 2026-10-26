import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const verifier = fileURLToPath(new URL("./verify-export.mjs", import.meta.url));
for (const present of [false, true]) {
  test(`export ${present ? "accepts the required signer" : "rejects a missing signer"}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "artha-export-"));
    try {
      fs.mkdirSync(path.join(dir, "dist"));
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.1" }),
      );
      fs.writeFileSync(
        path.join(dir, "dist/transport.mjs"),
        present
          ? "// x-artha-gateway-context ARTHA_OFFICE365_CONTEXT_KEY_FILE"
          : "// upstream-only transport",
      );
      const run = () => execFileSync(process.execPath, [verifier, dir], { stdio: "pipe" });
      if (present) {
        assert.equal(JSON.parse(run().toString()).signerPresent, true);
        execFileSync(process.execPath, [verifier, dir, "2026.9.1"], { stdio: "pipe" });
        assert.throws(() =>
          execFileSync(process.execPath, [verifier, dir, "2026.10.5"], { stdio: "pipe" }),
        );
      } else assert.throws(run);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
