/**
 * Tiny `react-native-sse` wrapper used by the Messages thread to surface
 * new messages without polling. The web app talks to the same
 * `/api/chat/stream` endpoint via the browser's native EventSource — we
 * don't have that polyfilled in React Native, so we lean on
 * `react-native-sse` (a JS-only library).
 */
import EventSource from "react-native-sse";

import { apiBaseUrl } from "@/lib/api";

export interface ChatStreamMessage {
  type: "message" | "typing" | "ping";
  roomId?: string;
  message?: {
    id: string;
    room_id: string;
    author_id: string;
    body: string;
    created_at: string;
  };
}

export interface ChatStreamHandle {
  close(): void;
}

export function openChatStream(
  bearer: string,
  onEvent: (evt: ChatStreamMessage) => void,
  onError?: (err: unknown) => void,
): ChatStreamHandle {
  const url = `${apiBaseUrl()}/api/chat/stream`;
  const source = new EventSource(url, {
    headers: { Authorization: `Bearer ${bearer}` },
    pollingInterval: 0,
  });

  source.addEventListener("message", (e) => {
    try {
      // `react-native-sse` sometimes hands back `null` data for keep-alive
      // comments (`: ping`). Skip those instead of throwing.
      const raw = (e as { data?: string }).data;
      if (!raw) return;
      const parsed = JSON.parse(raw) as ChatStreamMessage;
      onEvent(parsed);
    } catch (err) {
      onError?.(err);
    }
  });
  source.addEventListener("error", (err) => {
    onError?.(err);
  });

  return {
    close() {
      try {
        source.close();
      } catch {
        // ignore
      }
    },
  };
}
