import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSessionMcpSourceMessage } from "./agent-bundle-mcp-request-context.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import { withArthaGatewayContext } from "./artha-office365-context.mjs";
import type { AnyAgentTool } from "./tools/common.js";

const sessionKey = "agent:main:whatsapp:default:direct:+919999999999";
const requester = { channel: "whatsapp", accountId: "default", senderId: "+919999999999" };

let keyDir: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (keyDir) {
    rmSync(keyDir, { recursive: true, force: true });
  }
  keyDir = undefined;
});

describe("host message identity at the actual tool execution boundary", () => {
  it("keeps retries stable and concurrent turns separate on one reused transport", async () => {
    keyDir = mkdtempSync(join(tmpdir(), "artha-message-source-"));
    const keyPath = join(keyDir, "context.key");
    writeFileSync(keyPath, "synthetic-test-key-".repeat(4), { mode: 0o600 });
    vi.stubEnv("ARTHA_OFFICE365_CONTEXT_KEY_FILE", keyPath);
    const received: Record<string, string>[] = [];
    const fetch = withArthaGatewayContext(
      async (input) => {
        const request = new Request(input);
        const header = request.headers.get("x-artha-gateway-context");
        assert.ok(header);
        const encoded = header.split(".")[0];
        assert.ok(encoded);
        received.push(JSON.parse(Buffer.from(encoded, "base64url").toString()));
        return new Response();
      },
      {
        auth: "oauth",
        identity: "per-requester",
        sessionKey,
        requesterScope: {
          messageChannel: "whatsapp",
          agentAccountId: "default",
          requesterSenderId: requester.senderId,
        },
        getSourceMessage: getSessionMcpSourceMessage,
      },
    );
    const source: AnyAgentTool = {
      name: "workflow_probe",
      label: "Workflow probe",
      description: "Probe host context",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await Promise.resolve();
        await fetch("https://pitch.artha.vc/mcp", {
          headers: { Authorization: "Bearer synthetic" },
        });
        return { content: [], details: {} };
      },
    };
    const bind = (sourceMessageId?: string) =>
      wrapToolWithBeforeToolCallHook(
        source,
        { sessionKey, requester, sourceMessageId },
        { emitDiagnostics: false },
      );
    // Uses the same signer and tool wrapper as production, with a synthetic key.
    const first = bind("message-one");
    const second = bind("message-two");
    await Promise.all([first.execute("model-call-one", {}), second.execute("model-call-two", {})]);
    await first.execute("different-model-retry-id", {});
    expect(received[0]?.host_action_id).toMatch(/^msg_[a-f0-9]{64}$/);
    expect(received[0]?.host_action_id).not.toBe(received[1]?.host_action_id);
    expect(received[0]?.host_action_id).toBe(received[2]?.host_action_id);
    expect(received[0]?.request_id).not.toBe(received[2]?.request_id);
    await bind().execute("no-source", {});
    expect(received[3]?.host_action_id).toBeUndefined();
    expect(getSessionMcpSourceMessage()).toBeUndefined();
  });
});
