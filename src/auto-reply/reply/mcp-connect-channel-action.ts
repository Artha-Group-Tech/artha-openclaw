import { findMarkdownLinkSourceSpans } from "../../../packages/markdown-core/src/link-spans.js";
import { MCP_OAUTH_CALLBACK_PATH, type McpConnectAction } from "../../agents/mcp-connect-action.js";
import { copyReplyPayloadMetadata, isReplyPayloadTerminalContent } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gu;

// Any authorization URL that redirects to the Gateway's MCP callback is an
// OpenClaw sign-in link. Only the connect tool's action may deliver one: a copy
// in model text comes from history, so its state is stale or belongs to
// another requester's client.
function isMcpSignInUrl(raw: string): boolean {
  const url = URL.parse(raw.replace(/\\&/gu, "&").replace(/&amp;/gu, "&"));
  const redirect = url && URL.parse(url.searchParams.get("redirect_uri") ?? "");
  return redirect?.pathname === MCP_OAUTH_CALLBACK_PATH;
}

function stripModelSignInLinks(text: string): string {
  const containsSignInLink = (value: string) =>
    [...value.matchAll(HTTP_URL_PATTERN)].some(([url]) => isMcpSignInUrl(url));
  if (!containsSignInLink(text)) {
    return text;
  }
  // Remove whole Markdown links (including their labels/titles) before bare
  // URLs, so a model-echoed URL cannot survive as a clickable label or title.
  const chunks: string[] = [];
  let cursor = 0;
  for (const [start, end] of findMarkdownLinkSourceSpans(text)) {
    chunks.push(text.slice(cursor, start));
    const link = text.slice(start, end);
    if (!containsSignInLink(link)) {
      chunks.push(link);
    }
    cursor = end;
  }
  chunks.push(text.slice(cursor));
  return chunks
    .join("")
    .replace(HTTP_URL_PATTERN, (url) => (isMcpSignInUrl(url) ? "" : url))
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function isEligibleTerminalPayload(payload: ReplyPayload): boolean {
  return Boolean(
    payload.text?.trim() && payload.isError !== true && isReplyPayloadTerminalContent(payload),
  );
}

export function attachMcpConnectChannelAction(params: {
  payloads: ReplyPayload[];
  action?: McpConnectAction;
}): ReplyPayload[] {
  // Sanitize every terminal text chunk, also on turns without a connect
  // action, where a pasted link is always a stale one from history.
  const payloads = params.payloads.map((entry) => {
    if (!entry.text || entry.isError || !isReplyPayloadTerminalContent(entry)) {
      return entry;
    }
    const text = stripModelSignInLinks(entry.text);
    return text === entry.text ? entry : copyReplyPayloadMetadata(entry, { ...entry, text });
  });
  const index = params.action ? payloads.findLastIndex(isEligibleTerminalPayload) : -1;
  if (!params.action || index < 0) {
    return payloads;
  }
  const block = {
    type: "buttons" as const,
    buttons: [
      {
        label: `Connect ${params.action.serverName}`,
        action: { type: "url" as const, url: params.action.authorizationUrl },
      },
    ],
  };
  const payload = payloads[index]!;
  payloads[index] = copyReplyPayloadMetadata(payload, {
    ...payload,
    presentation: payload.presentation
      ? { ...payload.presentation, blocks: [...payload.presentation.blocks, block] }
      : { blocks: [block] },
  });
  return payloads;
}
