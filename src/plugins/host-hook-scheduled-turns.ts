import { randomUUID } from "node:crypto";
import {
  resolveExpiresAtMsFromDurationMs,
  timestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createAccountCronScheduledToolPolicy } from "../cron/scheduled-tool-policy.js";
import type { CronServiceContract } from "../cron/service-contract.js";
import {
  readCanonicalCronListPage,
  resolveCronListPageNextOffset,
} from "../cron/service/list-page-validation.js";
import type { CronAddOptions } from "../cron/service/state.js";
import { normalizeCronAuthenticatedChannelRequester } from "../cron/tools-allow-provenance.js";
import type { CronJob, CronJobCreate } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  deletePluginSessionSchedulerJob,
  registerPluginSessionSchedulerJob,
} from "./host-hook-runtime.js";
import type {
  PluginScheduledSessionTurn,
  PluginSessionSchedulerJobHandle,
  PluginSessionTurnListParams,
  PluginSessionTurnScheduleParams,
  PluginSessionTurnUnscheduleByTagParams,
  PluginSessionTurnUnscheduleByTagResult,
} from "./host-hooks.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginRegistry } from "./registry-types.js";

const log = createSubsystemLogger("plugins/host-scheduled-turns");
const PLUGIN_CRON_NAME_PREFIX = "plugin:";
const PLUGIN_CRON_TAG_MARKER = ":tag:";
const PLUGIN_CRON_CLEANUP_PAGE_SIZE = 200;
const PLUGIN_CRON_CLEANUP_MAX_PAGES = 50;

type ResolvedSessionTurnSchedule = Extract<CronJob["schedule"], { kind: "cron" | "at" }>;

function resolveSchedule(
  params: PluginSessionTurnScheduleParams,
): ResolvedSessionTurnSchedule | undefined {
  const cron = normalizeOptionalString((params as { cron?: unknown }).cron);
  if (cron) {
    const tz = normalizeOptionalString((params as { tz?: unknown }).tz);
    return {
      kind: "cron",
      expr: cron,
      ...(tz ? { tz } : {}),
    };
  }
  if ("delayMs" in params) {
    if (!Number.isFinite(params.delayMs) || params.delayMs < 0) {
      return undefined;
    }
    const timestamp = resolveExpiresAtMsFromDurationMs(Math.max(1, Math.floor(params.delayMs)));
    const at = timestampMsToIsoString(timestamp);
    if (!at) {
      return undefined;
    }
    return { kind: "at", at };
  }
  const rawAt = (params as { at?: unknown }).at;
  const at = rawAt instanceof Date ? rawAt : new Date(rawAt as string | number | Date);
  if (!Number.isFinite(at.getTime())) {
    return undefined;
  }
  return { kind: "at", at: at.toISOString() };
}

function formatScheduleLogContext(params: {
  pluginId: string;
  sessionKey?: string;
  name?: string;
  jobId?: string;
}): string {
  return (["pluginId", "sessionKey", "name", "jobId"] as const)
    .flatMap((key) => (key === "pluginId" || params[key] ? [`${key}=${params[key]}`] : []))
    .join(" ");
}

async function removeScheduledSessionTurn(params: {
  cron: CronServiceContract;
  jobId: string;
  pluginId: string;
  sessionKey?: string;
  name?: string;
}): Promise<boolean> {
  try {
    const result = await params.cron.remove(params.jobId);
    return isCronRemoveResult(result) && result.ok;
  } catch (error) {
    log.warn(
      `plugin session turn cleanup failed (${formatScheduleLogContext(params)}): ${formatErrorMessage(error)}`,
    );
    return false;
  }
}

const PLUGIN_CRON_RESERVED_DELIMITER = ":";

function resolvePluginSessionTurnTag(value: unknown): {
  tag?: string;
  invalid: boolean;
} {
  const tag = normalizeOptionalString(value);
  if (!tag) {
    return { invalid: false };
  }
  if (tag.includes(PLUGIN_CRON_RESERVED_DELIMITER)) {
    return { invalid: true };
  }
  return { tag, invalid: false };
}

function buildPluginSchedulerCronName(params: {
  pluginId: string;
  sessionKey: string;
  tag?: string;
  uniqueId?: string;
}): string {
  const uniqueId = params.uniqueId ?? randomUUID();
  if (!params.tag) {
    return `${PLUGIN_CRON_NAME_PREFIX}${params.pluginId}:${params.sessionKey}:${uniqueId}`;
  }
  return `${PLUGIN_CRON_NAME_PREFIX}${params.pluginId}${PLUGIN_CRON_TAG_MARKER}${params.tag}:${params.sessionKey}:${uniqueId}`;
}

