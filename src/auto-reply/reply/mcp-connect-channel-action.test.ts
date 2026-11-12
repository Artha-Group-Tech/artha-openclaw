import { describe, expect, it } from "vitest";
import { renderMessagePresentationFallbackText } from "../../interactive/payload.js";
import { attachMcpConnectChannelAction } from "./mcp-connect-channel-action.js";

const CALLBACK = encodeURIComponent("https://gateway.example/oauth/mcp/callback");
const signIn = (client: string, state: string) =>
  `https://auth.example/authorize?client_id=${client}&redirect_uri=${CALLBACK}&state=${state}`;

describe("attachMcpConnectChannelAction", () => {
  it("adds one portable URL action to the final visible reply", () => {
    const payloads = attachMcpConnectChannelAction({
      payloads: [{ text: "progress", isStatusNotice: true }, { text: "Sign in to continue." }],
      action: {
        serverName: "calendar",
        authorizationUrl: "https://auth.example/authorize?state=opaque",
      },
    });

    expect(renderMessagePresentationFallbackText(payloads[1]!)).toBe(
      "Sign in to continue.\n\n- Connect calendar: https://auth.example/authorize?state=opaque",
    );
  });

  it("preserves payloads without an action or eligible terminal reply", () => {
    const payloads = [{ text: "failed", isError: true }];
    expect(attachMcpConnectChannelAction({ payloads })).toEqual(payloads);
    expect(
      attachMcpConnectChannelAction({
        payloads,
        action: { serverName: "calendar", authorizationUrl: "https://auth.example/authorize" },
      }),
    ).toEqual(payloads);
  });

  it.each([
    ["bare", (url: string) => url],
    ["Markdown", (url: string) => `[Sign in](${url} "DFS login")`],
    ["autolink", (url: string) => `<${url}>`],
    ["URL-labelled Markdown", (url: string) => `[${url}](${url} "${url}")`],
    ["escaped Markdown", (url: string) => `[Sign in](${url.replaceAll("&", "\\&")})`],
    ["HTML-escaped Markdown", (url: string) => `[Sign in](${url.replaceAll("&", "&amp;")})`],
  ])("delivers only the current Connect link instead of a stale %s link", (_kind, link) => {
    const stale = `${signIn("calendar", "old")}&code_challenge=old`;
    const current = `${signIn("calendar", "current")}&code_challenge=Current_CASE`;
    const other = "https://docs.example/help";
    const source = {
      text: `Here's your login link:\n\n${link(stale)}\n\nKeep [these instructions](${other}).`,
    };
    const output = attachMcpConnectChannelAction({
      payloads: [{ text: stale }, source],
      action: { serverName: "calendar", authorizationUrl: current },
    });
    const delivered = output.map(renderMessagePresentationFallbackText).join("\n\n");
    expect(delivered).not.toContain(stale);
    expect(delivered.match(/https:\/\/auth\.example\/authorize[^\s]+/gu)).toEqual([current]);
    expect(delivered).toContain(`Keep [these instructions](${other}).`);
    expect(source.text).toContain(link(stale));
  });

  it("deduplicates a model-echoed current URL", () => {
    const current = signIn("calendar", "current");
    const output = attachMcpConnectChannelAction({
      payloads: [{ text: `Sign in: ${current}` }],
      action: { serverName: "calendar", authorizationUrl: current },
    });
    const delivered = output.map(renderMessagePresentationFallbackText).join("\n");
    expect(delivered.split(current)).toHaveLength(2);
  });

  // Per-requester OAuth registers one client per requester, so a stale link
  // from history can carry a different client_id than the current one.
  it("drops a stale link registered under another client", () => {
    const stale = signIn("requester-a", "old");
    const current = signIn("requester-b", "current");
    const output = attachMcpConnectChannelAction({
      payloads: [{ text: `Please sign in:\n\nSign in: ${stale}` }],
      action: { serverName: "dfs", authorizationUrl: current },
    });
    const delivered = output.map(renderMessagePresentationFallbackText).join("\n");
    expect(delivered).not.toContain(stale);
    expect(delivered).toContain(`Connect dfs: ${current}`);
  });

  it("drops a pasted sign-in link on a turn without a connect action", () => {
    const docs = "https://auth.example/authorize?client_id=docs";
    const output = attachMcpConnectChannelAction({
      payloads: [{ text: `Use this link: ${signIn("dfs", "old")}\n\nSee ${docs}` }],
    });
    expect(output.map((entry) => entry.text)).toEqual([`Use this link:\n\nSee ${docs}`]);
  });
});
