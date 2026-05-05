/**
 * Group detail / management — mirrors the web GroupDetail + EditGroupDialog
 * panels. Owners and admins see member management, invite generation /
 * revocation, and cover-photo upload. Members see a read-only roster.
 */
import { Feather } from "@expo/vector-icons";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import {
  createGroupInvite,
  fetchGroupDetail,
  finalizeGroupCover,
  groupCoverPhotoUrl,
  removeGroupCover,
  removeGroupMember,
  requestGroupCoverUploadUrl,
  revokeGroupInvite,
  type GroupInvite,
  type GroupMember,
} from "@/lib/api";

export default function GroupDetailScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const id = String(groupId ?? "");
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["group-detail", id],
    queryFn: () => fetchGroupDetail(id),
    enabled: !!id,
  });

  const detail = q.data;
  const canManage =
    detail?.callerRole === "owner" || detail?.callerRole === "admin";

  const [inviteModal, setInviteModal] = useState(false);

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.light.primary} />
      </View>
    );
  }
  if (!detail) {
    return (
      <View style={styles.center}>
        <Text style={styles.h1}>Group not found</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
    >
      <CoverSection
        groupId={id}
        coverKey={detail.group.cover_photo_key}
        canManage={canManage}
        onChanged={() =>
          qc.invalidateQueries({ queryKey: ["group-detail", id] })
        }
      />

      <Text style={styles.h1}>{detail.group.name}</Text>
      {detail.group.description ? (
        <Text style={styles.body}>{detail.group.description}</Text>
      ) : null}
      <Text style={styles.meta}>
        {detail.members.length} member{detail.members.length === 1 ? "" : "s"}
        {" · "}
        {detail.sharedTrailCount} shared trail
        {detail.sharedTrailCount === 1 ? "" : "s"}
      </Text>

      <Section title="Members">
        {detail.members.map((m) => (
          <MemberRow
            key={m.user_id}
            member={m}
            canManage={canManage}
            isSelfOwner={detail.callerRole === "owner"}
            onRemove={async () => {
              try {
                await removeGroupMember(id, m.user_id);
                await qc.invalidateQueries({ queryKey: ["group-detail", id] });
              } catch (err) {
                Alert.alert(
                  "Remove failed",
                  err instanceof Error ? err.message : "Unknown error",
                );
              }
            }}
          />
        ))}
      </Section>

      {canManage ? (
        <Section
          title="Invites"
          right={
            <TouchableOpacity
              style={styles.smallBtn}
              onPress={() => setInviteModal(true)}
            >
              <Feather name="plus" size={14} color={colors.light.primary} />
              <Text style={styles.smallBtnText}>New invite</Text>
            </TouchableOpacity>
          }
        >
          {detail.invites.length === 0 ? (
            <Text style={styles.muted}>No active invites.</Text>
          ) : (
            detail.invites.map((inv) => (
              <InviteRow
                key={inv.id}
                invite={inv}
                onRevoke={async () => {
                  try {
                    await revokeGroupInvite(id, inv.id);
                    await qc.invalidateQueries({
                      queryKey: ["group-detail", id],
                    });
                  } catch (err) {
                    Alert.alert(
                      "Revoke failed",
                      err instanceof Error ? err.message : "Unknown error",
                    );
                  }
                }}
              />
            ))
          )}
        </Section>
      ) : null}

      <CreateInviteModal
        visible={inviteModal}
        onDismiss={() => setInviteModal(false)}
        groupId={id}
        onCreated={() => {
          setInviteModal(false);
          void qc.invalidateQueries({ queryKey: ["group-detail", id] });
        }}
      />
    </ScrollView>
  );
}