function buildPluginSchedulerTagPrefix(params: {
  pluginId: string;
  tag: string;
  sessionKey: string;
}): string {
  return `${PLUGIN_CRON_NAME_PREFIX}${params.pluginId}${PLUGIN_CRON_TAG_MARKER}${params.tag}:${params.sessionKey}:`;
}

function isCronRemoveResult(
  value: unknown,
): value is Awaited<ReturnType<CronServiceContract["remove"]>> {
  return isRecord(value) && typeof value.ok === "boolean" && typeof value.removed === "boolean";
}

async function listAllCronJobsForPluginTagCleanup(
  cron: CronServiceContract,
  query: string,
): Promise<CronJob[]> {
  const jobs: CronJob[] = [];
  let offset = 0;
  // Concurrent inventory churn is best effort; a later cleanup can catch moved jobs.
  for (let pageNumber = 0; pageNumber < PLUGIN_CRON_CLEANUP_MAX_PAGES; pageNumber += 1) {
    const page = readCanonicalCronListPage<CronJob>(
      await cron.listPage({
        includeDisabled: true,
        limit: PLUGIN_CRON_CLEANUP_PAGE_SIZE,
        offset,
        query,
        sortBy: "name",
        sortDir: "asc",
      }),
      PLUGIN_CRON_CLEANUP_PAGE_SIZE,
    );
    const nextOffset = resolveCronListPageNextOffset(page, offset);
    jobs.push(...page.jobs);
    if (nextOffset === null) {
      return jobs;
    }
    offset = nextOffset;
  }
  throw new Error("cron.list pagination exceeded maximum pages");
}

/**
 * Builds the cron owner, account policy and requester provenance for a requester-scoped turn.
 * Returns undefined when no requester was given and null when the requester is unusable.
 */
function resolveRequesterAuthority(params: {
  sessionKey: string;
  requester: PluginSessionTurnScheduleParams["requester"];
  hasToolsAllow: boolean;
}):
  | { owner: { sessionKey: string; accountId: string }; options: CronAddOptions }
  | null
  | undefined {
  if (params.requester === undefined) {
    return undefined;
  }
  const channelRequester = normalizeCronAuthenticatedChannelRequester({
    version: 1,
    channel: params.requester.channel,
    accountId: params.requester.accountId,
    senderId: params.requester.senderId,
  });
  // Cron only honours requester provenance on jobs whose tools are capped.
  if (!channelRequester || !params.hasToolsAllow) {
    return null;
  }
  const scheduledToolPolicy = createAccountCronScheduledToolPolicy({
    ownerSessionKey: params.sessionKey,
    ownerAccountId: channelRequester.accountId,
  });
  if (!scheduledToolPolicy) {
    return null;
  }
  return {
    owner: { sessionKey: params.sessionKey, accountId: channelRequester.accountId },
    options: {
      scheduledToolPolicy,
      toolsAllowProvenance: {
        version: 1,
        source: "authenticated-requester",
        channelRequester,
      },
    },
  };
}

