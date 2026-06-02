/**
 * Admin landing — moderator-only review queue for AI-discovered trails.
 * Visible only when the API tells us `isModerator: true`. Lets a moderator
 * approve or reject pending discoveries with optional reasons.
 */
import { Feather } from "@expo/vector-icons";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import {
  adminWhoami,
  approveDiscoveredTrail,
  grantAdmin,
  listAdminActivity,
  listAdmins,
  listDiscoveredTrails,
  rejectDiscoveredTrail,
  revokeAdmin,
  searchDirectoryUsers,
  adminListLinesfolk,
  adminGrantLinesman,
  adminGetLinesmanEdits,
  adminUndoLinesmanEdit,
  type AdminActivityEntry,
  type AdminUser,
  type DirectoryUser,
  type DiscoveredTrail,
  type LinesmanEdit,
} from "@/lib/api";

type StatusFilter = "pending" | "approved" | "rejected";
type AdminTab = "queue" | "activity" | "users" | "linesfolk";

export default function AdminScreen() {
  const me = useQuery({ queryKey: ["admin-whoami"], queryFn: adminWhoami });
  const [tab, setTab] = useState<AdminTab>("queue");
  const [status, setStatus] = useState<StatusFilter>("pending");
  const qc = useQueryClient();
  const queueQ = useQuery({
    queryKey: ["admin-discovery", status],
    queryFn: () => listDiscoveredTrails(status),
    enabled: !!me.data?.isModerator && tab === "queue",
  });

  const [rejectFor, setRejectFor] = useState<DiscoveredTrail | null>(null);

  const approveMut = useMutation({
    mutationFn: (id: string) => approveDiscoveredTrail(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-discovery"] });
    },
    onError: (err) =>
      Alert.alert(
        "Approve failed",
        err instanceof Error ? err.message : "Unknown error",
      ),
  });

  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      rejectDiscoveredTrail(id, reason || undefined),
    onSuccess: () => {
      setRejectFor(null);
      void qc.invalidateQueries({ queryKey: ["admin-discovery"] });
    },
    onError: (err) =>
      Alert.alert(
        "Reject failed",
        err instanceof Error ? err.message : "Unknown error",
      ),
  });

  if (me.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.light.primary} />
      </View>
    );
  }

  if (!me.data?.isModerator) {
    return (
      <View style={styles.center}>
        <Text style={styles.h1}>403</Text>
        <Text style={styles.body}>You don't have admin access.</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.btn}>
          <Text style={styles.btnText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const items = queueQ.data?.items ?? [];

  return (
    <View style={styles.container}>
      <View style={styles.tabs}>
        {(["queue", "activity", "users", "linesfolk"] as AdminTab[]).map((t) => (
          <TouchableOpacity
            key={t}
            onPress={() => setTab(t)}
            style={[styles.tab, tab === t && styles.tabActive]}
          >
            <Text
              style={[styles.tabText, tab === t && styles.tabTextActive]}
            >
              {t === "queue" ? "Queue" : t === "activity" ? "Activity" : t === "users" ? "Users" : "Linesfolk"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === "queue" ? (
        <>
          <View style={[styles.tabs, { paddingTop: 6 }]}>
            {(["pending", "approved", "rejected"] as StatusFilter[]).map((s) => (
              <TouchableOpacity
                key={s}
                onPress={() => setStatus(s)}
                style={[
                  styles.subTab,
                  status === s && styles.subTabActive,
                ]}
              >
                <Text
                  style={[
                    styles.subTabText,
                    status === s && styles.subTabTextActive,
                  ]}
                >
                  {s}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {queueQ.data?.note ? (
            <Text style={styles.note}>{queueQ.data.note}</Text>
          ) : null}

          <FlatList
            data={items}
            keyExtractor={(d) => d.id}
            contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
            refreshControl={
              <RefreshControl
                refreshing={queueQ.isFetching}
                onRefresh={() => void queueQ.refetch()}
                tintColor={colors.light.primary}
              />
            }
            ListEmptyComponent={
              queueQ.isLoading ? (
                <ActivityIndicator color={colors.light.primary} />
              ) : (
                <Text style={styles.empty}>Nothing to review.</Text>
              )
            }
            renderItem={({ item }) => (
              <DiscoveryCard
                trail={item}
                onApprove={() => approveMut.mutate(item.id)}
                onReject={() => setRejectFor(item)}
                busy={approveMut.isPending}
              />
            )}
          />
        </>
      ) : tab === "activity" ? (
        <AdminActivityPanel />
      ) : tab === "users" ? (
        <AdminUsersPanel />
      ) : (
        <AdminLinesfolkPanel />
      )}

      <RejectModal
        trail={rejectFor}
        onDismiss={() => setRejectFor(null)}
        onConfirm={(reason) =>
          rejectFor && rejectMut.mutate({ id: rejectFor.id, reason })
        }
        busy={rejectMut.isPending}
      />
    </View>
  );
}

function AdminActivityPanel() {
  // Server returns a pre-merged moderation feed via GET /api/admin/activity.
  const activityQ = useQuery({
    queryKey: ["admin-activity"],
    queryFn: () => listAdminActivity(50),
  });
  const items: AdminActivityEntry[] = activityQ.data?.items ?? [];

  return (
    <FlatList
      data={items}
      keyExtractor={(d) => `${d.status}-${d.id}`}
      contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
      refreshControl={
        <RefreshControl
          refreshing={activityQ.isFetching}
          onRefresh={() => void activityQ.refetch()}
          tintColor={colors.light.primary}
        />
      }
      ListHeaderComponent={
        <Text style={[styles.note, { paddingHorizontal: 0, marginBottom: 8 }]}>
          Recent moderation decisions. Pull to refresh.
        </Text>
      }
      ListEmptyComponent={
        activityQ.isLoading ? (
          <ActivityIndicator color={colors.light.primary} />
        ) : (
          <Text style={styles.empty}>No moderation activity yet.</Text>
        )
      }
      renderItem={({ item }) => {
        const approved = item.status === "approved";
        return (
          <View style={styles.card}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View
                style={[
                  styles.activityBadge,
                  approved ? styles.activityBadgeApproved : styles.activityBadgeRejected,
                ]}
              >
                <Feather
                  name={approved ? "check" : "x"}
                  size={12}
                  color={approved ? colors.light.primaryForeground : colors.light.foreground}
                />
                <Text
                  style={[
                    styles.activityBadgeText,
                    approved
                      ? { color: colors.light.primaryForeground }
                      : { color: colors.light.foreground },
                  ]}
                >
                  {approved ? "Approved" : "Rejected"}
                </Text>
              </View>
              <Text style={styles.cardMeta}>
                {new Date(item.created_at).toLocaleString()}
              </Text>
            </View>
            <Text style={[styles.cardTitle, { marginTop: 8 }]} numberOfLines={2}>
              {item.name ?? "Untitled discovery"}
            </Text>
            <Text style={styles.cardMeta}>
              {item.region ?? "Unknown region"}
              {item.difficulty ? ` • ${item.difficulty}` : ""}
            </Text>
            {item.source_url ? (
              <Text style={styles.cardLink} numberOfLines={1}>
                {item.source_url}
              </Text>
            ) : null}
          </View>
        );
      }}
    />
  );
}

function AdminUsersPanel() {
  const qc = useQueryClient();
  const adminsQ = useQuery({ queryKey: ["admin-users"], queryFn: listAdmins });
  const [pickerOpen, setPickerOpen] = useState(false);

  const grantMut = useMutation({
    mutationFn: ({ userId, note }: { userId: string; note?: string }) =>
      grantAdmin(userId, note),
    onSuccess: () => {
      setPickerOpen(false);
      void qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (err) =>
      Alert.alert(
        "Grant failed",
        err instanceof Error ? err.message : "Unknown error",
      ),
  });

  const revokeMut = useMutation({
    mutationFn: (userId: string) => revokeAdmin(userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (err) =>
      Alert.alert(
        "Revoke failed",
        err instanceof Error ? err.message : "Unknown error",
      ),
  });

  const items: AdminUser[] = adminsQ.data?.items ?? [];

  function confirmRevoke(u: AdminUser) {
    Alert.alert(
      "Revoke admin?",
      `Remove admin access from ${u.email ?? u.user_id}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Revoke",
          style: "destructive",
          onPress: () => revokeMut.mutate(u.user_id),
        },
      ],
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(u) => u.user_id}
      contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
      refreshControl={
        <RefreshControl
          refreshing={adminsQ.isFetching}
          onRefresh={() => void adminsQ.refetch()}
          tintColor={colors.light.primary}
        />
      }
      ListHeaderComponent={
        <View style={{ marginBottom: 14 }}>
          <Text style={styles.sectionTitle}>Grant admin access</Text>
          <Text style={styles.body}>
            Search the user directory and pick someone to promote.
          </Text>
          <TouchableOpacity
            onPress={() => setPickerOpen(true)}
            style={[styles.btn, { marginTop: 12 }]}
          >
            <Feather
              name="user-plus"
              size={14}
              color={colors.light.primaryForeground}
            />
            <Text style={[styles.btnText, { marginLeft: 6 }]}>
              Find user…
            </Text>
          </TouchableOpacity>

          {adminsQ.data?.note ? (
            <Text style={[styles.note, { paddingHorizontal: 0, marginTop: 12 }]}>
              {adminsQ.data.note}
            </Text>
          ) : null}
          {adminsQ.data?.envAdmins?.length ? (
            <Text style={[styles.note, { paddingHorizontal: 0 }]}>
              Env-pinned admins (cannot be revoked):
              {" "}
              {adminsQ.data.envAdmins.join(", ")}
            </Text>
          ) : null}

          <Text style={[styles.sectionTitle, { marginTop: 22 }]}>
            Current admins ({items.length})
          </Text>
        </View>
      }
      ListEmptyComponent={
        adminsQ.isLoading ? (
          <ActivityIndicator color={colors.light.primary} />
        ) : (
          <Text style={styles.empty}>No admins recorded in the database.</Text>
        )
      }
      renderItem={({ item }) => (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {item.display_name ?? item.email ?? item.user_id}
          </Text>
          <Text style={styles.cardMeta}>
            {item.email ? `${item.email} • ` : ""}
            {item.user_id}
          </Text>
          <Text style={styles.cardMeta}>
            Granted {new Date(item.granted_at).toLocaleDateString()}
            {item.granted_by ? ` by ${item.granted_by}` : ""}
          </Text>
          {item.note ? (
            <Text style={[styles.cardMeta, { fontStyle: "italic" }]}>
              "{item.note}"
            </Text>
          ) : null}
          <TouchableOpacity
            onPress={() => confirmRevoke(item)}
            disabled={revokeMut.isPending}
            style={[
              styles.actionBtn,
              styles.rejectBtn,
              { marginTop: 10, alignSelf: "flex-start", flex: 0, paddingHorizontal: 16 },
              revokeMut.isPending && { opacity: 0.5 },
            ]}
          >
            <Feather name="user-x" size={14} color={colors.light.foreground} />
            <Text style={styles.actionTextDark}>Revoke</Text>
          </TouchableOpacity>
        </View>
      )}
      ListFooterComponent={
        <UserPickerModal
          visible={pickerOpen}
          onDismiss={() => setPickerOpen(false)}
          onPick={(u, note) =>
            grantMut.mutate({ userId: u.user_id, note })
          }
          busy={grantMut.isPending}
        />
      }
    />
  );
}

function UserPickerModal({
  visible,
  onDismiss,
  onPick,
  busy,
}: {
  visible: boolean;
  onDismiss: () => void;
  onPick: (user: DirectoryUser, note?: string) => void;
  busy: boolean;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [picked, setPicked] = useState<DirectoryUser | null>(null);
  const [note, setNote] = useState("");

  React.useEffect(() => {
    if (!visible) {
      setQuery("");
      setDebounced("");
      setPicked(null);
      setNote("");
      return;
    }
    const t = setTimeout(() => setDebounced(query.trim()), 280);
    return () => clearTimeout(t);
  }, [query, visible]);

  const usersQ = useQuery({
    queryKey: ["directory-users", debounced],
    queryFn: () => searchDirectoryUsers(debounced, 25),
    enabled: visible && debounced.length > 0,
  });
  const results = usersQ.data?.items ?? [];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onDismiss}
    >
      <View style={styles.modalScrim}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Pick a user</Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Name, email, or username"
            placeholderTextColor={colors.light.mutedForeground}
            style={styles.modalInput}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {usersQ.isFetching ? (
            <ActivityIndicator color={colors.light.primary} />
          ) : null}
          <FlatList
            data={results}
            keyExtractor={(u) => u.user_id}
            style={{ maxHeight: 240 }}
            ListEmptyComponent={
              !usersQ.isFetching ? (
                <Text style={styles.empty}>
                  {debounced
                    ? "No matches."
                    : "Start typing to search."}
                </Text>
              ) : null
            }
            renderItem={({ item }) => {
              const isPicked = picked?.user_id === item.user_id;
              return (
                <TouchableOpacity
                  onPress={() => setPicked(item)}
                  style={[
                    styles.userRow,
                    isPicked && styles.userRowSelected,
                  ]}
                >
                  <Text style={styles.cardTitle}>
                    {item.display_name ?? item.email ?? item.user_id}
                  </Text>
                  {item.email ? (
                    <Text style={styles.cardMeta}>{item.email}</Text>
                  ) : null}
                </TouchableOpacity>
              );
            }}
          />
          {picked ? (
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Note (optional)"
              placeholderTextColor={colors.light.mutedForeground}
              style={styles.modalInput}
            />
          ) : null}
          <View style={[styles.actions, { marginTop: 8 }]}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.rejectBtn]}
              onPress={onDismiss}
              disabled={busy}
            >
              <Text style={styles.actionTextDark}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.actionBtn,
                styles.approveBtn,
                (!picked || busy) && { opacity: 0.5 },
              ]}
              disabled={!picked || busy}
              onPress={() => picked && onPick(picked, note.trim() || undefined)}
            >
              <Text style={styles.actionTextLight}>
                {busy ? "Granting…" : "Grant admin"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function DiscoveryCard({
  trail,
  onApprove,
  onReject,
  busy,
}: {
  trail: DiscoveredTrail;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle} numberOfLines={2}>
        {trail.name ?? "Untitled discovery"}
      </Text>
      <Text style={styles.cardMeta}>
        {trail.region ?? "Unknown region"}
        {trail.difficulty ? ` • ${trail.difficulty}` : ""}
      </Text>
      {trail.source_url ? (
        <Text style={styles.cardLink} numberOfLines={1}>
          {trail.source_url}
        </Text>
      ) : null}
      {trail.status === "pending" ? (
        <View style={styles.actions}>
          <TouchableOpacity
            onPress={onApprove}
            disabled={busy}
            style={[styles.actionBtn, styles.approveBtn, busy && { opacity: 0.5 }]}
          >
            <Feather name="check" size={16} color={colors.light.primaryForeground} />
            <Text style={styles.actionTextLight}>Approve</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onReject}
            disabled={busy}
            style={[styles.actionBtn, styles.rejectBtn]}
          >
            <Feather name="x" size={16} color={colors.light.foreground} />
            <Text style={styles.actionTextDark}>Reject</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <Text style={styles.statusBadge}>{trail.status}</Text>
      )}
    </View>
  );
}

function RejectModal({
  trail,
  onDismiss,
  onConfirm,
  busy,
}: {
  trail: DiscoveredTrail | null;
  onDismiss: () => void;
  onConfirm: (reason: string) => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <Modal
      visible={!!trail}
      animationType="fade"
      transparent
      onRequestClose={onDismiss}
    >
      <View style={styles.modalScrim}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Reject discovery</Text>
          <Text style={styles.body}>
            Optional: tell the AI why this discovery was wrong so future scans
            can do better.
          </Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Reason (optional)"
            placeholderTextColor={colors.light.mutedForeground}
            multiline
            style={styles.modalInput}
          />
          <View style={[styles.actions, { marginTop: 14 }]}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.rejectBtn]}
              onPress={onDismiss}
              disabled={busy}
            >
              <Text style={styles.actionTextDark}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.approveBtn, busy && { opacity: 0.5 }]}
              onPress={() => {
                onConfirm(reason);
                setReason("");
              }}
              disabled={busy}
            >
              <Text style={styles.actionTextLight}>
                {busy ? "Rejecting…" : "Confirm"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Linesfolk admin panel
// ─────────────────────────────────────────────────────────────────────────────

function AdminLinesfolkPanel() {
  const qc = useQueryClient();
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const linesfolkQ = useQuery({
    queryKey: ["admin-linesfolk"],
    queryFn: adminListLinesfolk,
  });
  const editsQ = useQuery({
    queryKey: ["admin-linesfolk-edits", expandedUser],
    queryFn: () => adminGetLinesmanEdits(expandedUser!),
    enabled: !!expandedUser,
  });

  const grantMut = useMutation({
    mutationFn: ({ userId, access }: { userId: string; access: boolean }) =>
      adminGrantLinesman(userId, access),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-linesfolk"] });
    },
    onError: (err) => Alert.alert("Error", err instanceof Error ? err.message : "Failed"),
  });

  const undoMut = useMutation({
    mutationFn: adminUndoLinesmanEdit,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-linesfolk-edits", expandedUser] });
      Alert.alert("Undone", "Edit reversed.");
    },
    onError: (err) => Alert.alert("Cannot undo", err instanceof Error ? err.message : "Error"),
  });

  const items = linesfolkQ.data ?? [];

  const EDIT_LABELS: Record<string, string> = {
    update_metadata: "Edited", replace_gpx: "Route replaced", flag: "Flagged",
    unflag: "Unflagged", delete: "Deleted", restore: "Restored", add: "Added",
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 80 }}>
      <View style={{ marginBottom: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={styles.sectionTitle}>Linesfolk ({items.length})</Text>
        <TouchableOpacity
          onPress={() => setPickerOpen(true)}
          style={[styles.btn, { marginTop: 0 }]}
        >
          <Feather name="user-plus" size={14} color={colors.light.primaryForeground} />
          <Text style={[styles.btnText, { marginLeft: 6 }]}>Grant access</Text>
        </TouchableOpacity>
      </View>

      {linesfolkQ.isLoading ? (
        <ActivityIndicator color={colors.light.primary} />
      ) : items.length === 0 ? (
        <Text style={styles.empty}>No linesfolk yet. Grant access to trusted trail maintainers.</Text>
      ) : (
        items.map(u => (
          <View key={u.id} style={[styles.card, { borderLeftWidth: 3, borderLeftColor: colors.light.primary }]}>
            <TouchableOpacity onPress={() => setExpandedUser(prev => prev === u.id ? null : u.id)}>
              <Text style={styles.cardTitle}>{u.display_name ?? u.email ?? u.id}</Text>
              {u.email ? <Text style={styles.cardMeta}>{u.email}</Text> : null}
              {u.linesman_group_id ? (
                <Text style={styles.cardMeta}>Group: {u.linesman_group_id}</Text>
              ) : (
                <Text style={[styles.cardMeta, { fontStyle: "italic" }]}>No group assigned</Text>
              )}
            </TouchableOpacity>

            <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
              <TouchableOpacity
                onPress={() => setExpandedUser(prev => prev === u.id ? null : u.id)}
                style={[styles.actionBtn, styles.rejectBtn]}
              >
                <Feather name="clock" size={14} color={colors.light.foreground} />
                <Text style={styles.actionTextDark}>
                  {expandedUser === u.id ? "Hide history" : "View history"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => Alert.alert(
                  "Revoke linesman access?",
                  `Remove linesman access from ${u.display_name ?? u.id}?`,
                  [
                    { text: "Cancel", style: "cancel" },
                    { text: "Revoke", style: "destructive", onPress: () => grantMut.mutate({ userId: u.id, access: false }) },
                  ],
                )}
                disabled={grantMut.isPending}
                style={[styles.actionBtn, styles.rejectBtn]}
              >
                <Feather name="user-x" size={14} color={colors.light.foreground} />
                <Text style={styles.actionTextDark}>Revoke</Text>
              </TouchableOpacity>
            </View>

            {expandedUser === u.id && (
              <View style={{ marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.light.border, paddingTop: 10 }}>
                <Text style={[styles.sectionTitle, { fontSize: 13, marginBottom: 8 }]}>Edit History</Text>
                {editsQ.isLoading ? (
                  <ActivityIndicator color={colors.light.primary} />
                ) : (editsQ.data ?? []).length === 0 ? (
                  <Text style={styles.empty}>No edits yet.</Text>
                ) : (
                  (editsQ.data ?? []).map((edit: LinesmanEdit) => {
                    const ageMs = Date.now() - new Date(edit.created_at).getTime();
                    const canUndo = ageMs < 86400_000;
                    return (
                      <View key={edit.id} style={{ flexDirection: "row", alignItems: "center", marginBottom: 8, gap: 8 }}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.cardTitle}>{EDIT_LABELS[edit.edit_type] ?? edit.edit_type}</Text>
                          <Text style={styles.cardMeta} numberOfLines={1}>{edit.trail_name ?? edit.trail_id ?? "?"}</Text>
                          <Text style={styles.cardMeta}>{new Date(edit.created_at).toLocaleString()}</Text>
                        </View>
                        {canUndo && (
                          <TouchableOpacity
                            onPress={() => Alert.alert(
                              "Undo edit?",
                              "This will restore the trail to its previous state.",
                              [
                                { text: "Cancel", style: "cancel" },
                                { text: "Undo", style: "destructive", onPress: () => undoMut.mutate(edit.id) },
                              ],
                            )}
                            style={[styles.actionBtn, styles.rejectBtn, { flex: 0 }]}
                          >
                            <Feather name="corner-up-left" size={12} color={colors.light.foreground} />
                            <Text style={styles.actionTextDark}>Undo</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    );
                  })
                )}
              </View>
            )}
          </View>
        ))
      )}

      <UserPickerModal
        visible={pickerOpen}
        onDismiss={() => setPickerOpen(false)}
        onPick={(user) => { grantMut.mutate({ userId: user.user_id, access: true }); setPickerOpen(false); }}
        busy={grantMut.isPending}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.light.background },
  center: {
    flex: 1,
    backgroundColor: colors.light.background,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 8,
  },
  h1: { color: colors.light.foreground, fontSize: 22, fontWeight: "800" },
  body: { color: colors.light.mutedForeground, fontSize: 14, marginTop: 8 },
  note: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 6,
  },
  btn: {
    marginTop: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.light.primary,
    borderRadius: 12,
  },
  btnText: { color: colors.light.primaryForeground, fontWeight: "700" },
  tabs: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.light.muted,
  },
  tabActive: { backgroundColor: colors.light.primary },
  tabText: {
    color: colors.light.foreground,
    fontWeight: "600",
    textTransform: "capitalize",
    fontSize: 13,
  },
  tabTextActive: { color: colors.light.primaryForeground },
  subTab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
  },
  subTabActive: {
    backgroundColor: colors.light.primary,
    borderColor: colors.light.primary,
  },
  subTabText: {
    color: colors.light.foreground,
    fontWeight: "600",
    textTransform: "capitalize",
    fontSize: 11,
  },
  subTabTextActive: { color: colors.light.primaryForeground },
  sectionTitle: {
    color: colors.light.foreground,
    fontWeight: "700",
    fontSize: 15,
    marginBottom: 6,
  },
  card: {
    backgroundColor: colors.light.card,
    borderColor: colors.light.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardTitle: { color: colors.light.foreground, fontWeight: "700", fontSize: 15 },
  cardMeta: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    marginTop: 4,
  },
  cardLink: {
    color: colors.light.primary,
    fontSize: 12,
    marginTop: 4,
    textDecorationLine: "underline",
  },
  actions: { flexDirection: "row", gap: 8, marginTop: 12 },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    flex: 1,
  },
  approveBtn: { backgroundColor: colors.light.primary },
  rejectBtn: {
    backgroundColor: colors.light.muted,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  actionTextLight: {
    color: colors.light.primaryForeground,
    fontWeight: "700",
    fontSize: 13,
  },
  actionTextDark: {
    color: colors.light.foreground,
    fontWeight: "700",
    fontSize: 13,
  },
  statusBadge: {
    color: colors.light.mutedForeground,
    textTransform: "uppercase",
    fontSize: 11,
    letterSpacing: 0.5,
    marginTop: 8,
  },
  activityBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  activityBadgeApproved: { backgroundColor: colors.light.primary },
  activityBadgeRejected: {
    backgroundColor: colors.light.muted,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  activityBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  userRow: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.light.border,
  },
  userRowSelected: { backgroundColor: colors.light.muted },
  empty: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    textAlign: "center",
    marginTop: 40,
  },
  modalScrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: colors.light.card,
    borderRadius: 16,
    padding: 18,
    width: "100%",
    maxWidth: 420,
  },
  modalTitle: {
    color: colors.light.foreground,
    fontWeight: "800",
    fontSize: 18,
  },
  modalInput: {
    backgroundColor: colors.light.input,
    color: colors.light.foreground,
    borderRadius: 10,
    padding: 12,
    minHeight: 80,
    marginTop: 12,
    textAlignVertical: "top",
  },
});
