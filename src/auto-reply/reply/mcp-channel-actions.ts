import { findMarkdownLinkSourceSpans } from "../../../packages/markdown-core/src/link-spans.js";
import type { McpConnectAction } from "../../agents/mcp-connect-action.js";
import type { McpAppChannelView } from "../../agents/mcp-ui-resource.js";
import { materializeMcpAppChannelPresentation } from "../../gateway/mcp-app-channel-action.js";
import { copyReplyPayloadMetadata, isReplyPayloadTerminalContent } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

function attachChannelPresentation(
  payloads: ReplyPayload[],
  createPresentation: () => ReplyPayload["presentation"],
): ReplyPayload[] {
  const index = payloads.findLastIndex(
    (payload) =>
      Boolean(payload.text?.trim()) &&
      payload.isError !== true &&
      isReplyPayloadTerminalContent(payload),
  );
  if (index < 0) {
    return payloads;
  }
  // Mint portable actions only after finding a visible terminal reply.
  const presentation = createPresentation();
  if (!presentation) {
    return payloads;
  }
  const result = payloads.slice();
  const payload = payloads[index]!;
  result[index] = copyReplyPayloadMetadata(payload, {
    ...payload,
    presentation: payload.presentation
      ? {
          ...payload.presentation,
          blocks: [...payload.presentation.blocks, ...presentation.blocks],
        }
      : presentation,
  });
  return result;
}

export function attachMcpAppChannelAction(params: {
  payloads: ReplyPayload[];
  channel?: string;
  sessionKey?: string;
  view?: McpAppChannelView;
}): ReplyPayload[] {
  const { channel, sessionKey, view } = params;
  if (!channel || channel === "webchat" || !sessionKey || !view) {
    return params.payloads;
  }
  return attachChannelPresentation(params.payloads, () =>
    materializeMcpAppChannelPresentation({ sessionKey, view }),
  );
}

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gu;

function stripModelAuthorizationLinks(text: string, authorizationUrl: string): string {
  const current = new URL(authorizationUrl);
  const matches = (raw: string) => {
    const url = URL.parse(raw.replace(/\\&/gu, "&").replace(/&amp;/gu, "&"));
    return (
      url?.origin === current.origin &&
      url.pathname === current.pathname &&
      url.searchParams.get("client_id") === current.searchParams.get("client_id")
    );
  };
  const containsAuthorizationLink = (value: string) =>
    [...value.matchAll(HTTP_URL_PATTERN)].some(([url]) => matches(url));
  if (!containsAuthorizationLink(text)) {
    return text;
  }
  // Remove whole Markdown links (including their labels/titles) before bare
  // URLs, so a model-echoed URL cannot survive as a clickable label or title.
  const chunks: string[] = [];
  let cursor = 0;
  for (const [start, end] of findMarkdownLinkSourceSpans(text)) {
    chunks.push(text.slice(cursor, start));
    const link = text.slice(start, end);
    if (!containsAuthorizationLink(link)) {
      chunks.push(link);
    }
    cursor = end;
  }
  chunks.push(text.slice(cursor));
  return chunks
    .join("")
    .replace(HTTP_URL_PATTERN, (url) => (matches(url) ? "" : url))
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function attachMcpConnectChannelAction(params: {
  payloads: ReplyPayload[];
  action?: McpConnectAction;
}): ReplyPayload[] {
  const { action } = params;
  if (!action) {
    return params.payloads;
  }
  const attached = attachChannelPresentation(params.payloads, () => ({
    blocks: [
      {
        type: "buttons",
        buttons: [
          {
            label: `Connect ${action.serverName}`,
            action: { type: "url", url: action.authorizationUrl },
          },
        ],
      },
    ],
  }));
  if (attached === params.payloads) {
    return attached;
  }
  // The current tool action owns the sign-in URL. Sanitize every terminal
  // text chunk, not just the chunk carrying its channel button/fallback.
  return attached.map((payload) => {
    if (!payload.text || payload.isError || !isReplyPayloadTerminalContent(payload)) {
      return payload;
    }
    const text = stripModelAuthorizationLinks(payload.text, action.authorizationUrl);
    return text === payload.text
      ? payload
      : copyReplyPayloadMetadata(payload, { ...payload, text });
  });
}