export async function schedulePluginSessionTurn(params: {
  pluginId: string;
  pluginName?: string;
  origin?: PluginOrigin;
  schedule: PluginSessionTurnScheduleParams;
  shouldCommit?: () => boolean;
  cron?: CronServiceContract;
  ownerRegistry?: PluginRegistry;
}): Promise<PluginSessionSchedulerJobHandle | undefined> {
  if (params.origin !== "bundled") {
    return undefined;
  }
  const sessionKey = normalizeOptionalString(params.schedule.sessionKey);
  const message = normalizeOptionalString(params.schedule.message);
  if (!sessionKey || !message) {
    return undefined;
  }
  const cronSchedule = resolveSchedule(params.schedule);
  if (!cronSchedule) {
    return undefined;
  }
  const deliveryMode: unknown = params.schedule.deliveryMode;
  const scheduleName = normalizeOptionalString(params.schedule.name);
  const logSchedulingFailure = (reason: string, name = scheduleName) => {
    log.warn(
      `plugin session turn scheduling failed (${formatScheduleLogContext({
        pluginId: params.pluginId,
        sessionKey,
        ...(name ? { name } : {}),
      })}): ${reason}`,
    );
  };
  if (deliveryMode !== undefined && deliveryMode !== "none" && deliveryMode !== "announce") {
    logSchedulingFailure("unsupported deliveryMode");
    return undefined;
  }
  if (cronSchedule.kind === "cron" && params.schedule.deleteAfterRun === true) {
    logSchedulingFailure("deleteAfterRun requires a one-shot schedule");
    return undefined;
  }
  const { tag, invalid: invalidTag } = resolvePluginSessionTurnTag(params.schedule.tag);
  if (invalidTag) {
    logSchedulingFailure('tag contains reserved delimiter ":"');
    return undefined;
  }
  const cronDeliveryMode = deliveryMode ?? "announce";
  if (params.shouldCommit && !params.shouldCommit()) {
    return undefined;
  }
  if (!params.cron) {
    logSchedulingFailure("cron service unavailable");
    return undefined;
  }
  const cron = params.cron;
  const cronJobName = buildPluginSchedulerCronName({
    pluginId: params.pluginId,
    sessionKey,
    ...(tag !== undefined ? { tag } : {}),
    ...(scheduleName ? { uniqueId: scheduleName } : {}),
  });
  const toolsAllow = params.schedule.toolsAllow;
  const cronPayload: CronJobCreate["payload"] = {
    kind: "agentTurn",
    message,
    ...(toolsAllow ? { toolsAllow: [...toolsAllow] } : {}),
  };
  const requesterAuthority = resolveRequesterAuthority({
    sessionKey,
    requester: params.schedule.requester,
    hasToolsAllow: toolsAllow !== undefined,
  });
  if (requesterAuthority === null) {
    logSchedulingFailure("requester needs channel, accountId, senderId and toolsAllow");
    return undefined;
  }
  let result: Awaited<ReturnType<CronServiceContract["add"]>>;
  try {
    const cronJob: CronJobCreate = {
      name: cronJobName,
      enabled: true,
      schedule: cronSchedule,
      sessionTarget: `session:${sessionKey}`,
      payload: cronPayload,
      ...(params.schedule.agentId ? { agentId: params.schedule.agentId } : {}),
      deleteAfterRun: params.schedule.deleteAfterRun ?? cronSchedule.kind === "at",
      wakeMode: "now",
      delivery: {
        mode: cronDeliveryMode,
        ...(cronDeliveryMode === "announce" ? { channel: "last" } : {}),
      },
      ...(requesterAuthority ? { owner: requesterAuthority.owner } : {}),
    };
    result = requesterAuthority
      ? await cron.add(cronJob, requesterAuthority.options)
      : await cron.add(cronJob);
  } catch (error) {
    logSchedulingFailure(formatErrorMessage(error), cronJobName);
    return undefined;
  }
  const jobId = result.id;
  if (!jobId) {
    return undefined;
  }
  if (params.shouldCommit && !params.shouldCommit()) {
    const removed = await removeScheduledSessionTurn({
      cron,
      jobId,
      pluginId: params.pluginId,
      sessionKey,
      name: cronJobName,
    });
    if (!removed) {
      log.warn(
        `plugin session turn scheduling rollback failed (${formatScheduleLogContext({
          pluginId: params.pluginId,
          sessionKey,
          name: cronJobName,
          jobId,
        })}): failed to remove stale scheduled session turn`,
      );
    }
    return undefined;
  }
  if (params.schedule.keepOnSessionReset === true) {
    // Not registered for session cleanup, so a session reset leaves the job in Cron.
    return { id: jobId, pluginId: params.pluginId, sessionKey, kind: "session-turn" };
  }
  return registerPluginSessionSchedulerJob({
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    ownerRegistry: params.ownerRegistry,
    job: {
      id: jobId,
      sessionKey,
      kind: "session-turn",
      cleanup: async () => {
        const removed = await removeScheduledSessionTurn({
          cron,
          jobId,
          pluginId: params.pluginId,
          sessionKey,
          name: cronJobName,
        });
        if (!removed) {
          throw new Error(`failed to remove scheduled session turn: ${jobId}`);
        }
      },
    },
  });
}

