import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { snapshotOwnCronRecord } from "./own-record.js";
import { resolveCronScheduledToolPolicy } from "./scheduled-tool-policy.js";
import type { CronAuthenticatedChannelRequester, CronStoredJob } from "./types.js";

/** Accepts only a complete version-1 requester; anything partial fails closed. */
export function normalizeCronAuthenticatedChannelRequester(
  value: unknown,
): CronAuthenticatedChannelRequester | undefined {
  const input = isRecord(value) ? snapshotOwnCronRecord(value) : undefined;
  if (input?.version !== 1) {
    return undefined;
  }
  const channel = normalizeOptionalLowercaseString(input.channel);
  const accountId = normalizeOptionalAccountId(
    typeof input.accountId === "string" ? input.accountId : undefined,
  );
  const senderId = normalizeOptionalString(input.senderId);
  return channel && accountId && senderId
    ? { version: 1, channel, accountId, senderId }
    : undefined;
}

/** Requester facts are usable only within the job's persisted owner and account policy. */
export function resolveCronAuthenticatedChannelRequester(
  job: Pick<CronStoredJob, "payload" | "owner" | "scheduledToolPolicy" | "toolsAllowProvenance">,
): CronAuthenticatedChannelRequester | undefined {
  if (job.payload.kind !== "agentTurn") {
    return undefined;
  }
  const policy = resolveCronScheduledToolPolicy({
    toolsAllow: job.payload.toolsAllow,
    owner: job.owner,
    scheduledToolPolicy: job.scheduledToolPolicy,
  });
  if (policy?.mode !== "account" || job.toolsAllowProvenance?.source !== "authenticated-requester") {
    return undefined;
  }
  const requester = normalizeCronAuthenticatedChannelRequester(
    job.toolsAllowProvenance.channelRequester,
  );
  return requester?.accountId === policy.ownerAccountId ? requester : undefined;
}
