import { useState, useRef, useEffect } from "react";

interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

const QUICK_PROMPTS = [
  "Best trails for enduro beginners?",
  "What gear for Dartmoor?",
  "BOATs vs green lanes difference?",
  "Plan a weekend trip",
];

const MOCK_RESPONSES: Record<string, string> = {
  default: "I can help you plan off-road motorcycle trails, advise on gear, conditions, and routes across the UK. What would you like to explore?",
  beginner: "For enduro beginners, I'd recommend starting with **Shropshire Hills** and **Forest of Dean**. Difficulty 3-5 trails give you great terrain without the technical nightmare. Look for green lanes first — they're legal, well-mapped, and forgiving. Make sure you have an A2-legal or unrestricted bike appropriate for the terrain, and always ride with a buddy when starting out.",
  dartmoor: "Dartmoor requires **serious preparation**. Key gear: full enduro kit (helmet, chest protector, knee guards), waterproofs (Dartmoor weather changes fast), map and compass as backup, emergency bivvy, and a reliable dual-sport or enduro bike. The terrain is boggy moorland with rocky descents. Stick to legal BOATs and check Natural England access maps before you go. Water crossings are common — know your bike's wade depth.",
  boats: "**BOATs** (Byways Open to All Traffic) are fully legal unsealed routes open to all vehicles including motorbikes. They appear on OS maps as double-dashed lines. **Green lanes** is an informal term for unsurfaced tracks — some are BOATs, some are Restricted Byways (foot, horse, non-motorised only), some are Bridleways. Always check the definitive map at your local council. Riding an illegal route can result in a fixed penalty and damage access rights for all riders.",
  weekend: "Great choice! Here's a **Peak District Weekend** plan:\n\n**Day 1**: Base yourself near Buxton. Morning: Goyt Valley BOATs (difficulty 5). Afternoon: Axe Edge Moor traverse (difficulty 7). Pub stop in Longnor.\n\n**Day 2**: Early start for The Roaches circuit (difficulty 7), then finish with Flash Bottom green lane (difficulty 4). Evening drive home.\n\nTotal: ~85km, mix of technical and flowing. Book accommodation in advance — weekends fill fast in summer.",
};

function getResponse(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("beginner") || lower.includes("start")) return MOCK_RESPONSES.beginner;
  if (lower.includes("dartmoor") || lower.includes("gear")) return MOCK_RESPONSES.dartmoor;
  if (lower.includes("boat") || lower.includes("green lane")) return MOCK_RESPONSES.boats;
  if (lower.includes("weekend") || lower.includes("trip") || lower.includes("plan")) return MOCK_RESPONSES.weekend;
  return MOCK_RESPONSES.default;
}

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
    {
      id: 1,
      role: "assistant",
      content: "Hey rider! I'm your TrailForge AI — expert in UK off-road motorcycle routes, BOATs, green lanes, and trail planning. Ask me anything.",
      timestamp: formatTime(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  const sendMessage = (text: string) => {
    if (!text.trim()) return;

    const userMsg: Message = {
      id: Date.now(),
      role: "user",
      content: text.trim(),
      timestamp: formatTime(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);

    setTimeout(() => {
      setIsTyping(false);
      const response = getResponse(text);
      const aiMsg: Message = {
        id: Date.now() + 1,
        role: "assistant",
        content: response,
        timestamp: formatTime(),
      };
      setMessages((prev) => [...prev, aiMsg]);
    }, 1000 + Math.random() * 800);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-4 pb-2 border-b border-[hsl(30,12%,16%)] flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold tracking-wide text-amber-400 uppercase" style={{ letterSpacing: "0.12em" }}>
            Trail AI
          </h1>
          <div className="flex items-center gap-1.5 mt-0.5">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></div>
            <span className="text-xs text-stone-400">Online · UK Trail Expert</span>
          </div>
        </div>
        <button
          onClick={() => setMessages([{
            id: Date.now(),
            role: "assistant",
            content: "Hey rider! I'm your TrailForge AI — expert in UK off-road motorcycle routes, BOATs, green lanes, and trail planning. Ask me anything.",
            timestamp: formatTime(),
          }])}
          className="p-2 rounded-lg text-stone-500 hover:text-stone-300 hover:bg-stone-800/50 transition-colors"
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
          <div className="flex items-start mb-3">
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
                onClick={() => sendMessage(prompt)}
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
          />
          <button
            type="submit"
            disabled={!input.trim() || isTyping}
            className="w-11 h-11 rounded-xl flex items-center justify-center transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            style={{ background: "linear-gradient(135deg, #d4870c, #f0a832)" }}
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