export async function unschedulePluginSessionTurnsByTag(params: {
  pluginId: string;
  origin?: PluginOrigin;
  cron?: CronServiceContract;
  request: PluginSessionTurnUnscheduleByTagParams;
}): Promise<PluginSessionTurnUnscheduleByTagResult> {
  if (params.origin !== "bundled") {
    return { removed: 0, failed: 0 };
  }
  const sessionKey = normalizeOptionalString(params.request.sessionKey);
  const { tag, invalid: invalidTag } = resolvePluginSessionTurnTag(params.request.tag);
  if (!sessionKey || !tag || invalidTag) {
    return { removed: 0, failed: 0 };
  }
  if (!params.cron) {
    log.warn("plugin session turn untag-list failed: cron service unavailable");
    return { removed: 0, failed: 1 };
  }
  const cron = params.cron;
  const namePrefix = buildPluginSchedulerTagPrefix({
    pluginId: params.pluginId,
    tag,
    sessionKey,
  });
  let jobs: CronJob[];
  try {
    jobs = await listAllCronJobsForPluginTagCleanup(cron, namePrefix);
  } catch (error) {
    log.warn(`plugin session turn untag-list failed: ${formatErrorMessage(error)}`);
    return { removed: 0, failed: 1 };
  }
  const candidates = jobs.filter(
    (job) => job.name.startsWith(namePrefix) && job.sessionTarget === `session:${sessionKey}`,
  );
  let removed = 0;
  let failed = 0;
  for (const job of candidates) {
    const id = job.id.trim();
    if (!id) {
      continue;
    }
    try {
      const result = await cron.remove(id);
      if (isCronRemoveResult(result) && result.ok && result.removed) {
        removed += 1;
        deletePluginSessionSchedulerJob({
          pluginId: params.pluginId,
          jobId: id,
          sessionKey,
        });
      } else {
        failed += 1;
      }
    } catch (error) {
      log.warn(
        `plugin session turn untag-remove failed: id=${id} error=${formatErrorMessage(error)}`,
      );
      failed += 1;
    }
  }
  return { removed, failed };
}

function readPluginSchedulerTag(name: string, pluginId: string): string | undefined {
  const prefix = `${PLUGIN_CRON_NAME_PREFIX}${pluginId}${PLUGIN_CRON_TAG_MARKER}`;
  if (!name.startsWith(prefix)) {
    return undefined;
  }
  const tag = name.slice(prefix.length).split(PLUGIN_CRON_RESERVED_DELIMITER, 1)[0];
  return tag || undefined;
}

function toPluginScheduledSessionTurn(
  job: CronJob,
  pluginId: string,
): PluginScheduledSessionTurn | undefined {
  if (job.payload.kind !== "agentTurn") {
    return undefined;
  }
  const schedule: PluginScheduledSessionTurn["schedule"] =
    job.schedule.kind === "at"
      ? { kind: "at", at: job.schedule.at }
      : job.schedule.kind === "cron"
        ? {
            kind: "cron",
            expr: job.schedule.expr,
            ...(job.schedule.tz ? { tz: job.schedule.tz } : {}),
          }
        : { kind: "other" };
  const tag = readPluginSchedulerTag(job.name, pluginId);
  return {
    id: job.id,
    ...(tag ? { tag } : {}),
    message: job.payload.message,
    schedule,
    enabled: job.enabled,
    ...(job.state.nextRunAtMs !== undefined ? { nextRunAtMs: job.state.nextRunAtMs } : {}),
  };
}

/** Lists the calling plugin's Cron-backed turns for one session, tagged or not. */
export async function listPluginSessionTurns(params: {
  pluginId: string;
  origin?: PluginOrigin;
  cron?: CronServiceContract;
  request: PluginSessionTurnListParams;
}): Promise<PluginScheduledSessionTurn[]> {
  if (params.origin !== "bundled") {
    return [];
  }
  const sessionKey = normalizeOptionalString(params.request.sessionKey);
  if (!sessionKey) {
    return [];
  }
  if (!params.cron) {
    log.warn("plugin session turn list failed: cron service unavailable");
    return [];
  }
  const namePrefix = `${PLUGIN_CRON_NAME_PREFIX}${params.pluginId}:`;
  const jobs = await listAllCronJobsForPluginTagCleanup(params.cron, namePrefix);
  // The session key is matched on the job target; names only scope the plugin.
  return jobs.flatMap((job) => {
    if (!job.name.startsWith(namePrefix) || job.sessionTarget !== `session:${sessionKey}`) {
      return [];
    }
    const turn = toPluginScheduledSessionTurn(job, params.pluginId);
    return turn ? [turn] : [];
  });
}
