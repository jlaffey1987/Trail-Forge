/**
 * AI tab — minimal chat UI that posts to `/api/ai/chat`. Conversation
 * history lives in component state (intentionally non-persistent for the
 * MVP; the web app does the same).
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
import { askAi } from "@/lib/api";

interface Turn {
  role: "user" | "assistant";
  text: string;
}

export default function AiTab() {
  const [messages, setMessages] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<ScrollView | null>(null);

  const ask = useMutation({
    mutationFn: (prompt: string) => askAi(prompt),
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
    setMessages((m) => [...m, { role: "user", text }]);
    setDraft("");
    ask.mutate(text);
  }

  return (
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
