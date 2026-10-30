import { describe, expect, it, vi } from "vitest";
import { createRemindersTool } from "./reminders-tool.js";

const SESSION_KEY = "agent:main:whatsapp:default:direct:+15550000001";

function setup(
  overrides: { sessionKey?: string; requesterSenderId?: string; taskToolsAllow?: string[] } = {},
) {
  const workflow = {
    scheduleSessionTurn: vi.fn(async (params: { sessionKey: string }) => ({
      id: "job-1",
      pluginId: "artha-reminders",
      sessionKey: params.sessionKey,
      kind: "session-turn",
    })),
    unscheduleSessionTurnsByTag: vi.fn(async () => ({ removed: 1, failed: 0 })),
    listSessionTurns: vi.fn(async () => []),
  };
  const tool = createRemindersTool({
    workflow: workflow as never,
    sessionKey: SESSION_KEY,
    requesterSenderId: "+15550000001",
    messageChannel: "whatsapp",
    agentAccountId: "default",
    ...overrides,
  });
  const run = async (params: Record<string, unknown>) =>
    (await tool.execute("call-1", params as never)).details as Record<string, unknown>;
  return { workflow, run };
}

describe("my_reminders", () => {
  it("schedules a one-time reminder in the caller's session with no tools", async () => {
    const { workflow, run } = setup();
    const result = await run({
      action: "add",
      text: "Send MIS report",
      at: "2999-01-01T10:00:00+05:30",
    });

    expect(result.ok).toBe(true);
    const schedule = workflow.scheduleSessionTurn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(schedule).toMatchObject({
      sessionKey: SESSION_KEY,
      at: "2999-01-01T10:00:00+05:30",
      deliveryMode: "announce",
      keepOnSessionReset: true,
      toolsAllow: [],
      tag: result.id,
    });
    expect(schedule.message).toContain("Send MIS report");
  });

  it("schedules a task that runs as the requester with only the task tools", async () => {
    const { workflow, run } = setup();
    const result = await run({
      action: "add",
      kind: "task",
      text: "List my pending DFS reviews",
      cron: "0 10 * * 1",
    });

    expect(result).toMatchObject({ ok: true, kind: "task" });
    const schedule = workflow.scheduleSessionTurn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(schedule).toMatchObject({
      sessionKey: SESSION_KEY,
      keepOnSessionReset: true,
      toolsAllow: ["artha-dfs-production__*"],
      requester: { channel: "whatsapp", accountId: "default", senderId: "+15550000001" },
    });
    expect(schedule.message).toContain("List my pending DFS reviews");
  });

  it("keeps reminders free of requester identity and tools", async () => {
    const { workflow, run } = setup({ taskToolsAllow: ["x__*"] });
    await run({ action: "add", text: "Call back", at: "2999-01-01T10:00:00+05:30" });

    const schedule = workflow.scheduleSessionTurn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(schedule.toolsAllow).toEqual([]);
    expect(schedule).not.toHaveProperty("requester");
  });

  it("defaults repeating reminders to Asia/Kolkata", async () => {
    const { workflow, run } = setup();
    await run({ action: "add", text: "Standup", cron: "0 10 * * 1-5" });

    expect(workflow.scheduleSessionTurn.mock.calls[0]?.[0]).toMatchObject({
      cron: "0 10 * * 1-5",
      tz: "Asia/Kolkata",
    });
  });

  it("refuses group chats and calls without a trusted sender", async () => {
    const group = setup({ sessionKey: "agent:main:whatsapp:default:group:123@g.us" });
    expect((await group.run({ action: "list" })).ok).toBe(false);
    const noSender = setup({ requesterSenderId: undefined });
    expect((await noSender.run({ action: "list" })).ok).toBe(false);
    expect(group.workflow.listSessionTurns).not.toHaveBeenCalled();
    expect(noSender.workflow.listSessionTurns).not.toHaveBeenCalled();
  });

  it("rejects past times and ambiguous schedules", async () => {
    const { workflow, run } = setup();
    expect((await run({ action: "add", text: "x", at: "2000-01-01T00:00:00Z" })).ok).toBe(false);
    expect((await run({ action: "add", text: "x" })).ok).toBe(false);
    expect(
      (await run({ action: "add", text: "x", at: "2999-01-01T00:00:00Z", cron: "* * * * *" })).ok,
    ).toBe(false);
    expect(workflow.scheduleSessionTurn).not.toHaveBeenCalled();
  });

  it("lists reminders with their original text", async () => {
    const { workflow, run } = setup();
    workflow.listSessionTurns.mockResolvedValueOnce([
      {
        id: "job-1",
        tag: "r1a2b3c4d",
        message: "instruction\n\nReminder text:\nPay rent",
        schedule: { kind: "cron", expr: "0 9 1 * *", tz: "Asia/Kolkata" },
        enabled: true,
        nextRunAtMs: Date.UTC(2026, 10, 1, 3, 30),
      },
    ] as never);

    expect(await run({ action: "list" })).toEqual({
      ok: true,
      reminders: [
        {
          id: "r1a2b3c4d",
          kind: "reminder",
          text: "Pay rent",
          schedule: 'repeats "0 9 1 * *" (Asia/Kolkata)',
          nextRun: "2026-11-01T03:30:00.000Z",
        },
      ],
    });
    expect(workflow.listSessionTurns).toHaveBeenCalledWith({ sessionKey: SESSION_KEY });
  });

  it("deletes only by a well-formed id inside the caller's session", async () => {
    const { workflow, run } = setup();
    expect((await run({ action: "delete", id: "bad:id" })).ok).toBe(false);
    expect((await run({ action: "delete", id: "r1a2b3c4d" })).ok).toBe(true);
    expect(workflow.unscheduleSessionTurnsByTag).toHaveBeenCalledTimes(1);
    expect(workflow.unscheduleSessionTurnsByTag).toHaveBeenCalledWith({
      sessionKey: SESSION_KEY,
      tag: "r1a2b3c4d",
    });
  });
});
