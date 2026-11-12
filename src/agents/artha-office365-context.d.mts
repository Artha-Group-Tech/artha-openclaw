import type { FetchLike } from "@modelcontextprotocol/client";
import type { SessionMcpRequesterScope } from "./agent-bundle-mcp-types.js";
export function withArthaGatewayContext(
  fetchFn: FetchLike,
  options: {
    auth?: string;
    identity?: string;
    requesterScope?: SessionMcpRequesterScope;
    sessionKey?: string;
    getSourceMessage?: () =>
      | {
          sessionKey?: string;
          messageId: string;
          requester?: { channel?: string; accountId?: string; senderId?: string };
        }
      | undefined;
  },
): FetchLike;
