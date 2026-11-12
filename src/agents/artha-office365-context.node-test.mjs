import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { classifySession, withArthaGatewayContext } from "./artha-office365-context.mjs";

const requesterScope = {
  requesterSenderId: "+919999999999",
  messageChannel: "whatsapp",
  agentAccountId: "default",
};
const options = {
  auth: "oauth",
  identity: "per-requester",
  requesterScope,
  sessionKey: "agent:main:whatsapp:default:direct:+919999999999",
};
const key = "test-key-".repeat(8);
const deps = {
  env: { ARTHA_OFFICE365_CONTEXT_KEY_FILE: "/test/host-only-key" },
  readKey: () => key,
};

test("signs the authenticated bearer and canonical private route on each request", async () => {
  let received;
  const wrapped = withArthaGatewayContext(
    async (request) => {
      received = request;
      return new Response("ok");
    },
    options,
    deps,
  );
  await wrapped("https://pitch.artha.vc/mcp", {
    method: "POST",
    body: "hello",
    headers: { Authorization: "Bearer caller-one" },
  });
  const [encoded, signature] = received.headers.get("x-artha-gateway-context").split(".");
  assert.equal(signature, createHmac("sha256", key).update(encoded).digest("hex"));
  const claims = JSON.parse(Buffer.from(encoded, "base64url"));
  assert.equal(claims.token_sha256, createHash("sha256").update("caller-one").digest("hex"));
  assert.equal(claims.chat_kind, "private");
  assert.equal(await received.text(), "hello");
  await wrapped("https://pitch.artha.vc/mcp", {
    headers: { Authorization: "Bearer refreshed-token" },
  });
  const refreshed = JSON.parse(
    Buffer.from(received.headers.get("x-artha-gateway-context").split(".")[0], "base64url"),
  );
  assert.notEqual(refreshed.token_sha256, claims.token_sha256);
});

test("distinguishes group routes and rejects ambiguous/shared identities", async () => {
  assert.equal(
    classifySession("agent:main:whatsapp:group:123@g.us", requesterScope).chat_kind,
    "group",
  );
  for (const sessionKey of [
    "agent:main:main",
    "agent:main:whatsapp:default:direct:+911111111111",
    "agent:main:whatsapp:other:direct:+919999999999",
    "agent:main:subagent:abc",
  ]) {
    assert.equal(classifySession(sessionKey, requesterScope), null);
  }
  let called = false;
  const wrapped = withArthaGatewayContext(
    async () => {
      called = true;
      return new Response();
    },
    { ...options, identity: "shared" },
    deps,
  );
  await assert.rejects(() =>
    wrapped("https://pitch.artha.vc/mcp", { headers: { Authorization: "Bearer shared" } }),
  );
  assert.equal(called, false);
});

test("never signs another endpoint and removes forged context", async () => {
  let received;
  const wrapped = withArthaGatewayContext(
    async (request) => {
      received = request;
      return new Response();
    },
    options,
    deps,
  );
  await wrapped("https://elsewhere.example/mcp", {
    headers: { Authorization: "Bearer token", "x-artha-gateway-context": "forged" },
  });
  assert.equal(received.headers.has("x-artha-gateway-context"), false);
});

test("reused transport binds workflow identity to the current host message, never request randomness", async () => {
  let sourceMessage = {
    sessionKey: options.sessionKey,
    messageId: "native-message-1",
    requester: {
      channel: "whatsapp",
      accountId: "default",
      senderId: requesterScope.requesterSenderId,
    },
  };
  const claims = [];
  const wrapped = withArthaGatewayContext(
    async (request) => {
      claims.push(
        JSON.parse(
          Buffer.from(request.headers.get("x-artha-gateway-context").split(".")[0], "base64url"),
        ),
      );
      return new Response();
    },
    { ...options, getSourceMessage: () => sourceMessage },
    deps,
  );
  const call = () =>
    wrapped("https://pitch.artha.vc/mcp", { headers: { Authorization: "Bearer caller" } });
  await call();
  await call();
  assert.match(claims[0].host_action_id, /^msg_[a-f0-9]{64}$/);
  assert.equal(claims[0].host_action_id, claims[1].host_action_id);
  assert.notEqual(claims[0].request_id, claims[1].request_id);
  sourceMessage = { ...sourceMessage, messageId: "native-message-2" };
  await call();
  assert.notEqual(claims[0].host_action_id, claims[2].host_action_id);
  sourceMessage = { ...sourceMessage, sessionKey: "another-session" };
  await assert.rejects(call, /source message/);
  sourceMessage = undefined;
  await call();
  assert.equal(claims[3].host_action_id, undefined);
});
