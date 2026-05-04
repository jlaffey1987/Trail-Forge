import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useUser } from "@clerk/react";
import {
  type ChatRoom,
  fetchChatRooms,
  archiveRoom,
  connectChatStream,
  fetchBlockList,
  unblockUser,
  type BlockedUser,
} from "@/lib/chat";

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ChatInboxPage() {
  const { isSignedIn } = useUser();
  const [, setLocation] = useLocation();
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [showBlocked, setShowBlocked] = useState(false);
  const [blocks, setBlocks] = useState<BlockedUser[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const disconnectRef = useRef<(() => void) | null>(null);

  const loadRooms = useCallback(async () => {
    if (!isSignedIn) return;
    setLoading(true);
    const data = await fetchChatRooms();
    setRooms(data);
    setLoading(false);
  }, [isSignedIn]);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  useEffect(() => {
    if (!isSignedIn) return;

    disconnectRef.current = connectChatStream(
      (event) => {
        if (event.type === "new_message") {
          void loadRooms();
        }
      },
    );

    return () => {
      disconnectRef.current?.();
      disconnectRef.current = null;
    };
  }, [isSignedIn, loadRooms]);

  const handleArchive = async (roomId: string) => {
    const ok = await archiveRoom(roomId);
    if (ok) void loadRooms();
  };

  const loadBlocks = async () => {
    setBlocksLoading(true);
    const data = await fetchBlockList();
    setBlocks(data);
    setBlocksLoading(false);
  };

  const handleUnblock = async (userId: string) => {
    await unblockUser(userId);
    void loadBlocks();
  };

  const activeRooms = rooms.filter((r) => !r.archived);
  const archivedRooms = rooms.filter((r) => r.archived);

  if (!isSignedIn) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 text-center">
        <p className="text-stone-400 text-sm">Sign in to use messages</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="chat-inbox">
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-[hsl(30,12%,14%)]">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLocation("/")}
            className="text-stone-400 hover:text-stone-200"
            data-testid="chat-inbox-back"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-base font-bold text-amber-400 uppercase tracking-widest">Messages</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setShowBlocked(!showBlocked);
              if (!showBlocked) void loadBlocks();
            }}
            className="text-[10px] text-stone-500 hover:text-stone-300 uppercase tracking-wider"
            data-testid="chat-inbox-blocks-toggle"
          >
            {showBlocked ? "Inbox" : "Blocked"}
          </button>
        </div>
      </div>

      {showBlocked ? (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <h2 className="text-xs font-semibold text-stone-400 uppercase tracking-wider mb-3">Blocked Users</h2>
          {blocksLoading ? (
            <div className="flex justify-center py-10">
              <div className="w-6 h-6 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
            </div>
          ) : blocks.length === 0 ? (
            <p className="text-stone-500 text-xs text-center py-10">No blocked users</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {blocks.map((b) => (
                <li
                  key={b.user_id}
                  className="flex items-center gap-3 rounded-xl border border-[hsl(30,12%,18%)] bg-[hsl(22,15%,11%)] px-3 py-2.5"
                >
                  {b.avatar_url ? (
                    <img src={b.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover bg-stone-800" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-stone-700 text-stone-400 text-xs font-bold flex items-center justify-center">
                      {(b.display_name?.[0] ?? "?").toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-stone-200 truncate">{b.display_name ?? "Unknown"}</p>
                  </div>
                  <button
                    onClick={() => void handleUnblock(b.user_id)}
                    className="text-[10px] text-amber-400 hover:text-amber-300 font-semibold uppercase tracking-wider"
                  >
                    Unblock
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-10">
              <div className="w-6 h-6 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
            </div>
          ) : activeRooms.length === 0 && archivedRooms.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
              <svg viewBox="0 0 24 24" className="w-10 h-10 text-stone-600 mb-3" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
              <p className="text-stone-500 text-sm mb-1">No conversations yet</p>
              <p className="text-stone-600 text-xs">Join a group to start chatting with other riders</p>
            </div>
          ) : (
            <div className="px-3 py-2">
              <ul className="flex flex-col gap-1" data-testid="chat-room-list">
                {activeRooms.map((room) => (
                  <RoomRow
                    key={room.id}
                    room={room}
                    onOpen={() => setLocation(`/messages/${room.id}`)}
                    onArchive={room.kind === "dm" ? () => void handleArchive(room.id) : undefined}
                  />
                ))}
              </ul>

              {archivedRooms.length > 0 && (
                <div className="mt-4">
                  <button
                    onClick={() => setShowArchived(!showArchived)}
                    className="w-full text-[10px] text-stone-500 hover:text-stone-300 uppercase tracking-wider py-2 text-center"
                  >
                    {showArchived ? "Hide archived" : `Archived (${archivedRooms.length})`}
                  </button>
                  {showArchived && (
                    <ul className="flex flex-col gap-1 mt-1 opacity-60">
                      {archivedRooms.map((room) => (
                        <RoomRow
                          key={room.id}
                          room={room}
                          onOpen={() => setLocation(`/messages/${room.id}`)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RoomRow({
  room,
  onOpen,
  onArchive,
}: {
  room: ChatRoom;
  onOpen: () => void;
  onArchive?: () => void;
}) {
  const [showMenu, setShowMenu] = useState(false);

  const avatarChar = (room.name?.[0] ?? "?").toUpperCase();
  const isGroup = room.kind === "group";

  return (
    <li className="relative">
      <button
        onClick={onOpen}
        className={`w-full text-left flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${
          room.unread_count > 0
            ? "bg-amber-500/[0.06] hover:bg-amber-500/[0.10]"
            : "bg-[hsl(22,15%,10%)] hover:bg-[hsl(22,15%,13%)]"
        }`}
        data-testid={`chat-room-${room.id}`}
      >
        {room.avatar_url ? (
          <img src={room.avatar_url} alt="" className="w-10 h-10 rounded-full shrink-0 object-cover bg-stone-800" />
        ) : (
          <div
            className={`w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-sm font-bold ${
              isGroup
                ? "bg-amber-500/20 text-amber-300"
                : "bg-stone-700 text-stone-300"
            }`}
          >
            {isGroup ? (
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            ) : (
              avatarChar
            )}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className={`text-sm truncate ${room.unread_count > 0 ? "text-stone-100 font-semibold" : "text-stone-300"}`}>
              {room.name ?? "Chat"}
            </p>
            {room.last_message && (
              <span className="text-[10px] text-stone-500 shrink-0">
                {relativeTime(room.last_message.created_at)}
              </span>
            )}
          </div>
          {room.last_message && (
            <p className="text-xs text-stone-500 truncate mt-0.5">
              {room.last_message.body}
            </p>
          )}
        </div>
        {room.unread_count > 0 && (
          <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-amber-500 text-stone-900 text-[10px] font-bold flex items-center justify-center shrink-0">
            {room.unread_count > 99 ? "99+" : room.unread_count}
          </span>
        )}
      </button>
      {onArchive && (
        <div className="absolute right-1 top-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu(!showMenu);
            }}
            className="p-1 text-stone-600 hover:text-stone-400"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
              <circle cx="12" cy="5" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>
          {showMenu && (
            <div className="absolute right-0 top-6 z-10 bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,22%)] rounded-lg shadow-lg py-1 min-w-[100px]">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(false);
                  onArchive();
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-stone-300 hover:bg-[hsl(22,15%,18%)]"
              >
                Archive
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
