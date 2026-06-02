/**
 * Trail rating screen — opened from trail detail or push notification.
 * Query params: trailId, trailName
 *
 * One tap on the overall stars submits immediately.
 * "Add more detail" expands category breakdown + optional review text.
 */

import { Feather } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import colors from "@/constants/colors";
import { submitTrailRating, getMyTrailRating, type SubmitRatingInput } from "@/lib/api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const AMBER = colors.light.primary;
const BG    = colors.light.background;
const CARD  = colors.light.card;

// ── Star row ─────────────────────────────────────────────────────────────────

function StarRow({
  value,
  onChange,
  size = 40,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  size?: number;
  label?: string;
}) {
  return (
    <View style={{ marginBottom: label ? 16 : 0 }}>
      {label && <Text style={rs.catLabel}>{label}</Text>}
      <View style={{ flexDirection: "row", gap: 6 }}>
        {[1, 2, 3, 4, 5].map(n => (
          <TouchableOpacity key={n} onPress={() => onChange(n)} hitSlop={6} style={{ minWidth: size, minHeight: size, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: size, color: n <= value ? AMBER : "#333" }}>★</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// ── Season picker ─────────────────────────────────────────────────────────────

const SEASONS = [
  { id: "spring" as const, emoji: "🌸", label: "Spring" },
  { id: "summer" as const, emoji: "☀️",  label: "Summer" },
  { id: "autumn" as const, emoji: "🍂", label: "Autumn" },
  { id: "winter" as const, emoji: "❄️",  label: "Winter" },
];

// ── Main screen ───────────────────────────────────────────────────────────────

export default function RateScreen() {
  const { trailId, trailName } = useLocalSearchParams<{ trailId: string; trailName?: string }>();
  const id   = String(trailId ?? "");
  const name = String(trailName ?? "Trail");
  const qc   = useQueryClient();

  // Fetch existing rating (if any)
  const existingQ = useQuery({
    queryKey: ["my-rating", id],
    queryFn: () => getMyTrailRating(id),
    enabled: id.length > 0,
  });
  const existing = existingQ.data?.rating;

  // Local state
  const [overall,  setOverall]  = useState(existing?.overall_stars  ?? 0);
  const [scenery,  setScenery]  = useState(existing?.scenery_stars  ?? 0);
  const [surface,  setSurface]  = useState(existing?.surface_stars  ?? 0);
  const [accuracy, setAccuracy] = useState(existing?.accuracy_stars ?? 0);
  const [fun,      setFun]      = useState(existing?.fun_stars      ?? 0);
  const [review,   setReview]   = useState(existing?.review_text    ?? "");
  const [season,   setSeason]   = useState<SubmitRatingInput["season"]>(existing?.season ?? null);
  const [riderGrade, setRiderGrade] = useState(existing?.rider_difficulty ?? 5);
  const [expanded, setExpanded]    = useState(false);
  const [submitted, setSubmitted]  = useState(false);

  // Sync from existing once loaded
  React.useEffect(() => {
    if (!existing) return;
    setOverall(existing.overall_stars);
    setScenery(existing.scenery_stars ?? 0);
    setSurface(existing.surface_stars ?? 0);
    setAccuracy(existing.accuracy_stars ?? 0);
    setFun(existing.fun_stars ?? 0);
    setReview(existing.review_text ?? "");
    setSeason(existing.season ?? null);
    setRiderGrade(existing.rider_difficulty);
  }, [existing]);

  const mut = useMutation({
    mutationFn: (input: SubmitRatingInput) => submitTrailRating(id, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["trail-ratings", id] });
      void qc.invalidateQueries({ queryKey: ["my-rating", id] });
      setSubmitted(true);
      setTimeout(() => router.back(), 1500);
    },
    onError: (e) => Alert.alert("Rating failed", e instanceof Error ? e.message : "Unknown error"),
  });

  async function submit(overallStars: number) {
    const input: SubmitRatingInput = {
      rider_difficulty: riderGrade,
      overall_stars:    overallStars,
      scenery_stars:    scenery  || null,
      surface_stars:    surface  || null,
      accuracy_stars:   accuracy || null,
      fun_stars:        fun      || null,
      review_text:      review.trim() || null,
      season,
    };
    mut.mutate(input);
  }

  if (existingQ.isLoading) {
    return <View style={{ flex: 1, backgroundColor: BG, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator color={AMBER} />
    </View>;
  }

  if (submitted) {
    return (
      <View style={{ flex: 1, backgroundColor: BG, alignItems: "center", justifyContent: "center", gap: 16 }}>
        <Text style={{ fontSize: 64 }}>✅</Text>
        <Text style={{ color: "#fff", fontSize: 22, fontWeight: "800" }}>Rated!</Text>
        <Text style={{ color: colors.light.mutedForeground }}>Thanks for helping the community</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: BG }}>
      <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 80 }}>
        {/* Back */}
        <TouchableOpacity onPress={() => router.back()} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 24 }}>
          <Feather name="arrow-left" size={20} color={AMBER} />
        </TouchableOpacity>

        <Text style={rs.header}>{name}</Text>
        <Text style={rs.subheader}>HOW WAS IT?</Text>

        {/* Overall stars — large, immediate submit */}
        <View style={rs.overallRow}>
          {[1, 2, 3, 4, 5].map(n => (
            <TouchableOpacity
              key={n}
              onPress={() => { setOverall(n); if (!expanded) void submit(n); }}
              disabled={mut.isPending}
              style={rs.bigStar}
            >
              {mut.isPending && overall === n
                ? <ActivityIndicator color={AMBER} />
                : <Text style={[rs.bigStarText, { color: n <= overall ? AMBER : "#333" }]}>★</Text>
              }
            </TouchableOpacity>
          ))}
        </View>
        <Text style={rs.overallHint}>
          {overall === 0 ? "Tap a star to rate instantly" : `You rated this ${overall} star${overall !== 1 ? "s" : ""}`}
        </Text>

        {/* Your grade — contextual weighting */}
        <View style={rs.gradeRow}>
          <Text style={rs.gradeLabel}>YOUR RIDING LEVEL (for weighting)</Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            {[1,2,3,4,5,6,7,8,9,10].map(g => (
              <TouchableOpacity
                key={g}
                onPress={() => setRiderGrade(g)}
                style={[rs.gradeChip, riderGrade === g && { backgroundColor: AMBER }]}
              >
                <Text style={[rs.gradeChipText, riderGrade === g && { color: "#000" }]}>{g}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Expand for more detail */}
        <TouchableOpacity
          onPress={() => setExpanded(e => !e)}
          style={rs.expandBtn}
        >
          <Feather name={expanded ? "chevron-up" : "chevron-down"} size={16} color={AMBER} />
          <Text style={rs.expandText}>{expanded ? "Less detail" : "Add more detail →"}</Text>
        </TouchableOpacity>

        {expanded && (
          <>
            {/* Category ratings */}
            <View style={rs.catGrid}>
              <StarRow value={scenery}  onChange={setScenery}  size={28} label="🌄 Scenery" />
              <StarRow value={surface}  onChange={setSurface}  size={28} label="🛤️  Surface" />
              <StarRow value={accuracy} onChange={setAccuracy} size={28} label="📍 GPS Accuracy" />
              <StarRow value={fun}      onChange={setFun}      size={28} label="⚡ Fun Factor" />
            </View>

            {/* Season */}
            <Text style={rs.catLabel}>SEASON RIDDEN</Text>
            <View style={rs.seasonRow}>
              {SEASONS.map(s => (
                <TouchableOpacity
                  key={s.id}
                  onPress={() => setSeason(prev => prev === s.id ? null : s.id)}
                  style={[rs.seasonChip, season === s.id && rs.seasonChipActive]}
                >
                  <Text style={rs.seasonEmoji}>{s.emoji}</Text>
                  <Text style={[rs.seasonLabel, season === s.id && { color: "#000" }]}>{s.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Review text */}
            <Text style={rs.catLabel}>REVIEW (optional)</Text>
            <TextInput
              value={review}
              onChangeText={setReview}
              placeholder="Share what riders need to know…"
              placeholderTextColor={colors.light.mutedForeground}
              style={rs.reviewInput}
              multiline
              maxLength={500}
              textAlignVertical="top"
            />
            <Text style={{ color: colors.light.mutedForeground, fontSize: 11, textAlign: "right" }}>
              {review.length}/500
            </Text>

            {/* Submit */}
            <TouchableOpacity
              style={[rs.submitBtn, (overall === 0 || mut.isPending) && { opacity: 0.4 }]}
              onPress={() => overall > 0 && void submit(overall)}
              disabled={overall === 0 || mut.isPending}
            >
              {mut.isPending
                ? <ActivityIndicator color="#000" />
                : <Text style={rs.submitText}>SUBMIT RATING</Text>
              }
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const rs = StyleSheet.create({
  header:      { color: "#fff", fontSize: 22, fontWeight: "800", marginBottom: 4 },
  subheader:   { color: colors.light.mutedForeground, fontSize: 11, fontWeight: "800", letterSpacing: 1.5, marginBottom: 28 },
  overallRow:  { flexDirection: "row", justifyContent: "space-between", marginBottom: 10 },
  bigStar:     { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 64 },
  bigStarText: { fontSize: 56 },
  overallHint: { color: colors.light.mutedForeground, fontSize: 13, textAlign: "center", marginBottom: 28 },

  gradeRow:  { backgroundColor: CARD, borderRadius: 14, padding: 16, marginBottom: 16 },
  gradeLabel:{ color: colors.light.mutedForeground, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  gradeChip: { width: 40, height: 40, borderRadius: 10, backgroundColor: colors.light.cardElevated, alignItems: "center", justifyContent: "center" },
  gradeChipText: { color: "#fff", fontWeight: "700", fontSize: 14 },

  expandBtn:  { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 20 },
  expandText: { color: AMBER, fontSize: 14, fontWeight: "700" },

  catGrid:    { gap: 4, marginBottom: 20 },
  catLabel:   { color: colors.light.mutedForeground, fontSize: 10, fontWeight: "800", letterSpacing: 1.2, marginBottom: 8, textTransform: "uppercase" },

  seasonRow:   { flexDirection: "row", gap: 8, flexWrap: "wrap", marginBottom: 20 },
  seasonChip:  { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: CARD, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1.5, borderColor: colors.light.border },
  seasonChipActive: { backgroundColor: AMBER, borderColor: AMBER },
  seasonEmoji: { fontSize: 16 },
  seasonLabel: { color: "#fff", fontSize: 13, fontWeight: "600" },

  reviewInput: { backgroundColor: CARD, borderRadius: 12, color: "#fff", fontSize: 15, padding: 14, minHeight: 100, marginBottom: 6 },
  submitBtn:   { backgroundColor: AMBER, borderRadius: 14, height: 72, alignItems: "center", justifyContent: "center", marginTop: 16 },
  submitText:  { color: "#000", fontSize: 18, fontWeight: "900", letterSpacing: 0.5 },
});
