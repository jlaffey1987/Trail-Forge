/**
 * Chat thread screen with SSE realtime + send. Pulls history via direct
 * fetch (`listChatMessages`) and listens to `/api/chat/stream` for new
 * messages. Polling fallback runs every 12 s when the SSE connection
 * isn't open (e.g. during reconnect).
 */
import { useAuth } from "@clerk/clerk-expo";
import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import {
  listChatMessages,
  markRoomRead,
  sendChatMessage,
  type ChatMessage,
} from "@/lib/api";
import { openChatStream } from "@/lib/sse";

export default function ChatThread() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const { getToken, userId } = useAuth();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const listRef = useRef<FlatList<ChatMessage> | null>(null);

  const id = String(roomId ?? "");

  const messagesQ = useQuery({
    queryKey: ["chat-messages", id],
    queryFn: () => listChatMessages(id, { limit: 100 }),
    enabled: !!id,
    refetchInterval: 12_000, // polling fallback in case SSE drops
  });

  const sendMut = useMutation({
    mutationFn: (body: string) => sendChatMessage(id, body),
    onSuccess: (data) => {
      qc.setQueryData<{ messages: ChatMessage[] }>(
        ["chat-messages", id],
        (prev) => {
          if (!prev) return { messages: [data.message] };
          // Don't double-insert if the SSE event arrived first.
          if (prev.messages.some((m) => m.id === data.message.id)) return prev;
          return { messages: [...prev.messages, data.message] };
        },
      );
    },
  });

  // Mark the room read on mount so the inbox badge clears.
  useEffect(() => {
    if (!id) return;
    void markRoomRead(id);
  }, [id]);

  // SSE subscription. Re-opens whenever the room id changes.
  useEffect(() => {
    if (!id) return;
    let closed = false;
    let handle: { close(): void } | null = null;
    void (async () => {
      const token = await getToken();
      if (!token || closed) return;
      handle = openChatStream(token, (evt) => {
        if (evt.type === "message" && evt.message && evt.roomId === id) {
          // SSE wire shape doesn't carry `edited_at` — coerce to the
          // ChatMessage shape the cache expects so we don't widen the type.
          const msg: ChatMessage = { ...evt.message, edited_at: null };
          qc.setQueryData<{ messages: ChatMessage[] }>(
            ["chat-messages", id],
            (prev) => {
              if (!prev) return { messages: [msg] };
              if (prev.messages.some((m) => m.id === msg.id)) return prev;
              return { messages: [...prev.messages, msg] };
            },
          );
        }
      });
    })();
    return () => {
      closed = true;
      handle?.close();
    };
  }, [id, getToken, qc]);

  const messages = messagesQ.data?.messages ?? [];

  function send() {
    const body = draft.trim();
    if (!body || sendMut.isPending) return;
    setDraft("");
    sendMut.mutate(body);
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 64 : 0}
    >
      {messagesQ.isLoading ? (
        <ActivityIndicator
          color={colors.light.primary}
          style={{ flex: 1 }}
        />
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: 12, paddingBottom: 12 }}
          renderItem={({ item }) => (
            <Bubble message={item} mine={item.author_id === userId} />
          )}
          onContentSizeChange={() =>
            listRef.current?.scrollToEnd({ animated: false })
          }
        />
      )}

      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Message…"
          placeholderTextColor={colors.light.mutedForeground}
          style={styles.input}
          multiline
        />
        <TouchableOpacity
          onPress={send}
          disabled={!draft.trim() || sendMut.isPending}
          style={[
            styles.sendBtn,
            (!draft.trim() || sendMut.isPending) && { opacity: 0.5 },
          ]}
        >
          <Feather name="send" size={18} color={colors.light.primaryForeground} />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({ message, mine }: { message: ChatMessage; mine: boolean }) {
  return (
    <View
      style={[
        styles.bubble,
        mine ? styles.mine : styles.theirs,
      ]}
    >
      <Text
        style={[
          styles.bubbleText,
          mine && { color: colors.light.primaryForeground },
        ]}
      >
        {message.body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },
  bubble: {
    maxWidth: "78%",
    padding: 10,
    borderRadius: 14,
    marginBottom: 6,
  },
  mine: {
    alignSelf: "flex-end",
    backgroundColor: colors.light.primary,
    borderBottomRightRadius: 4,
  },
  theirs: {
    alignSelf: "flex-start",
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderBottomLeftRadius: 4,
  },
  bubbleText: { color: colors.light.foreground, fontSize: 14 },
  composer: {
    flexDirection: "row",
    padding: 10,
    gap: 8,
    backgroundColor: colors.light.background,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.light.border,
    alignItems: "flex-end",
  },
  input: {
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
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
  },
});
