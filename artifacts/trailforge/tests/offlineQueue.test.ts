import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";

vi.mock("@/lib/supabase", () => ({
  supabase: {},
}));

const offlineStore = await import("@/lib/offlineStore");
const { registerOfflineHandler, queueOfflineAction, replayQueue, getQueueLength, clearQueue } = await import("@/lib/offlineQueue");

describe("offlineQueue", () => {
  beforeEach(async () => {
    await clearQueue();
  });

  it("queues and replays actions", async () => {
    const handler = vi.fn().mockResolvedValue(true);
    registerOfflineHandler("test-action", handler);

    await queueOfflineAction("test-action", { key: "value" });
    const len = await getQueueLength();
    expect(len).toBe(1);

    const result = await replayQueue();
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("reports failures and retries", async () => {
    const handler = vi.fn().mockResolvedValue(false);
    registerOfflineHandler("fail-action", handler);

    await queueOfflineAction("fail-action", { key: "value" });

    const result = await replayQueue();
    expect(result.failed).toBe(1);
    expect(result.remaining).toBe(1);
  });

  it("removes actions after max retries", async () => {
    const handler = vi.fn().mockResolvedValue(false);
    registerOfflineHandler("expire-action", handler);

    await queueOfflineAction("expire-action", { key: "value" });

    for (let i = 0; i < 5; i++) {
      await replayQueue();
    }

    const len = await getQueueLength();
    expect(len).toBe(0);
  });

  it("clearQueue removes all actions", async () => {
    await queueOfflineAction("test-action", { a: 1 });
    await queueOfflineAction("test-action", { b: 2 });
    expect(await getQueueLength()).toBe(2);
    await clearQueue();
    expect(await getQueueLength()).toBe(0);
  });
});
