/** Trusted gateway transport extension. Never load this in an agent workspace.
 * Installed by install-office365-transport.py into an OpenClaw source checkout.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

export function classifySession(sessionKey, requester) {
  if (requester?.messageChannel !== "whatsapp" || !requester.requesterSenderId) return null;
  // Require the canonical per-account DM route. Reject main sessions, identity
  // aliases, nested agent sessions and unknown route grammars rather than guess.
  const direct = /^agent:[^:]+:whatsapp:([^:]+):direct:([^:]+)$/.exec(sessionKey ?? "");
  if (direct) {
    const normalize = (s) =>
      String(s)
        .replace(/@s\.whatsapp\.net$/, "")
        .replace(/^\+/, "");
    if (
      requester.agentAccountId !== direct[1] ||
      normalize(direct[2]) !== normalize(requester.requesterSenderId)
    )
      return null;
    return { chat_kind: "private", conversation_id: sessionKey };
  }
  const group = /^agent:[^:]+:whatsapp:group:([^:]+@g\.us)$/.exec(sessionKey ?? "");
  return group ? { chat_kind: "group", conversation_id: sessionKey } : null;
}

export function withArthaGatewayContext(fetchFn, options, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const target = env.ARTHA_OFFICE365_MCP_URL ?? "https://pitch.artha.vc/mcp";
  const keyFile = env.ARTHA_OFFICE365_CONTEXT_KEY_FILE;
  const readKey = dependencies.readKey ?? (() => readFileSync(keyFile, "utf8").trim());
  return async (input, init) => {
    const request = new Request(input, init);
    // Scope the signing key to the exact configured MCP resource, never OAuth
    // discovery, arbitrary Graph requests, redirects or another MCP endpoint.
    const headers = new Headers(request.headers);
    headers.delete("x-artha-gateway-context");
    if (request.url === target && keyFile) {
      const authorization = headers.get("authorization") ?? "";
      if (authorization.startsWith("Bearer ")) {
        const route = classifySession(options.sessionKey, options.requesterScope);
        if (options.auth !== "oauth" || options.identity !== "per-requester" || !route) {
          throw new Error("Office365 transport requires a trusted per-requester WhatsApp route");
        }
        const key = readKey();
        if (Buffer.byteLength(key) < 32)
          throw new Error("Office365 transport signing key is invalid");
        const epoch = Math.floor((dependencies.now?.() ?? Date.now()) / 1000);
        const claims = {
          v: 1,
          aud: "artha-office365",
          identity_mode: "per-requester",
          sender_id: options.requesterScope.requesterSenderId,
          channel: "whatsapp",
          ...route,
          token_sha256: createHash("sha256").update(authorization.slice(7)).digest("hex"),
          request_id: randomUUID(),
          iat: epoch,
          exp: epoch + 90,
        };
        const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
        headers.set(
          "x-artha-gateway-context",
          encoded + "." + createHmac("sha256", key).update(encoded).digest("hex"),
        );
      }
    }
    // Reconstructing preserves signal/body and drops any caller-forged envelope.
    return fetchFn(new Request(request, { headers }));
  };
}
