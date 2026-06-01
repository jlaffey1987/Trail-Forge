/**
 * TrailForge first-launch onboarding.
 *
 * Five swipeable screens shown once after sign-up:
 *   0  Welcome       — live satellite map, trails light up one-by-one
 *   1  Find Trails   — grade-chip cards animate in with spring physics
 *   2  Plan Your Ride — route-segment builder animates in sequence
 *   3  Navigate      — nav-UI mockup with live rotating heading arrow
 *   4  Your Setup    — bike type picker + 1-10 experience level selector
 *
 * Animations use React Native's built-in Animated API (no Lottie needed).
 * Completion flag is written to AsyncStorage; users can redo from UserMenu.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ViewToken,
} from "react-native";
import MapView, {
  Polyline,
  PROVIDER_DEFAULT,
  PROVIDER_GOOGLE,
} from "react-native-maps";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import colors from "@/constants/colors";
import { patchPreferences } from "@/lib/api";
import { ONBOARDING_KEY, EXPERIENCE_KEY } from "@/lib/storageKeys";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const { width: W, height: H } = Dimensions.get("window");
const NUM_PAGES = 5;

// Approximate UK trail routes for the welcome-screen map animation.
// Colors correspond to TET difficulty grades (red = extreme, orange = hard, etc.)
const DEMO_TRAILS: Array<{
  coords: Array<{ latitude: number; longitude: number }>;
  color: string;
}> = [
  {
    color: "#ef4444",
    coords: [
      { latitude: 57.25, longitude: -4.62 },
      { latitude: 56.94, longitude: -4.31 },
      { latitude: 56.72, longitude: -3.92 },
      { latitude: 56.41, longitude: -3.60 },
    ],
  },
  {
    color: "#f97316",
    coords: [
      { latitude: 55.22, longitude: -3.10 },
      { latitude: 55.00, longitude: -2.82 },
      { latitude: 54.81, longitude: -2.53 },
      { latitude: 54.59, longitude: -2.22 },
    ],
  },
  {
    color: "#3b82f6",
    coords: [
      { latitude: 54.52, longitude: -3.20 },
      { latitude: 54.42, longitude: -2.95 },
      { latitude: 54.31, longitude: -2.72 },
      { latitude: 54.12, longitude: -2.45 },
    ],
  },
  {
    color: "#22c55e",
    coords: [
      { latitude: 53.58, longitude: -2.02 },
      { latitude: 53.38, longitude: -1.82 },
      { latitude: 53.18, longitude: -1.61 },
      { latitude: 52.98, longitude: -1.42 },
    ],
  },
  {
    color: "#22c55e",
    coords: [
      { latitude: 52.52, longitude: -3.41 },
      { latitude: 52.22, longitude: -3.12 },
      { latitude: 51.94, longitude: -2.83 },
      { latitude: 51.72, longitude: -2.54 },
    ],
  },
  {
    color: "#f97316",
    coords: [
      { latitude: 56.12, longitude: -4.10 },
      { latitude: 55.83, longitude: -3.81 },
      { latitude: 55.60, longitude: -3.51 },
      { latitude: 55.31, longitude: -3.22 },
    ],
  },
];

const GRADE_CHIPS = [
  { range: "1–3", label: "Easy",         color: "#22c55e" },
  { range: "4–6", label: "Intermediate", color: "#3b82f6" },
  { range: "7–9", label: "Hard",         color: "#f97316" },
  { range: "10",  label: "Extreme",      color: "#ef4444" },
] as const;

const ROUTE_SEGMENTS = [
  { type: "trail", color: "#22c55e", label: "Easy trail section",      meta: "23 km · ↑340 m" },
  { type: "road",  color: "#666666", label: "Road connector",          meta: null },
  { type: "trail", color: "#f97316", label: "Hard trail section",      meta: "18 km · ↑580 m" },
  { type: "road",  color: "#666666", label: "Road connector",          meta: null },
  { type: "trail", color: "#3b82f6", label: "Intermediate section",    meta: "31 km · ↑210 m" },
] as const;

type BikeType = "adventure" | "trail" | "enduro" | "all";

const BIKE_OPTIONS: Array<{
  id: BikeType;
  label: string;
  desc: string;
  emoji: string;
}> = [
  { id: "adventure", label: "Adventure", desc: "Tenere, Himalayan", emoji: "🏕️" },
  { id: "trail",     label: "Trail",     desc: "KTM 690, 701",     emoji: "⚡" },
  { id: "enduro",    label: "Enduro",    desc: "KTM 300, Beta",    emoji: "🔥" },
  { id: "all",       label: "Any",       desc: "All bikes",        emoji: "🏍️" },
];

function gradeColor(level: number): string {
  if (level <= 3) return "#22c55e";
  if (level <= 6) return "#3b82f6";
  if (level <= 9) return "#f97316";
  return "#ef4444";
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const insets = useSafeAreaInsets();
  const flatRef = useRef<FlatList>(null);

  const [page, setPage] = useState(0);
  const [bikeType, setBikeType] = useState<BikeType>("all");
  const [experience, setExperience] = useState(5);
  const [trailsVisible, setTrailsVisible] = useState(
    DEMO_TRAILS.map(() => false)
  );

  // ── Animated values ──────────────────────────────────────────────────────────
  // Screen 0
  const logoOpacity    = useRef(new Animated.Value(0)).current;
  const taglineOpacity = useRef(new Animated.Value(0)).current;
  const taglineY       = useRef(new Animated.Value(28)).current;

  // Screen 1
  const chipAnims = useRef(GRADE_CHIPS.map(() => new Animated.Value(0))).current;

  // Screen 2
  const segAnims  = useRef(ROUTE_SEGMENTS.map(() => new Animated.Value(0))).current;
  const statsAnim = useRef(new Animated.Value(0)).current;

  // Screen 3
  const arrowRot = useRef(new Animated.Value(0)).current;
  const navLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  // Screen 4
  const formOpacity = useRef(new Animated.Value(0)).current;

  // ── Per-page animation runners ───────────────────────────────────────────────

  // Screen 0 — satellite map + logo fade-in + trail polylines light up
  useEffect(() => {
    if (page !== 0) return;

    logoOpacity.setValue(0);
    taglineOpacity.setValue(0);
    taglineY.setValue(28);
    setTrailsVisible(DEMO_TRAILS.map(() => false));

    Animated.parallel([
      Animated.timing(logoOpacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.sequence([
        Animated.delay(380),
        Animated.parallel([
          Animated.timing(taglineOpacity, {
            toValue: 1, duration: 520, useNativeDriver: true,
          }),
          Animated.timing(taglineY, {
            toValue: 0, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true,
          }),
        ]),
      ]),
    ]).start();

    const timers: ReturnType<typeof setTimeout>[] = [];
    DEMO_TRAILS.forEach((_, idx) => {
      timers.push(
        setTimeout(() => {
          setTrailsVisible(prev => {
            const next = [...prev];
            next[idx] = true;
            return next;
          });
        }, 500 + idx * 700)
      );
    });
    return () => timers.forEach(clearTimeout);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  // Screen 1 — grade chips spring in with stagger
  useEffect(() => {
    if (page !== 1) return;
    chipAnims.forEach(a => a.setValue(0));
    Animated.stagger(
      140,
      chipAnims.map(a =>
        Animated.spring(a, { toValue: 1, tension: 65, friction: 8, useNativeDriver: true })
      )
    ).start();
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  // Screen 2 — route segments slide in sequentially
  useEffect(() => {
    if (page !== 2) return;
    segAnims.forEach(a => a.setValue(0));
    statsAnim.setValue(0);
    Animated.stagger(
      270,
      [
        ...segAnims.map(a =>
          Animated.timing(a, {
            toValue: 1, duration: 340,
            easing: Easing.out(Easing.back(1.4)),
            useNativeDriver: true,
          })
        ),
        Animated.timing(statsAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
      ]
    ).start();
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  // Screen 3 — navigation arrow rotates in a subtle loop
  useEffect(() => {
    if (page !== 3) {
      navLoopRef.current?.stop();
      return;
    }
    arrowRot.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(arrowRot, {
          toValue: 18, duration: 1300, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
        }),
        Animated.timing(arrowRot, {
          toValue: -8, duration: 1050, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
        }),
        Animated.timing(arrowRot, {
          toValue: 12, duration: 1150, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
        }),
        Animated.timing(arrowRot, {
          toValue: 0, duration: 950, easing: Easing.inOut(Easing.sin), useNativeDriver: true,
        }),
      ])
    );
    navLoopRef.current = loop;
    loop.start();
    return () => loop.stop();
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  // Screen 4 — form fades in
  useEffect(() => {
    if (page !== 4) return;
    formOpacity.setValue(0);
    Animated.timing(formOpacity, { toValue: 1, duration: 480, useNativeDriver: true }).start();
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Navigation helpers ───────────────────────────────────────────────────────

  const goToPage = useCallback((target: number) => {
    flatRef.current?.scrollToIndex({ index: target, animated: true });
    setPage(target);
  }, []);

  const handleSkip = useCallback(async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, "true");
    router.replace("/(tabs)");
  }, []);

  const handleStart = useCallback(async () => {
    await AsyncStorage.multiSet([
      [ONBOARDING_KEY, "true"],
      [EXPERIENCE_KEY, String(experience)],
    ]);
    try {
      await patchPreferences({ preferred_bike_type: bikeType });
    } catch {
      // Non-fatal — bike type can be updated later from the map filters
    }
    router.replace("/(tabs)");
  }, [bikeType, experience]);

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems[0]?.index != null) setPage(viewableItems[0].index);
    }
  ).current;

  const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 50 }).current;

  // ── Derived animated values ──────────────────────────────────────────────────

  const arrowRotDeg = arrowRot.interpolate({
    inputRange: [-30, 30],
    outputRange: ["-30deg", "30deg"],
  });

  // ── Screen 0: Welcome ────────────────────────────────────────────────────────

  const renderWelcome = () => (
    <View style={styles.screen}>
      <MapView
        style={StyleSheet.absoluteFill}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        initialRegion={{
          latitude: 54.5,
          longitude: -3.2,
          latitudeDelta: 10,
          longitudeDelta: 10,
        }}
        mapType="satellite"
        scrollEnabled={false}
        zoomEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        showsUserLocation={false}
        showsCompass={false}
        toolbarEnabled={false}
      >
        {DEMO_TRAILS.map((trail, idx) =>
          trailsVisible[idx] ? (
            <Polyline
              key={idx}
              coordinates={trail.coords}
              strokeColor={trail.color}
              strokeWidth={3.5}
            />
          ) : null
        )}
      </MapView>

      {/* Layered overlays simulate a bottom-fade gradient */}
      <View style={[styles.overlay, { opacity: 0.25, height: H }]} />
      <View style={[styles.overlay, { opacity: 0.55, height: H * 0.7 }]} />
      <View style={[styles.overlay, { opacity: 0.75, height: H * 0.5 }]} />

      {/* Logo — fades in from top third */}
      <Animated.View
        style={[
          styles.logoWrap,
          { top: insets.top + 56, opacity: logoOpacity },
        ]}
      >
        <View style={styles.logoIconBg}>
          <Feather name="map" size={28} color={colors.light.primary} />
        </View>
        <Text style={styles.logoText}>TrailForge</Text>
      </Animated.View>

      {/* Tagline — slides up from bottom third */}
      <Animated.View
        style={[
          styles.taglineWrap,
          {
            bottom: H * 0.32,
            opacity: taglineOpacity,
            transform: [{ translateY: taglineY }],
          },
        ]}
      >
        <Text style={styles.tagline}>
          The trail riding app built for{"\n"}riders, by riders
        </Text>
      </Animated.View>
    </View>
  );

  // ── Screen 1: Find Your Trails ───────────────────────────────────────────────

  const renderFindTrails = () => (
    <View style={[styles.screen, styles.darkBg]}>
      <View style={[styles.pad, { paddingTop: insets.top + 52 }]}>
        <View style={styles.iconPill}>
          <Feather name="sliders" size={20} color={colors.light.primary} />
        </View>

        <Text style={styles.screenTitle}>
          Find trails that{"\n"}match your ability
        </Text>

        <View style={styles.chipGrid}>
          {GRADE_CHIPS.map(({ range, label, color }, idx) => (
            <Animated.View
              key={range}
              style={[
                styles.gradeCard,
                { borderColor: color, backgroundColor: color + "1a" },
                {
                  opacity: chipAnims[idx],
                  transform: [
                    {
                      scale: chipAnims[idx].interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.55, 1],
                      }),
                    },
                    {
                      translateY: chipAnims[idx].interpolate({
                        inputRange: [0, 1],
                        outputRange: [52, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
              <View style={[styles.gradeBar, { backgroundColor: color }]} />
              <Text style={[styles.gradeRange, { color }]}>Grade {range}</Text>
              <Text style={styles.gradeCardLabel}>{label}</Text>
            </Animated.View>
          ))}
        </View>

        <Animated.Text
          style={[
            styles.helperText,
            {
              opacity: chipAnims[3].interpolate({
                inputRange: [0, 1],
                outputRange: [0, 1],
              }),
            },
          ]}
        >
          Filter by difficulty, bike type, and terrain
        </Animated.Text>
      </View>
    </View>
  );

  // ── Screen 2: Plan Your Ride ─────────────────────────────────────────────────

  const renderPlanRide = () => (
    <View style={[styles.screen, styles.darkBg]}>
      <View style={[styles.pad, { paddingTop: insets.top + 52 }]}>
        <View style={styles.iconPill}>
          <Feather name="git-merge" size={20} color={colors.light.primary} />
        </View>

        <Text style={styles.screenTitle}>
          Link trails into{"\n"}a full day's ride
        </Text>

        <View style={styles.routeVis}>
          {ROUTE_SEGMENTS.map((seg, idx) => (
            <Animated.View
              key={idx}
              style={[
                styles.routeRow,
                {
                  opacity: segAnims[idx],
                  transform: [{
                    translateX: segAnims[idx].interpolate({
                      inputRange: [0, 1],
                      outputRange: [-36, 0],
                    }),
                  }],
                },
              ]}
            >
              {/* Vertical timeline */}
              <View style={styles.timelineCol}>
                <View style={[styles.timelineNode, { borderColor: seg.color }]} />
                {idx < ROUTE_SEGMENTS.length - 1 && (
                  <View
                    style={[
                      styles.timelineLine,
                      seg.type === "road"
                        ? styles.timelineLineDashed
                        : { backgroundColor: seg.color + "aa" },
                    ]}
                  />
                )}
              </View>

              {/* Label */}
              <View style={styles.routeLabelCol}>
                <Text
                  style={[
                    styles.routeSegLabel,
                    { color: seg.type === "road" ? "#778" : seg.color },
                  ]}
                >
                  {seg.label}
                </Text>
                {seg.meta && (
                  <Text style={styles.routeSegMeta}>{seg.meta}</Text>
                )}
              </View>
            </Animated.View>
          ))}

          {/* Summary stats card */}
          <Animated.View style={[styles.statsCard, { opacity: statsAnim }]}>
            {[
              { v: "156 km", l: "Total" },
              { v: "72 km",  l: "Trails" },
              { v: "~7 h",   l: "Est. time" },
            ].map(({ v, l }) => (
              <View key={l} style={styles.statItem}>
                <Text style={styles.statVal}>{v}</Text>
                <Text style={styles.statLbl}>{l}</Text>
              </View>
            ))}
          </Animated.View>
        </View>
      </View>
    </View>
  );

  // ── Screen 3: Navigate ───────────────────────────────────────────────────────

  const renderNavigate = () => (
    <View style={[styles.screen, styles.darkBg]}>
      <View style={[styles.pad, { paddingTop: insets.top + 52 }]}>
        <View style={styles.iconPill}>
          <Feather name="compass" size={20} color={colors.light.primary} />
        </View>

        <Text style={styles.screenTitle}>
          Turn by turn navigation{"\n"}built for trails
        </Text>

        {/* Navigation UI mockup */}
        <View style={styles.navMockup}>
          {/* Turn instruction */}
          <View style={styles.navInstRow}>
            <Animated.View
              style={[
                styles.navArrowBtn,
                { transform: [{ rotate: arrowRotDeg }] },
              ]}
            >
              <Feather name="arrow-up" size={36} color="#fff" />
            </Animated.View>
            <View style={styles.navInstText}>
              <Text style={styles.navDistText}>In 200 m</Text>
              <Text style={styles.navActionText}>Continue straight</Text>
            </View>
          </View>

          {/* Trail entry banner */}
          <View style={styles.trailBanner}>
            <View style={styles.trailBannerDot} />
            <Text style={styles.trailBannerText}>
              Entering trail section · Grade 7
            </Text>
          </View>

          {/* Bottom info bar */}
          <View style={styles.navBarRow}>
            {[
              { v: "43 km",   l: "Remaining" },
              { v: "2h 15m", l: "ETA" },
              { v: "24",     l: "km/h" },
            ].map(({ v, l }) => (
              <View key={l} style={styles.navBarItem}>
                <Text style={styles.navBarVal}>{v}</Text>
                <Text style={styles.navBarLbl}>{l}</Text>
              </View>
            ))}
          </View>
        </View>

        <Text style={styles.helperText}>
          Voice prompts · Trail warnings · Off-route recalculation
        </Text>
      </View>
    </View>
  );

  // ── Screen 4: Your Setup ─────────────────────────────────────────────────────

  const renderSetup = () => (
    <View style={[styles.screen, styles.darkBg]}>
      <Animated.View style={[{ flex: 1, opacity: formOpacity }]}>
        <ScrollView
          contentContainerStyle={[
            styles.pad,
            { paddingTop: insets.top + 36, paddingBottom: insets.bottom + 32 },
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.setupTitle}>Your setup</Text>
          <Text style={styles.setupSub}>
            We'll personalise your trail recommendations
          </Text>

          {/* Bike type selector */}
          <Text style={styles.formLabel}>What do you ride?</Text>
          <View style={styles.bikeGrid}>
            {BIKE_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.id}
                style={[
                  styles.bikeCard,
                  bikeType === opt.id && styles.bikeCardActive,
                ]}
                onPress={() => setBikeType(opt.id)}
                activeOpacity={0.72}
              >
                <Text style={styles.bikeEmoji}>{opt.emoji}</Text>
                <Text
                  style={[
                    styles.bikeName,
                    bikeType === opt.id && styles.bikeNameActive,
                  ]}
                >
                  {opt.label}
                </Text>
                <Text style={styles.bikeDesc}>{opt.desc}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Experience level selector */}
          <Text style={[styles.formLabel, { marginTop: 28 }]}>
            Rate your experience
          </Text>
          <View style={styles.expRow}>
            {Array.from({ length: 10 }, (_, i) => i + 1).map(level => {
              const active = level <= experience;
              const col = gradeColor(level);
              return (
                <TouchableOpacity
                  key={level}
                  style={[
                    styles.expChip,
                    active && { backgroundColor: col, borderColor: col },
                  ]}
                  onPress={() => setExperience(level)}
                >
                  <Text
                    style={[
                      styles.expChipNum,
                      active && { color: "#fff" },
                    ]}
                  >
                    {level}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={styles.expLabels}>
            <Text style={styles.expLabelTxt}>😅 Beginner</Text>
            <Text style={styles.expLabelTxt}>🔥 Expert</Text>
          </View>

          {/* CTA */}
          <TouchableOpacity
            style={styles.startBtn}
            onPress={handleStart}
            activeOpacity={0.8}
          >
            <Text style={styles.startBtnTxt}>Start Riding</Text>
            <Feather name="arrow-right" size={20} color="#fff" />
          </TouchableOpacity>
        </ScrollView>
      </Animated.View>
    </View>
  );

  // ── FlatList page renderer ───────────────────────────────────────────────────

  const RENDER_FNS = [
    renderWelcome,
    renderFindTrails,
    renderPlanRide,
    renderNavigate,
    renderSetup,
  ];

  // ── Root render ──────────────────────────────────────────────────────────────

  return (
    <View style={styles.root}>
      <StatusBar
        barStyle="light-content"
        translucent
        backgroundColor="transparent"
      />

      <FlatList
        ref={flatRef}
        data={Array.from({ length: NUM_PAGES }, (_, i) => i)}
        keyExtractor={i => String(i)}
        renderItem={({ item: idx }) => RENDER_FNS[idx]()}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        scrollEventThrottle={16}
        getItemLayout={(_, index) => ({
          length: W,
          offset: W * index,
          index,
        })}
        bounces={false}
      />

      {/* Skip button — shown on screens 0–3 */}
      {page < 4 && (
        <TouchableOpacity
          style={[styles.skipBtn, { top: insets.top + 14 }]}
          onPress={handleSkip}
          hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }}
        >
          <Text style={styles.skipTxt}>Skip</Text>
        </TouchableOpacity>
      )}

      {/* Progress dots — shown on screens 0–3 */}
      {page < 4 && (
        <View style={[styles.dotsRow, { bottom: insets.bottom + 114 }]}>
          {Array.from({ length: NUM_PAGES }).map((_, i) => (
            <TouchableOpacity
              key={i}
              onPress={() => goToPage(i)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Animated.View
                style={[styles.dot, i === page && styles.dotActive]}
              />
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Bottom CTA — shown on screens 0–3 */}
      {page < 4 && (
        <View
          style={[
            styles.bottomCta,
            { bottom: insets.bottom + 36 },
          ]}
        >
          {page === 0 ? (
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => goToPage(1)}
              activeOpacity={0.8}
            >
              <Text style={styles.primaryBtnTxt}>Let's get started</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.ghostBtn}
              onPress={() => goToPage(page + 1)}
              activeOpacity={0.8}
            >
              <Text style={styles.ghostBtnTxt}>Next</Text>
              <Feather name="chevron-right" size={18} color={colors.light.primary} />
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
  },
  screen: {
    width: W,
    height: H,
    overflow: "hidden",
  },
  darkBg: {
    backgroundColor: colors.light.background,
  },
  pad: {
    flex: 1,
    paddingHorizontal: 24,
  },

  // ── Screen 0: Welcome ─────────────────────────────────────────────────────────
  overlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000",
  },
  logoWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  logoIconBg: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: "rgba(210,139,13,0.18)",
    borderWidth: 1.5,
    borderColor: colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: {
    color: "#fff",
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: -1.2,
  },
  taglineWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: 32,
  },
  tagline: {
    color: "rgba(255,255,255,0.88)",
    fontSize: 21,
    fontWeight: "500",
    textAlign: "center",
    lineHeight: 31,
  },

  // ── Shared chrome ────────────────────────────────────────────────────────────
  iconPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.light.primary + "1e",
    borderWidth: 1,
    borderColor: colors.light.primary + "55",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 100,
    marginBottom: 18,
  },
  screenTitle: {
    color: colors.light.foreground,
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.8,
    lineHeight: 38,
    marginBottom: 28,
  },
  helperText: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    textAlign: "center",
    marginTop: 18,
    lineHeight: 19,
  },

  // ── Screen 1: Grade chips ────────────────────────────────────────────────────
  chipGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  gradeCard: {
    width: (W - 48 - 12) / 2,
    borderWidth: 1.5,
    borderRadius: 18,
    padding: 18,
  },
  gradeBar: {
    width: 28,
    height: 4,
    borderRadius: 2,
    marginBottom: 10,
  },
  gradeRange: {
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: -0.5,
    marginBottom: 2,
  },
  gradeCardLabel: {
    color: colors.light.mutedForeground,
    fontSize: 13,
    fontWeight: "500",
  },

  // ── Screen 2: Route planner ──────────────────────────────────────────────────
  routeVis: {
    gap: 0,
  },
  routeRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    minHeight: 52,
  },
  timelineCol: {
    width: 28,
    alignItems: "center",
    paddingTop: 3,
  },
  timelineNode: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    backgroundColor: colors.light.background,
  },
  timelineLine: {
    width: 2,
    flex: 1,
    minHeight: 32,
    marginTop: 2,
  },
  timelineLineDashed: {
    width: 2,
    flex: 1,
    minHeight: 32,
    marginTop: 2,
    backgroundColor: "#444",
  },
  routeLabelCol: {
    flex: 1,
    paddingLeft: 12,
    paddingBottom: 22,
  },
  routeSegLabel: {
    fontSize: 15,
    fontWeight: "600",
  },
  routeSegMeta: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    marginTop: 3,
  },
  statsCard: {
    flexDirection: "row",
    backgroundColor: colors.light.card,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 8,
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  statItem: {
    flex: 1,
    alignItems: "center",
  },
  statVal: {
    color: colors.light.primary,
    fontSize: 19,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  statLbl: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    marginTop: 2,
    fontWeight: "500",
  },

  // ── Screen 3: Navigation ─────────────────────────────────────────────────────
  navMockup: {
    borderRadius: 20,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  navInstRow: {
    backgroundColor: "#1a1a1e",
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    padding: 18,
  },
  navArrowBtn: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.light.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 6,
  },
  navInstText: {
    flex: 1,
  },
  navDistText: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 13,
    fontWeight: "500",
  },
  navActionText: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "700",
    marginTop: 2,
  },
  trailBanner: {
    backgroundColor: "#f9731618",
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#f9731633",
  },
  trailBannerDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#f97316",
  },
  trailBannerText: {
    color: "#f97316",
    fontSize: 13,
    fontWeight: "600",
  },
  navBarRow: {
    backgroundColor: "#111114",
    flexDirection: "row",
    paddingVertical: 14,
    paddingHorizontal: 4,
  },
  navBarItem: {
    flex: 1,
    alignItems: "center",
  },
  navBarVal: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  navBarLbl: {
    color: "rgba(255,255,255,0.45)",
    fontSize: 10,
    marginTop: 2,
    fontWeight: "500",
  },

  // ── Screen 4: Setup ──────────────────────────────────────────────────────────
  setupTitle: {
    color: colors.light.foreground,
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.8,
    marginBottom: 6,
  },
  setupSub: {
    color: colors.light.mutedForeground,
    fontSize: 15,
    marginBottom: 28,
    lineHeight: 22,
  },
  formLabel: {
    color: colors.light.foreground,
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 14,
  },
  bikeGrid: {
    flexDirection: "row",
    gap: 8,
  },
  bikeCard: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 4,
  },
  bikeCardActive: {
    borderColor: colors.light.primary,
    backgroundColor: colors.light.primary + "1a",
  },
  bikeEmoji: {
    fontSize: 22,
    marginBottom: 7,
  },
  bikeName: {
    color: colors.light.foreground,
    fontSize: 12,
    fontWeight: "700",
    textAlign: "center",
  },
  bikeNameActive: {
    color: colors.light.primary,
  },
  bikeDesc: {
    color: colors.light.mutedForeground,
    fontSize: 9,
    textAlign: "center",
    marginTop: 3,
  },
  expRow: {
    flexDirection: "row",
    gap: 5,
  },
  expChip: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    alignItems: "center",
    justifyContent: "center",
  },
  expChipNum: {
    color: colors.light.mutedForeground,
    fontSize: 12,
    fontWeight: "700",
  },
  expLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 7,
    marginBottom: 4,
  },
  expLabelTxt: {
    color: colors.light.mutedForeground,
    fontSize: 12,
  },
  startBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.light.primary,
    borderRadius: 14,
    paddingVertical: 16,
    marginTop: 24,
    shadowColor: colors.light.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 6,
  },
  startBtnTxt: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: -0.3,
  },

  // ── Global overlays ──────────────────────────────────────────────────────────
  skipBtn: {
    position: "absolute",
    right: 18,
    zIndex: 100,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.38)",
  },
  skipTxt: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 14,
    fontWeight: "600",
  },
  dotsRow: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 7,
    zIndex: 100,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.32)",
  },
  dotActive: {
    width: 22,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.light.primary,
  },
  bottomCta: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 100,
    paddingHorizontal: 24,
  },
  primaryBtn: {
    width: "100%",
    backgroundColor: colors.light.primary,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    shadowColor: colors.light.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 6,
  },
  primaryBtnTxt: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  ghostBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.light.primary + "60",
    backgroundColor: colors.light.primary + "10",
  },
  ghostBtnTxt: {
    color: colors.light.primary,
    fontSize: 15,
    fontWeight: "700",
  },
});
