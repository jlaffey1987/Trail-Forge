/**
 * AI tab — chat against /api/ai/chat. We pass the full conversation
 * history so the server can keep context across turns, and we ground
 * each reply in whatever trails are currently visible on the Map tab
 * (see lib/visibleTrails.ts). When the user has trails on screen, a
 * subtle pill at the top of the composer tells them how many trails
 * the AI is grounding on.
 */
import { Feather } from "@expo/vector-icons";
import { useMutation } from "@tanstack/react-query";
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { AppShellHeader } from "@/components/shell/AppShellHeader";
import { askAi, type AiChatTurn } from "@/lib/api";
import { useVisibleTrails } from "@/lib/visibleTrails";

interface Turn {
  role: "user" | "assistant";
  text: string;
}

export default function AiTab() {
  const [messages, setMessages] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [groundOnVisible, setGroundOnVisible] = useState(true);
  const scrollRef = useRef<ScrollView | null>(null);
  const visible = useVisibleTrails();

  const ask = useMutation({
    mutationFn: ({
      history,
      prompt,
    }: {
      history: Turn[];
      prompt: string;
    }) => {
      const allTurns: AiChatTurn[] = [
        ...history.map<AiChatTurn>((m) => ({
          role: m.role,
          content: m.text,
        })),
        { role: "user", content: prompt },
      ];
      return askAi(allTurns, {
        bbox:
          groundOnVisible && visible.bbox && visible.trailIds.length > 0
            ? visible.bbox
            : null,
      });
    },
    onSuccess: (data) => {
      setMessages((m) => [...m, { role: "assistant", text: data.reply }]);
      requestAnimationFrame(() =>
        scrollRef.current?.scrollToEnd({ animated: true }),
      );
    },
    onError: (err) => {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: err instanceof Error ? `Error: ${err.message}` : "Error",
        },
      ]);
    },
  });

  function send() {
    const text = draft.trim();
    if (!text || ask.isPending) return;
    const history = messages;
    setMessages((m) => [...m, { role: "user", text }]);
    setDraft("");
    ask.mutate({ history, prompt: text });
  }

  const groundingActive =
    groundOnVisible && visible.bbox && visible.trailIds.length > 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.light.background }}>
      <AppShellHeader />
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={88}
    >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      >
        {messages.length === 0 ? (
          <View style={styles.empty}>
            <Feather name="message-circle" size={28} color={colors.light.primary} />
            <Text style={styles.emptyTitle}>Ask the trail AI anything</Text>
            <Text style={styles.emptyBody}>
              Get suggestions, plan rides, or ask about technique. Replies
              cite trails from the catalog when relevant.
            </Text>
          </View>
        ) : (
          messages.map((m, i) => (
            <View
              key={i}
              style={[
                styles.bubble,
                m.role === "user" ? styles.userBubble : styles.aiBubble,
              ]}
            >
              <Text
                style={[
                  styles.bubbleText,
                  m.role === "user" && {
                    color: colors.light.primaryForeground,
                  },
                ]}
              >
                {m.text}
              </Text>
            </View>
          ))
        )}
        {ask.isPending ? (
          <View style={[styles.bubble, styles.aiBubble]}>
            <ActivityIndicator color={colors.light.primary} />
          </View>
        ) : null}
      </ScrollView>

      {visible.trailIds.length > 0 ? (
        <TouchableOpacity
          style={[
            styles.groundPill,
            groundingActive ? styles.groundPillOn : styles.groundPillOff,
          ]}
          onPress={() => setGroundOnVisible((g) => !g)}
        >
          <Feather
            name={groundingActive ? "map-pin" : "map"}
            size={12}
            color={
              groundingActive
                ? colors.light.primary
                : colors.light.mutedForeground
            }
          />
          <Text
            style={[
              styles.groundPillText,
              groundingActive && { color: colors.light.primary },
            ]}
          >
            {groundingActive
              ? `Grounding on ${visible.trailIds.length} visible trail${visible.trailIds.length === 1 ? "" : "s"}`
              : "Grounding off"}
          </Text>
        </TouchableOpacity>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Ask anything…"
          placeholderTextColor={colors.light.mutedForeground}
          style={styles.composerInput}
          multiline
          onSubmitEditing={send}
          blurOnSubmit
        />
        <TouchableOpacity
          onPress={send}
          disabled={!draft.trim() || ask.isPending}
          style={[
            styles.sendBtn,
            (!draft.trim() || ask.isPending) && { opacity: 0.5 },
          ]}
        >
          <Feather name="send" size={18} color={colors.light.primaryForeground} />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },
  empty: { alignItems: "center", paddingVertical: 36, gap: 8 },
  emptyTitle: {
    color: colors.light.foreground,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 6,
  },
  emptyBody: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    textAlign: "center",
    paddingHorizontal: 32,
  },
  bubble: {
    maxWidth: "84%",
    padding: 12,
    borderRadius: 14,
    marginBottom: 8,
  },
  userBubble: {
    backgroundColor: colors.light.primary,
    alignSelf: "flex-end",
    borderBottomRightRadius: 4,
  },
  aiBubble: {
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    alignSelf: "flex-start",
    borderBottomLeftRadius: 4,
  },
  bubbleText: { color: colors.light.foreground, fontSize: 14 },
  groundPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "center",
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  groundPillOn: {
    backgroundColor: colors.light.primary + "15",
    borderColor: colors.light.primary,
  },
  groundPillOff: {
    backgroundColor: colors.light.muted,
    borderColor: colors.light.border,
  },
  groundPillText: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    fontWeight: "600",
  },
  composer: {
    flexDirection: "row",
    gap: 8,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.light.border,
    backgroundColor: colors.light.background,
    alignItems: "flex-end",
  },
  composerInput: {
    flex: 1,
    backgroundColor: colors.light.input,
    color: colors.light.foreground,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 18,
    maxHeight: 120,
    fontSize: 14,
  },
  sendBtn: {
    backgroundColor: colors.light.primary,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
});
