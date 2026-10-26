import type { FetchLike } from "@modelcontextprotocol/client";
import type { SessionMcpRequesterScope } from "./agent-bundle-mcp-types.js";
export function withArthaGatewayContext(
  fetchFn: FetchLike,
  options: {
    auth?: string;
    identity?: string;
    requesterScope?: SessionMcpRequesterScope;
    sessionKey?: string;
  },
): FetchLike;
