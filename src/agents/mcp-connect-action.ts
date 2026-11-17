import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";

/** Gateway route that receives per-requester MCP OAuth redirects. */
export const MCP_OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";

export type McpConnectAction = {
  serverName: string;
  authorizationUrl: string;
};

export function readMcpConnectAction(result: unknown): McpConnectAction | undefined {
  const connect = asRecord(asRecord(asRecord(result)?.details)?.mcpConnect);
  const serverName = typeof connect?.serverName === "string" ? connect.serverName.trim() : "";
  const authorizationUrl =
    typeof connect?.authorizationUrl === "string" ? connect.authorizationUrl.trim() : "";
  if (!serverName || !URL.canParse(authorizationUrl)) {
    return undefined;
  }
  const protocol = new URL(authorizationUrl).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    return undefined;
  }
  return { serverName, authorizationUrl };
}
