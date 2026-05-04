export interface ChatRoom {
  id: string;
  kind: "group" | "dm";
  group_id: string | null;
  name: string | null;
  avatar_url: string | null;
  other_user_id: string | null;
  unread_count: number;
  archived: boolean;
  last_message: {
    id: string;
    sender_user_id: string;
    body: string;
    created_at: string;
  } | null;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  room_id: string;
  sender_user_id: string;
  sender_display_name: string | null;
  sender_avatar_url: string | null;
  body: string | null;
  created_at: string;
  deleted: boolean;
  blocked: boolean;
}

export interface BlockedUser {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    if (!res.ok) {
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Forbidden");
      }
      if (res.status === 429) {
        throw new Error("Too many messages. Please wait a moment.");
      }
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && (err.message.includes("Forbidden") || err.message.includes("Too many") || err.message.includes("Cannot"))) {
      throw err;
    }
    console.error(`[chat] ${url} fetch error`, err);
    return null;
  }
}

export async function fetchChatRooms(): Promise<ChatRoom[]> {
  const data = await jsonFetch<{ rooms: ChatRoom[] }>("/api/chat/rooms");
  return data?.rooms ?? [];
}

export async function fetchMessages(
  roomId: string,
  opts?: { before?: string; limit?: number },
): Promise<{ messages: ChatMessage[]; hasMore: boolean; userRole: string }> {
  const params = new URLSearchParams();
  if (opts?.before) params.set("before", opts.before);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const data = await jsonFetch<{ messages: ChatMessage[]; hasMore: boolean; userRole: string }>(
    `/api/chat/rooms/${roomId}/messages${qs ? `?${qs}` : ""}`,
  );
  return data ?? { messages: [], hasMore: false, userRole: "member" };
}

export async function sendMessage(
  roomId: string,
  body: string,
): Promise<ChatMessage | null> {
  return jsonFetch<ChatMessage>(`/api/chat/rooms/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function deleteMessage(messageId: string): Promise<boolean> {
  const data = await jsonFetch<{ ok: boolean }>(`/api/chat/messages/${messageId}`, {
    method: "DELETE",
  });
  return !!data?.ok;
}

export async function openDm(userId: string): Promise<string | null> {
  const data = await jsonFetch<{ room_id: string }>(`/api/chat/dm/${userId}/open`, {
    method: "POST",
  });
  return data?.room_id ?? null;
}

export async function markRoomRead(roomId: string): Promise<void> {
  await jsonFetch<{ ok: boolean }>(`/api/chat/rooms/${roomId}/read`, {
    method: "POST",
  });
}

export async function archiveRoom(roomId: string): Promise<boolean> {
  const data = await jsonFetch<{ ok: boolean }>(`/api/chat/rooms/${roomId}/archive`, {
    method: "POST",
  });
  return !!data?.ok;
}

export async function blockUser(userId: string): Promise<boolean> {
  const data = await jsonFetch<{ ok: boolean }>(`/api/users/${userId}/block`, {
    method: "POST",
  });
  return !!data?.ok;
}

export async function unblockUser(userId: string): Promise<boolean> {
  const data = await jsonFetch<{ ok: boolean }>(`/api/users/${userId}/block`, {
    method: "DELETE",
  });
  return !!data?.ok;
}

export async function fetchBlockList(): Promise<BlockedUser[]> {
  const data = await jsonFetch<{ blocks: BlockedUser[] }>("/api/users/me/blocks");
  return data?.blocks ?? [];
}

export async function fetchUnreadCount(): Promise<number> {
  const data = await jsonFetch<{ count: number }>("/api/chat/unread-count");
  return data?.count ?? 0;
}

export type SSEEvent =
  | { type: "new_message"; data: ChatMessage }
  | { type: "message_deleted"; data: { id: string; room_id: string } }
  | { type: "room_read"; data: { room_id: string; user_id: string; read_at: string } }
  | { type: "connected"; data: { userId: string } };

export function connectChatStream(
  onEvent: (event: SSEEvent) => void,
  onError?: () => void,
): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  function startSSE() {
    if (closed) return;
    try {
      es = new EventSource("/api/chat/stream", { withCredentials: true });

      es.addEventListener("connected", () => {});

      es.addEventListener("new_message", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          onEvent({ type: "new_message", data });
        } catch { /* ignore parse errors */ }
      });

      es.addEventListener("message_deleted", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          onEvent({ type: "message_deleted", data });
        } catch { /* ignore */ }
      });

      es.addEventListener("room_read", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          onEvent({ type: "room_read", data });
        } catch { /* ignore */ }
      });

      es.onerror = () => {
        if (closed) return;
        es?.close();
        es = null;
        startPolling();
        onError?.();
      };
    } catch {
      startPolling();
    }
  }

  let lastPollRooms: ChatRoom[] = [];
  async function poll() {
    if (closed) return;
    try {
      const rooms = await fetchChatRooms();
      for (const room of rooms) {
        if (room.last_message) {
          const prev = lastPollRooms.find((r) => r.id === room.id);
          if (!prev?.last_message || prev.last_message.id !== room.last_message.id) {
            onEvent({
              type: "new_message",
              data: {
                id: room.last_message.id,
                room_id: room.id,
                sender_user_id: room.last_message.sender_user_id,
                sender_display_name: null,
                sender_avatar_url: null,
                body: room.last_message.body,
                created_at: room.last_message.created_at,
                deleted: false,
                blocked: false,
              },
            });
          }
        }
      }
      lastPollRooms = rooms;
    } catch { /* ignore poll errors */ }
  }

  function startPolling() {
    if (pollInterval || closed) return;
    pollInterval = setInterval(() => void poll(), 5000);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  startSSE();

  return () => {
    closed = true;
    es?.close();
    es = null;
    stopPolling();
  };
}
