/**
 * Intro splash screen — shown once on first launch.
 *
 * No video file found in assets, so we create a beautiful animated
 * React Native splash instead:
 *
 *   1. Dark #0D0D0D background fades in
 *   2. Amber trail network "lights up" from south to north
 *   3. TrailForge logo drops in with bounce
 *   4. Tagline types out: "Ride Further. Ride Smarter."
 *   5. Amber vignette edges pulse
 *   6. Auto-transitions to onboarding after 3.5 s
 *   7. Skip button fades in after 1.5 s
 *
 * Stored flag: @trailforge/intro_seen in AsyncStorage.
 * Never shows again after first play.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import React, { useEffect, useRef } from "react";
import {
  Animated,
  Dimensions,
  Easing,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ONBOARDING_KEY, INTRO_SEEN_KEY } from "@/lib/storageKeys";
const { width: W, height: H } = Dimensions.get("window");

// UK trail network — amber polylines lighting up
const TRAIL_PATHS = [
  // Scotland south
  "M 140,80 C 150,110 145,140 138,175",
  // Border country
  "M 138,175 C 130,200 145,220 150,250",
  // Northern England
  "M 150,250 C 155,280 148,310 152,340",
  // Midlands west
  "M 90,340 C 110,360 140,375 152,400",
  // Wales
  "M 80,310 C 70,340 75,370 80,400",
  // South West
  "M 152,400 C 148,430 140,460 130,490",
  // Scotland east
  "M 200,90 C 195,120 188,150 180,185",
  // Yorkshire
  "M 180,280 C 185,305 178,330 175,360",
  // Peak District
  "M 160,370 C 165,390 162,410 158,435",
] as const;

// Animated trail component
function AnimatedTrail({
  path,
  delay,
  color,
}: {
  path: string;
  delay: number;
  color: string;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(10)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.delay(delay),
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    ]).start();
  }, []);

  return (
    <Animated.View style={{ opacity, transform: [{ translateY }] }}>
      <Svg width={W} height={H} style={StyleSheet.absoluteFill} viewBox={`0 0 ${W} ${H}`}>
        <Path d={path} stroke={color} strokeWidth={2.5} fill="none" strokeLinecap="round" />
      </Svg>
    </Animated.View>
  );
}

export default function IntroScreen() {
  const insets = useSafeAreaInsets();

  // Animation refs
  const bgOpacity      = useRef(new Animated.Value(0)).current;
  const logoScale      = useRef(new Animated.Value(0.3)).current;
  const logoOpacity    = useRef(new Animated.Value(0)).current;
  const taglineOpacity = useRef(new Animated.Value(0)).current;
  const skipOpacity    = useRef(new Animated.Value(0)).current;
  const vignetteAnim   = useRef(new Animated.Value(0.4)).current;

  // Tagline typewriter effect
  const tagline = "Ride Further. Ride Smarter.";
  const charAnims = useRef(
    Array.from({ length: tagline.length }, () => new Animated.Value(0))
  ).current;

  async function proceed() {
    await AsyncStorage.setItem(INTRO_SEEN_KEY, "true");
    // Check if onboarding already done
    const obDone = await AsyncStorage.getItem(ONBOARDING_KEY);
    if (obDone) {
      router.replace("/(tabs)/map" as never);
    } else {
      router.replace("/onboarding" as unknown as Parameters<typeof router.replace>[0]);
    }
  }

  useEffect(() => {
    // Phase 1: background fade
    Animated.timing(bgOpacity, {
      toValue: 1, duration: 500, useNativeDriver: true,
    }).start();

    // Phase 2: logo bounce in (after 0.8s)
    Animated.sequence([
      Animated.delay(800),
      Animated.parallel([
        Animated.spring(logoScale, {
          toValue: 1, tension: 60, friction: 6, useNativeDriver: true,
        }),
        Animated.timing(logoOpacity, {
          toValue: 1, duration: 400, useNativeDriver: true,
        }),
      ]),
    ]).start();

    // Phase 3: typewriter tagline (after 1.4s)
    const charSequence = charAnims.map((anim, i) =>
      Animated.sequence([
        Animated.delay(i * 45),
        Animated.timing(anim, { toValue: 1, duration: 80, useNativeDriver: true }),
      ])
    );
    Animated.sequence([
      Animated.delay(1400),
      Animated.stagger(0, charSequence),
    ]).start();

    // Phase 4: skip button (after 1.5s)
    Animated.sequence([
      Animated.delay(1500),
      Animated.timing(skipOpacity, { toValue: 1, duration: 400, useNativeDriver: true }),
    ]).start();

    // Phase 5: vignette pulse loop
    Animated.loop(
      Animated.sequence([
        Animated.timing(vignetteAnim, { toValue: 0.7, duration: 2000, useNativeDriver: true }),
        Animated.timing(vignetteAnim, { toValue: 0.4, duration: 2000, useNativeDriver: true }),
      ])
    ).start();

    // Phase 6: auto-proceed after 3.5s
    const t = setTimeout(() => void proceed(), 3500);
    return () => clearTimeout(t);
  }, []);

  // Trail colors: lights up south→north in amber shades
  const trailColors = [
    "#FFD080", "#F5A623", "#FFB74D", "#F5A623", "#FF8F00",
    "#FFD080", "#F5A623", "#FFB74D", "#FF8F00",
  ];

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />

      {/* Background fade */}
      <Animated.View style={[StyleSheet.absoluteFill, s.bg, { opacity: bgOpacity }]} />

      {/* Animated trail network — south to north */}
      {TRAIL_PATHS.map((path, i) => (
        <AnimatedTrail
          key={i}
          path={path}
          delay={200 + i * 150}
          color={trailColors[i % trailColors.length] ?? "#F5A623"}
        />
      ))}

      {/* Amber vignette edges */}
      <Animated.View style={[s.vignette, { opacity: vignetteAnim }]} pointerEvents="none" />

      {/* Skip button */}
      <Animated.View style={[s.skipWrap, { top: insets.top + 12, opacity: skipOpacity }]}>
        <TouchableOpacity style={s.skipBtn} onPress={() => void proceed()}>
          <Text style={s.skipTxt}>Skip</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Logo */}
      <Animated.View
        style={[
          s.logoWrap,
          { transform: [{ scale: logoScale }], opacity: logoOpacity },
        ]}
      >
        <View style={s.logoIcon}>
          <Svg width={32} height={32} viewBox="0 0 32 32">
            <Path
              d="M16 2 L28 26 L16 21 L4 26 Z"
              fill="#F5A623"
            />
          </Svg>
        </View>
        <Text style={s.logoText}>TrailForge</Text>
      </Animated.View>

      {/* Tagline typewriter */}
      <Animated.View style={[s.taglineWrap]}>
        <Text style={s.tagline}>
          {tagline.split("").map((char, i) => (
            <Animated.Text key={i} style={{ opacity: charAnims[i] }}>
              {char}
            </Animated.Text>
          ))}
        </Text>
      </Animated.View>
    </View>
  );
}

const AMBER = "#F5A623";

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0D0D0D", alignItems: "center", justifyContent: "center" },
  bg: { backgroundColor: "#0D0D0D" },

  vignette: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 60,
    borderColor: AMBER + "22",
    borderRadius: 0,
  },

  skipWrap: { position: "absolute", right: 16, zIndex: 100 },
  skipBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "rgba(245,166,35,0.15)",
    borderColor: AMBER + "55",
    borderWidth: 1,
  },
  skipTxt: { color: AMBER, fontSize: 14, fontWeight: "700" },

  logoWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 24,
  },
  logoIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: AMBER + "18",
    borderWidth: 1.5,
    borderColor: AMBER,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: {
    color: "#FFFFFF",
    fontSize: 38,
    fontWeight: "900",
    letterSpacing: -1.5,
  },

  taglineWrap: {
    position: "absolute",
    bottom: "30%",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  tagline: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 20,
    fontWeight: "500",
    letterSpacing: 0.5,
  },
});