function CoverSection({
  groupId,
  coverKey,
  canManage,
  onChanged,
}: {
  groupId: string;
  coverKey: string | null;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const url = groupCoverPhotoUrl(coverKey);

  async function pickAndUpload() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Photo library access is required.");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      allowsEditing: true,
      aspect: [16, 9],
    });
    if (picked.canceled || picked.assets.length === 0) return;
    const asset = picked.assets[0];
    setBusy(true);
    try {
      const ticket = await requestGroupCoverUploadUrl(groupId);
      const blob = await (await fetch(asset.uri)).blob();
      const put = await fetch(ticket.uploadURL, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: blob,
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      await finalizeGroupCover(groupId, ticket.storageKey);
      onChanged();
    } catch (err) {
      Alert.alert(
        "Upload failed",
        err instanceof Error ? err.message : "Unknown error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeCover() {
    setBusy(true);
    try {
      await removeGroupCover(groupId);
      onChanged();
    } catch (err) {
      Alert.alert(
        "Remove failed",
        err instanceof Error ? err.message : "Unknown error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.coverWrap}>
      {url ? (
        <Image source={{ uri: url }} style={styles.cover} />
      ) : (
        <View style={[styles.cover, styles.coverPlaceholder]}>
          <Feather name="image" size={28} color={colors.light.mutedForeground} />
          <Text style={styles.muted}>No cover photo yet</Text>
        </View>
      )}
      {canManage ? (
        <View style={styles.coverActions}>
          <TouchableOpacity
            onPress={pickAndUpload}
            disabled={busy}
            style={[styles.smallBtn, busy && { opacity: 0.5 }]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={colors.light.primary} />
            ) : (
              <Feather name="upload" size={14} color={colors.light.primary} />
            )}
            <Text style={styles.smallBtnText}>
              {url ? "Replace cover" : "Upload cover"}
            </Text>
          </TouchableOpacity>
          {url ? (
            <TouchableOpacity
              onPress={removeCover}
              disabled={busy}
              style={[styles.smallBtn, busy && { opacity: 0.5 }]}
            >
              <Feather name="trash-2" size={14} color={colors.light.destructive} />
              <Text
                style={[
                  styles.smallBtnText,
                  { color: colors.light.destructive },
                ]}
              >
                Remove
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.h2}>{title}</Text>
        {right}
      </View>
      <View style={{ gap: 8 }}>{children}</View>
    </View>
  );
}

function MemberRow({
  member,
  canManage,
  isSelfOwner,
  onRemove,
}: {
  member: GroupMember;
  canManage: boolean;
  isSelfOwner: boolean;
  onRemove: () => void;
}) {
  const name = member.display_name ?? member.email ?? "Unnamed rider";
  const canKick =
    canManage && member.role !== "owner" && (isSelfOwner || member.role === "member");

  function confirmKick() {
    Alert.alert(
      `Remove ${name}?`,
      "They'll lose access to shared trails and group photos.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: onRemove },
      ],
    );
  }

  return (
    <View style={styles.memberRow}>
      <View style={styles.avatar}>
        <Feather name="user" size={16} color={colors.light.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.memberName}>{name}</Text>
        <Text style={styles.memberRole}>{member.role}</Text>
      </View>
      {canKick ? (
        <TouchableOpacity onPress={confirmKick} style={styles.kickBtn}>
          <Feather name="user-minus" size={14} color={colors.light.destructive} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function InviteRow({
  invite,
  onRevoke,
}: {
  invite: GroupInvite;
  onRevoke: () => void;
}) {
  async function copy() {
    await Clipboard.setStringAsync(invite.token);
    Alert.alert("Copied", "Invite token copied to clipboard.");
  }
  const label = invite.email ?? invite.target_user_id ?? "Open invite";
  return (
    <View style={styles.memberRow}>
      <View style={styles.avatar}>
        <Feather name="link" size={14} color={colors.light.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.memberName} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.memberRole}>{formatExpiry(invite.expires_at)}</Text>
      </View>
      <TouchableOpacity onPress={copy} style={styles.copyBtn}>
        <Feather name="copy" size={14} color={colors.light.primary} />
      </TouchableOpacity>
      <TouchableOpacity onPress={onRevoke} style={styles.kickBtn}>
        <Feather name="x" size={14} color={colors.light.destructive} />
      </TouchableOpacity>
    </View>
  );
}

function formatExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  if (days > 0) return `${days}d ${hours}h left`;
  return `${hours}h left`;
}

function CreateInviteModal({
  visible,
  onDismiss,
  groupId,
  onCreated,
}: {
  visible: boolean;
  onDismiss: () => void;
  groupId: string;
  onCreated: () => void;
}) {
  const [mode, setMode] = useState<"link" | "email" | "username">("link");
  const [value, setValue] = useState("");

  const mut = useMutation({
    mutationFn: () => {
      const body: { email?: string; username?: string } = {};
      if (mode === "email" && value.trim()) body.email = value.trim();
      if (mode === "username" && value.trim()) body.username = value.trim();
      return createGroupInvite(groupId, body);
    },
    onSuccess: async (inv) => {
      await Clipboard.setStringAsync(inv.token);
      Alert.alert(
        "Invite created",
        `Token copied to clipboard.\n\nExpires: ${formatExpiry(inv.expires_at)}`,
      );
      setValue("");
      onCreated();
    },
    onError: (err) =>
      Alert.alert(
        "Create failed",
        err instanceof Error ? err.message : "Unknown error",
      ),
  });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.modalScrim}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>New invite</Text>
          <View style={styles.tabs}>
            {(["link", "email", "username"] as const).map((t) => (
              <TouchableOpacity
                key={t}
                onPress={() => {
                  setMode(t);
                  setValue("");
                }}
                style={[styles.tab, mode === t && styles.tabActive]}
              >
                <Text
                  style={[
                    styles.tabText,
                    mode === t && styles.tabTextActive,
                  ]}
                >
                  {t}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {mode !== "link" ? (
            <TextInput
              value={value}
              onChangeText={setValue}
              placeholder={mode === "email" ? "rider@example.com" : "username"}
              placeholderTextColor={colors.light.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType={mode === "email" ? "email-address" : "default"}
              style={styles.input}
            />
          ) : (
            <Text style={styles.muted}>
              Generates an open invite token anyone can use until it expires.
            </Text>
          )}
          <View style={styles.modalActions}>
            <TouchableOpacity onPress={onDismiss} style={styles.modalCancelBtn}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => mut.mutate()}
              disabled={
                mut.isPending || (mode !== "link" && value.trim().length === 0)
              }
              style={[
                styles.modalConfirmBtn,
                (mut.isPending ||
                  (mode !== "link" && value.trim().length === 0)) && {
                  opacity: 0.5,
                },
              ]}
            >
              {mut.isPending ? (
                <ActivityIndicator color={colors.light.primaryForeground} />
              ) : (
                <Text style={styles.modalConfirmText}>Create</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.light.background,
  },
  coverWrap: { gap: 8, marginBottom: 12 },
  cover: {
    width: "100%",
    aspectRatio: 16 / 9,
    borderRadius: 12,
    backgroundColor: colors.light.muted,
  },
  coverPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  coverActions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  h1: {
    color: colors.light.foreground,
    fontSize: 22,
    fontWeight: "800",
    marginTop: 4,
  },
  h2: {
    color: colors.light.foreground,
    fontSize: 16,
    fontWeight: "700",
  },
  body: { color: colors.light.foreground, marginTop: 4 },
  meta: { color: colors.light.mutedForeground, marginTop: 4, fontSize: 13 },
  muted: { color: colors.light.mutedForeground, fontSize: 13 },
  section: { marginTop: 20 },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  smallBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.light.muted,
    borderRadius: 8,
  },
  smallBtnText: {
    color: colors.light.primary,
    fontSize: 12,
    fontWeight: "700",
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.light.card,
    borderRadius: 10,
    borderColor: colors.light.border,
    borderWidth: 1,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.light.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  memberName: { color: colors.light.foreground, fontWeight: "700" },
  memberRole: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginTop: 2,
  },
  kickBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.light.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  copyBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.light.muted,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 4,
  },
  modalScrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    backgroundColor: colors.light.background,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  modalTitle: {
    color: colors.light.foreground,
    fontSize: 16,
    fontWeight: "700",
  },
  tabs: {
    flexDirection: "row",
    gap: 6,
    backgroundColor: colors.light.muted,
    padding: 4,
    borderRadius: 10,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    borderRadius: 8,
  },
  tabActive: { backgroundColor: colors.light.background },
  tabText: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "capitalize",
  },
  tabTextActive: { color: colors.light.foreground },
  input: {
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    color: colors.light.foreground,
    backgroundColor: colors.light.card,
  },
  modalActions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  modalCancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.light.muted,
  },
  modalCancelText: { color: colors.light.foreground, fontWeight: "700" },
  modalConfirmBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.light.primary,
  },
  modalConfirmText: {
    color: colors.light.primaryForeground,
    fontWeight: "700",
  },
});
