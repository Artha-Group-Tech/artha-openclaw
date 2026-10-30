import { describe, expect, it } from "vitest";
import { normalizeCronJobInput } from "./normalize.js";
import {
  normalizeCronAuthenticatedChannelRequester,
  resolveCronAuthenticatedChannelRequester,
} from "./tools-allow-provenance.js";

const SESSION_KEY = "agent:main:whatsapp:default:direct:+15550000001";
const REQUESTER = {
  version: 1,
  channel: "whatsapp",
  accountId: "default",
  senderId: "+15550000001",
} as const;

function requesterJob(overrides: { ownerAccountId?: string; policyAccountId?: string } = {}) {
  return {
    payload: { kind: "agentTurn", message: "x", toolsAllow: ["dfs__*"] },
    owner: { sessionKey: SESSION_KEY, accountId: overrides.ownerAccountId ?? "default" },
    scheduledToolPolicy: {
      version: 1,
      mode: "account",
      ownerSessionKey: SESSION_KEY,
      ownerAccountId: overrides.policyAccountId ?? "default",
    },
    toolsAllowProvenance: {
      version: 1,
      source: "authenticated-requester",
      channelRequester: REQUESTER,
    },
  } as never;
}

describe("cron authenticated channel requester", () => {
  it("rejects partial requesters", () => {
    expect(normalizeCronAuthenticatedChannelRequester({ ...REQUESTER, senderId: " " })).toBe(
      undefined,
    );
    expect(normalizeCronAuthenticatedChannelRequester({ ...REQUESTER, version: 2 })).toBe(
      undefined,
    );
  });

  it("resolves the requester only under the job's matching account policy", () => {
    expect(resolveCronAuthenticatedChannelRequester(requesterJob())).toEqual(REQUESTER);
    // Owner and policy disagree: the policy is invalid, so no requester identity is used.
    expect(
      resolveCronAuthenticatedChannelRequester(requesterJob({ ownerAccountId: "other" })),
    ).toBe(undefined);
  });

  it("survives job normalization so a stored job keeps its requester", () => {
    const normalized = normalizeCronJobInput({
      name: "plugin:artha-reminders:tag:r1a2b3c4d:x",
      schedule: { kind: "cron", expr: "0 10 * * 1" },
      sessionTarget: `session:${SESSION_KEY}`,
      ...(requesterJob() as object),
    }) as { toolsAllowProvenance?: unknown };
    expect(normalized.toolsAllowProvenance).toEqual({
      version: 1,
      source: "authenticated-requester",
      channelRequester: REQUESTER,
    });
  });
});
