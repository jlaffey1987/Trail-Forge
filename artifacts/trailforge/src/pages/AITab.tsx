import { useState, useRef, useEffect, useCallback } from "react";
import { mapBboxStore } from "@/lib/mapBboxStore";

interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface GroundingTrail {
  id: string;
  name: string;
  difficulty: number | null;
  distance_km: number | null;
}

const QUICK_PROMPTS = [
  "Best trails for enduro beginners?",
  "What gear for Dartmoor?",
  "BOATs vs green lanes difference?",
  "Plan a weekend trip",
];

const WELCOME_MESSAGE =
  "Hey rider! I'm your TrailForge AI — expert in UK off-road motorcycle routes, BOATs, green lanes, and trail planning. I can see the trails on your current map, so feel free to ask 'which of these is best for a beginner?' too.";

function formatTime() {
  const now = new Date();
  return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";

  const renderContent = (content: string) => {
    return content.split("\n").map((line, i) => {
      const boldFormatted = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      return (
        <p
          key={i}
          className={i > 0 ? "mt-1" : ""}
          dangerouslySetInnerHTML={{ __html: boldFormatted }}
        />
      );
    });
  };

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-amber-600 to-amber-900 flex items-center justify-center shrink-0 mr-2 mt-0.5">
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-amber-200" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
          </svg>
        </div>
      )}
      <div className={`max-w-[78%] ${isUser ? "order-last" : ""}`}>
        <div
          className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
            isUser
              ? "bg-amber-500 text-stone-900 rounded-tr-sm"
              : "bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,20%)] text-stone-200 rounded-tl-sm"
          }`}
        >
          {renderContent(msg.content)}
        </div>
        <p className={`text-[10px] text-stone-600 mt-1 ${isUser ? "text-right" : "text-left"}`}>
          {msg.timestamp}
        </p>
      </div>
    </div>
  );
}

export default function AITab() {
  const [messages, setMessages] = useState<Message[]>([
    { id: 1, role: "assistant", content: WELCOME_MESSAGE, timestamp: formatTime() },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [groundingTrails, setGroundingTrails] = useState<GroundingTrail[]>([]);
  const [groundingCount, setGroundingCount] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isTyping) return;

      const userMsg: Message = {
        id: Date.now(),
        role: "user",
        content: text.trim(),
        timestamp: formatTime(),
      };

      const nextHistory = [...messages, userMsg];
      setMessages(nextHistory);
      setInput("");
      setIsTyping(true);
      setErrorMsg(null);

      const apiMessages = nextHistory
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }));

      const bbox = mapBboxStore.get();

      try {
        const res = await fetch("/api/ai/chat", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: apiMessages, bbox }),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          setIsTyping(false);
          setErrorMsg(
            res.status === 429
              ? "I'm hitting my rate limit — give me a moment and try again."
              : `Sorry — the AI service returned ${res.status}. ${errText.slice(0, 120)}`,
          );
          return;
        }
        const json = (await res.json()) as {
          reply: string;
          groundingCount: number;
          groundingTrails: GroundingTrail[];
        };
        setIsTyping(false);
        setGroundingTrails(json.groundingTrails ?? []);
        setGroundingCount(json.groundingCount ?? 0);
        const aiMsg: Message = {
          id: Date.now() + 1,
          role: "assistant",
          content: json.reply,
          timestamp: formatTime(),
        };
        setMessages((prev) => [...prev, aiMsg]);
      } catch (err) {
        setIsTyping(false);
        setErrorMsg(err instanceof Error ? err.message : "Failed to reach AI service");
      }
    },
    [isTyping, messages],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void sendMessage(input);
  };

  const resetChat = () => {
    setMessages([{ id: Date.now(), role: "assistant", content: WELCOME_MESSAGE, timestamp: formatTime() }]);
    setGroundingTrails([]);
    setGroundingCount(null);
    setErrorMsg(null);
  };

  return (
    <div className="flex flex-col h-full" data-testid="ai-tab">
      {/* Header */}
      <div className="px-4 pt-4 pb-2 border-b border-[hsl(30,12%,16%)] flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold tracking-wide text-amber-400 uppercase" style={{ letterSpacing: "0.12em" }}>
            Trail AI
          </h1>
          <div className="flex items-center gap-1.5 mt-0.5">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></div>
            <span className="text-xs text-stone-400" data-testid="ai-tab-status">
              {groundingCount == null
                ? "Online · UK Trail Expert"
                : `Grounded in ${groundingCount} trail${groundingCount === 1 ? "" : "s"} from your map`}
            </span>
          </div>
        </div>
        <button
          onClick={resetChat}
          className="p-2 rounded-lg text-stone-500 hover:text-stone-300 hover:bg-stone-800/50 transition-colors"
          aria-label="Reset chat"
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 .49-5.32" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}

        {isTyping && (
          <div className="flex items-start mb-3" data-testid="ai-tab-typing">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-amber-600 to-amber-900 flex items-center justify-center shrink-0 mr-2">
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-amber-200" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
            </div>
            <div className="bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,20%)] rounded-2xl rounded-tl-sm px-4 py-3 flex gap-1 items-center">
              <span className="w-2 h-2 rounded-full bg-stone-400 animate-bounce" style={{ animationDelay: "0ms" }}></span>
              <span className="w-2 h-2 rounded-full bg-stone-400 animate-bounce" style={{ animationDelay: "150ms" }}></span>
              <span className="w-2 h-2 rounded-full bg-stone-400 animate-bounce" style={{ animationDelay: "300ms" }}></span>
            </div>
          </div>
        )}
        {errorMsg ? (
          <div
            className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3"
            data-testid="ai-tab-error"
          >
            {errorMsg}
          </div>
        ) : null}
        {groundingTrails.length > 0 ? (
          <div className="text-[10px] text-stone-500 mt-1 mb-2">
            Mentioned trails: {groundingTrails.map((t) => t.name).join(", ")}
          </div>
        ) : null}
        <div ref={messagesEndRef} />
      </div>

      {/* Quick Prompts */}
      {messages.length <= 1 && (
        <div className="px-4 pb-2">
          <p className="text-xs text-stone-500 mb-2">Quick questions:</p>
          <div className="flex flex-wrap gap-2">
            {QUICK_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                onClick={() => void sendMessage(prompt)}
                className="px-3 py-1.5 bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,20%)] rounded-full text-xs text-stone-300 hover:border-amber-500/40 hover:text-amber-300 transition-colors"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="px-4 pb-4 pt-2 border-t border-[hsl(30,12%,16%)]">
        <form onSubmit={handleSubmit} className="flex gap-2 items-center">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about trails, gear, routes..."
            className="flex-1 bg-[hsl(22,15%,14%)] border border-[hsl(30,12%,20%)] rounded-xl px-4 py-3 text-sm text-stone-200 placeholder:text-stone-500 focus:outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/20 transition-colors"
            data-testid="ai-tab-input"
          />
          <button
            type="submit"
            disabled={!input.trim() || isTyping}
            className="w-11 h-11 rounded-xl flex items-center justify-center transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
            data-testid="ai-tab-send"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-stone-900" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
