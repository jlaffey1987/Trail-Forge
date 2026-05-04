import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useUser } from "@clerk/react";
import {
  type ChatMessage,
  fetchMessages,
  sendMessage,
  deleteMessage,
  markRoomRead,
  connectChatStream,
  blockUser,
} from "@/lib/chat";

function autoLinkUrls(text: string): (string | React.ReactNode)[] {
  const urlRegex = /(https?:\/\/[^\s<]+)/g;
  const parts: (string | React.ReactNode)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = match[1];
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-amber-400 underline hover:text-amber-300 break-all"
      >
        {url}
      </a>,
    );
    lastIndex = match.index + url.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

interface Props {
  roomId: string;
}

export default function ChatThreadPage({ roomId }: Props) {
  const { user } = useUser();
  const userId = user?.id ?? null;
  const [, setLocation] = useLocation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string>("member");
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const loadOlderSentinelRef = useRef<HTMLDivElement | null>(null);
  const disconnectRef = useRef<(() => void) | null>(null);
  const initialLoad = useRef(true);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: initialLoad.current ? "auto" : "smooth" });
  }, []);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    const data = await fetchMessages(roomId, { limit: 50 });
    setMessages(data.messages);
    setHasMore(data.hasMore);
    setUserRole(data.userRole);
    setLoading(false);
    await markRoomRead(roomId);
    setTimeout(() => {
      scrollToBottom();
      initialLoad.current = false;
    }, 50);
  }, [roomId, scrollToBottom]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    disconnectRef.current = connectChatStream(
      (event) => {
        if (event.type === "new_message" && event.data.room_id === roomId) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === event.data.id)) return prev;
            return [...prev, event.data];
          });
          void markRoomRead(roomId);
          setTimeout(scrollToBottom, 50);
        } else if (event.type === "message_deleted" && event.data.room_id === roomId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.data.id ? { ...m, deleted: true, body: null } : m,
            ),
          );
        }
      },
    );

    return () => {
      disconnectRef.current?.();
      disconnectRef.current = null;
    };
  }, [roomId, scrollToBottom]);

  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(false);

  const loadOlder = useCallback(async () => {
    if (!hasMoreRef.current || loadingMoreRef.current || messages.length === 0) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const container = scrollContainerRef.current;
    const prevHeight = container?.scrollHeight ?? 0;
    const oldest = messages[0];
    const data = await fetchMessages(roomId, { before: oldest.created_at, limit: 50 });
    setMessages((prev) => [...data.messages, ...prev]);
    setHasMore(data.hasMore);
    hasMoreRef.current = data.hasMore;
    setLoadingMore(false);
    loadingMoreRef.current = false;
    requestAnimationFrame(() => {
      if (container) {
        container.scrollTop = container.scrollHeight - prevHeight;
      }
    });
  }, [roomId, messages]);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  useEffect(() => {
    const sentinel = loadOlderSentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadOlder();
        }
      },
      { root: container, rootMargin: "200px 0px 0px 0px", threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadOlder]);

  const handleSend = async () => {
    const text = composerText.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const msg = await sendMessage(roomId, text);
      if (msg) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
        setComposerText("");
        setTimeout(scrollToBottom, 50);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    }
    setSending(false);
  };

  const handleDelete = async (messageId: string) => {
    try {
      const ok = await deleteMessage(messageId);
      if (ok) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId ? { ...m, deleted: true, body: null } : m,
          ),
        );
      } else {
        setError("Could not delete this message");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete message");
    }
    setDeleteConfirm(null);
  };

  const handleBlock = async (targetUserId: string) => {
    await blockUser(targetUserId);
    void loadMessages();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="chat-thread">
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-[hsl(30,12%,14%)]">
        <button
          onClick={() => setLocation("/messages")}
          className="text-stone-400 hover:text-stone-200"
          data-testid="chat-thread-back"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <h2 className="text-sm font-bold text-stone-200 truncate">Chat</h2>
      </div>

      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto px-3 py-3"
        data-testid="chat-messages-container"
      >
        {hasMore && (
          <div ref={loadOlderSentinelRef} className="flex justify-center mb-3" data-testid="chat-load-older">
            {loadingMore && (
              <div className="w-5 h-5 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
            )}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="w-6 h-6 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-stone-500 text-sm">No messages yet</p>
            <p className="text-stone-600 text-xs mt-1">Be the first to say something!</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {messages.map((msg, i) => {
              const isOwn = msg.sender_user_id === userId;
              const showSender =
                !isOwn &&
                (i === 0 || messages[i - 1].sender_user_id !== msg.sender_user_id);

              return (
                <div
                  key={msg.id}
                  className={`flex ${isOwn ? "justify-end" : "justify-start"} ${showSender ? "mt-2" : ""}`}
                  data-testid={`chat-message-${msg.id}`}
                >
                  <div className={`max-w-[80%] ${isOwn ? "items-end" : "items-start"} flex flex-col`}>
                    {showSender && !msg.deleted && !msg.blocked && (
                      <div className="flex items-center gap-1.5 mb-0.5 px-1">
                        {msg.sender_avatar_url ? (
                          <img
                            src={msg.sender_avatar_url}
                            alt=""
                            className="w-4 h-4 rounded-full object-cover"
                          />
                        ) : null}
                        <span className="text-[10px] text-stone-500 font-medium">
                          {msg.sender_display_name ?? "Rider"}
                        </span>
                      </div>
                    )}
                    {msg.deleted ? (
                      <div className="px-3 py-1.5 rounded-xl bg-stone-800/50 text-stone-600 text-xs italic">
                        (message removed)
                      </div>
                    ) : msg.blocked ? (
                      <div className="px-3 py-1.5 rounded-xl bg-stone-800/50 text-stone-600 text-xs italic flex items-center gap-2">
                        <span>(message hidden)</span>
                        <button
                          onClick={() => void handleBlock(msg.sender_user_id)}
                          className="text-[9px] text-red-400 hover:text-red-300 underline"
                        >
                          block
                        </button>
                      </div>
                    ) : (
                      <div
                        className={`group relative px-3 py-2 rounded-2xl text-sm leading-relaxed break-words ${
                          isOwn
                            ? "bg-amber-600/80 text-stone-100 rounded-br-md"
                            : "bg-[hsl(22,15%,14%)] text-stone-200 rounded-bl-md"
                        }`}
                      >
                        <div className="whitespace-pre-wrap">
                          {autoLinkUrls(msg.body ?? "")}
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-0.5">
                          <span className="text-[9px] opacity-50">
                            {new Date(msg.created_at).toLocaleTimeString(undefined, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                          {(isOwn || userRole === "owner" || userRole === "admin") && (
                            <button
                              onClick={() => setDeleteConfirm(msg.id)}
                              className="opacity-0 group-hover:opacity-100 text-[9px] text-stone-400 hover:text-red-400 transition-opacity"
                              title="Delete message"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {error && (
        <div className="shrink-0 px-4 py-2 bg-red-500/10 border-t border-red-500/30">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      <div className="shrink-0 border-t border-[hsl(30,12%,14%)] p-3 safe-bottom">
        <div className="flex items-end gap-2">
          <textarea
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            maxLength={2000}
            className="flex-1 resize-none rounded-xl border border-[hsl(30,12%,20%)] bg-[hsl(22,15%,12%)] text-sm text-stone-200 placeholder-stone-600 px-3 py-2 focus:outline-none focus:border-amber-500/40 max-h-24"
            data-testid="chat-composer-input"
          />
          <button
            onClick={() => void handleSend()}
            disabled={!composerText.trim() || sending}
            className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-colors disabled:opacity-30"
            style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
            data-testid="chat-send-button"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-stone-900" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <p className="text-[9px] text-stone-600 mt-1 text-right">
          {composerText.length}/2000
        </p>
      </div>

      {deleteConfirm && (
        <div
          className="fixed inset-0 z-[3100] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.7)" }}
        >
          <div className="bg-[hsl(22,15%,12%)] border border-[hsl(30,12%,20%)] rounded-2xl p-5 max-w-xs w-full mx-4">
            <p className="text-sm text-stone-200 mb-4">Delete this message?</p>
            <div className="flex gap-2">
              <button
                onClick={() => void handleDelete(deleteConfirm)}
                className="flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-red-400 border border-red-500/40 hover:bg-red-500/10"
                data-testid="chat-delete-confirm"
              >
                Delete
              </button>
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-stone-400 border border-stone-700 hover:bg-stone-700/30"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
