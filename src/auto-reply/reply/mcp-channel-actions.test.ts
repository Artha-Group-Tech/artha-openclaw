import { beforeEach, expect, it, vi } from "vitest";

const materialize = vi.hoisted(() => vi.fn());
vi.mock("../../gateway/mcp-app-channel-action.js", () => ({
  materializeMcpAppChannelPresentation: materialize,
}));

import { renderMessagePresentationFallbackText as renderFallback } from "../../interactive/payload.js";
import {
  isReplyPayloadSessionWriterDeliveryAuthorized as isAuthorized,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  attachMcpAppChannelAction,
  attachMcpConnectChannelAction as attachConnect,
} from "./mcp-channel-actions.js";

const view = { viewId: "view-latest" };
const appUrl = "https://node.tailnet.ts.net/__openclaw__/mcp-app#opaque-ticket";
const authUrl = "https://auth.example/authorize?state=opaque";
const action = { serverName: "calendar", authorizationUrl: authUrl };
const presentation = {
  blocks: [
    {
      type: "buttons" as const,
      buttons: [{ label: "Open app", action: { type: "web-app" as const, url: appUrl } }],
    },
  ],
};

beforeEach(() => {
  materialize.mockReset().mockReturnValue(presentation);
});

function attachApp(payloads: ReplyPayload[], channel: string | undefined) {
  return attachMcpAppChannelAction({ payloads, channel, sessionKey: "agent:main:main", view });
}

it.each([
  ["app", "Final answer", `Open app: ${appUrl}`],
  ["connect", "Sign in to continue.", `Connect calendar: ${authUrl}`],
])(
  "attaches one %s action while preserving final reply writer authority",
  (kind, text, fallback) => {
    const finalReply = setReplyPayloadMetadata(
      { text },
      {
        sessionWriterDeliveryAuthority: {
          sessionKey: "agent:main:main",
          expectedSessionId: "session-original",
          expectedWriterRunId: "writer-original",
        },
      },
    );
    const input = [
      { text: "progress", isStatusNotice: true },
      { text: "First answer" },
      finalReply,
    ];
    const payloads =
      kind === "app" ? attachApp(input, "telegram") : attachConnect({ payloads: input, action });
    expect(payloads[1]).toEqual({ text: "First answer" });
    if (kind === "app") {
      expect(payloads[2]).toEqual({ text, presentation });
    }
    expect(renderFallback(payloads[2]!)).toBe(`${text}\n\n- ${fallback}`);
    expect(
      ["writer-original", "writer-replacement"].map((activeWriterRunId) =>
        isAuthorized(payloads[2]!, { sessionId: "session-original", activeWriterRunId }),
      ),
    ).toEqual([true, false]);
  },
);

it("preserves payloads when no channel action can be attached", () => {
  const visible = [{ text: "Final answer" }];
  const error = [{ text: "failed", isError: true }];
  const ineligible = [
    { text: "status", isStatusNotice: true },
    { text: "error", isError: true },
    { mediaUrl: "https://example.test/image.png" },
  ];
  const cases: Array<
    [string, ReplyPayload[], (payloads: ReplyPayload[]) => ReplyPayload[], boolean?]
  > = [
    ["Control UI", visible, (payloads) => attachApp(payloads, "webchat")],
    ["unresolved channel", visible, (payloads) => attachApp(payloads, undefined)],
    ["no terminal text", ineligible, (payloads) => attachApp(payloads, "telegram")],
    ["no connect action", error, (payloads) => attachConnect({ payloads })],
    ["connect error", error, (payloads) => attachConnect({ payloads, action })],
    ["unavailable", visible, (payloads) => attachApp(payloads, "telegram"), true],
  ];
  for (const [name, payloads, attach, unavailable] of cases) {
    materialize.mockReset().mockReturnValue(unavailable ? undefined : presentation);
    expect(attach(payloads), name).toBe(payloads);
    if (!unavailable) {
      expect(materialize, name).not.toHaveBeenCalled();
    }
  }
});

it.each([
  ["bare", (url: string) => url],
  ["Markdown", (url: string) => `[Sign in](${url} "DFS login")`],
  ["autolink", (url: string) => `<${url}>`],
  ["URL-labelled Markdown", (url: string) => `[${url}](${url} "${url}")`],
  ["escaped Markdown", (url: string) => `[Sign in](${url.replaceAll("&", "\\&")})`],
  ["HTML-escaped Markdown", (url: string) => `[Sign in](${url.replaceAll("&", "&amp;")})`],
])("delivers only the current Connect link instead of a stale %s link", (_kind, link) => {
  const stale = "https://auth.example/authorize?client_id=calendar&state=old&code_challenge=old";
  const current =
    "https://auth.example/authorize?client_id=calendar&state=current&code_challenge=Current_CASE";
  const other = "https://docs.example/help";
  const source = setReplyPayloadMetadata(
    { text: `Here's your login link:\n\n${link(stale)}\n\nKeep [these instructions](${other}).` },
    {
      sessionWriterDeliveryAuthority: {
        sessionKey: "agent:main:main",
        expectedSessionId: "session-original",
        expectedWriterRunId: "writer-original",
      },
    },
  );
  const input = [{ text: stale }, source];
  const output = attachConnect({
    payloads: input,
    action: { serverName: "calendar", authorizationUrl: current },
  });
  const delivered = output.map(renderFallback).join("\n\n");
  expect(delivered).not.toContain(stale);
  expect(delivered.match(/https:\/\/auth\.example\/authorize[^\s]+/gu)).toEqual([current]);
  expect(delivered).toContain(`Keep [these instructions](${other}).`);
  expect(source.text).toContain(link(stale));
  expect(
    isAuthorized(output[1]!, {
      sessionId: "session-original",
      activeWriterRunId: "writer-original",
    }),
  ).toBe(true);
});

it("deduplicates a model-echoed current URL and preserves other clients' links", () => {
  const current = "https://auth.example/authorize?client_id=calendar&state=current";
  const other = "https://auth.example/authorize?client_id=mail&state=other";
  const output = attachConnect({
    payloads: [{ text: `Sign in: ${current}\n\nOther account: ${other}` }],
    action: { serverName: "calendar", authorizationUrl: current },
  });
  const delivered = output.map(renderFallback).join("\n");
  expect(delivered.split(current)).toHaveLength(2);
  expect(delivered).toContain(other);
});
