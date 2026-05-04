import {
  enqueueAction,
  getQueuedActions,
  removeQueuedAction,
  updateQueuedAction,
  type QueuedAction,
} from "@/lib/offlineStore";

const MAX_RETRIES = 5;
let replaying = false;

type ReplayHandler = (
  action: QueuedAction,
) => Promise<boolean>;

const handlers = new Map<string, ReplayHandler>();

export function registerOfflineHandler(
  type: string,
  handler: ReplayHandler,
): void {
  handlers.set(type, handler);
}

export async function queueOfflineAction(
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await enqueueAction({ type, payload });
}

export async function replayQueue(): Promise<{
  succeeded: number;
  failed: number;
  remaining: number;
}> {
  if (replaying) return { succeeded: 0, failed: 0, remaining: 0 };
  replaying = true;

  try {
    const actions = await getQueuedActions();
    let succeeded = 0;
    let failed = 0;

    for (const action of actions) {
      const handler = handlers.get(action.type);
      if (!handler) {
        action.retries++;
        if (action.retries >= MAX_RETRIES) {
          await removeQueuedAction(action.id);
        } else {
          await updateQueuedAction(action);
        }
        failed++;
        continue;
      }
      try {
        const ok = await handler(action);
        if (ok) {
          await removeQueuedAction(action.id);
          succeeded++;
        } else {
          action.retries++;
          if (action.retries >= MAX_RETRIES) {
            await removeQueuedAction(action.id);
          } else {
            await updateQueuedAction(action);
          }
          failed++;
        }
      } catch {
        action.retries++;
        if (action.retries >= MAX_RETRIES) {
          await removeQueuedAction(action.id);
        } else {
          await updateQueuedAction(action);
        }
        failed++;
      }
    }

    const remaining = (await getQueuedActions()).length;
    return { succeeded, failed, remaining };
  } finally {
    replaying = false;
  }
}

export async function getQueueLength(): Promise<number> {
  return (await getQueuedActions()).length;
}

export async function clearQueue(): Promise<void> {
  const actions = await getQueuedActions();
  for (const a of actions) {
    await removeQueuedAction(a.id);
  }
}
