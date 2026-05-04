import { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/react";
import { useLocation } from "wouter";
import { fetchUnreadCount, connectChatStream } from "@/lib/chat";

const POLL_MS = 60_000;

export default function ChatMessagesBadge() {
  const { isSignedIn, isLoaded } = useUser();
  const [unread, setUnread] = useState(0);
  const [, setLocation] = useLocation();
  const disconnectRef = useRef<(() => void) | null>(null);

  const refreshCount = useCallback(async () => {
    if (!isSignedIn) {
      setUnread(0);
      return;
    }
    const count = await fetchUnreadCount();
    setUnread(count);
  }, [isSignedIn]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      setUnread(0);
      return;
    }
    void refreshCount();
    const id = window.setInterval(() => void refreshCount(), POLL_MS);
    return () => window.clearInterval(id);
  }, [isLoaded, isSignedIn, refreshCount]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;

    disconnectRef.current = connectChatStream(
      (event) => {
        if (event.type === "new_message" || event.type === "room_read" || event.type === "message_deleted") {
          void refreshCount();
        }
      },
      () => {},
    );

    return () => {
      disconnectRef.current?.();
      disconnectRef.current = null;
    };
  }, [isLoaded, isSignedIn, refreshCount]);

  if (!isSignedIn) return null;

  const display = unread > 99 ? "99+" : String(unread);

  return (
    <button
      onClick={() => setLocation("/messages")}
      className="relative flex items-center justify-center bg-[hsl(22,15%,14%)] hover:bg-[hsl(22,15%,18%)] border border-[hsl(30,12%,20%)] rounded-full w-7 h-7 transition-colors"
      title={unread > 0 ? `${unread} unread messages` : "Messages"}
      data-testid="chat-messages-badge"
      aria-label="Chat messages"
    >
      <svg
        viewBox="0 0 24 24"
        className="w-3.5 h-3.5 text-stone-300"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
      {unread > 0 && (
        <span
          className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-stone-900 text-[9px] font-bold flex items-center justify-center"
          data-testid="chat-unread-count"
        >
          {display}
        </span>
      )}
    </button>
  );
}
