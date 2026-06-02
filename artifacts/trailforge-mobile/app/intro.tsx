/**
 * Intro video screen — shown exactly once on first launch.
 *
 * Behaviour:
 *   - Full-screen video (muted / silent)
 *   - "TrailForge" slides down from above + fades in after 0.6 s
 *   - Amber underline accent animates in beneath the title
 *   - Video pauses/freezes at 80 % of its duration (before bike exits frame)
 *   - Black overlay fades in, then we navigate to onboarding
 *   - Skip button appears at 1.5 s and does the same fade-to-black flow
 *
 * AsyncStorage flag: @trailforge/intro_seen — never shows again after first play.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Video, ResizeMode, Audio, type AVPlaybackStatus } from "expo-av";
import { router } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { INTRO_SEEN_KEY, ONBOARDING_KEY } from "@/lib/storageKeys";

const { width: W, height: H } = Dimensions.get("window");
const AMBER = "#F5A623";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const VIDEO_SOURCE = require("../assets/videos/intro.mp4") as number;

/** Stop video at this fraction of total duration and start fade-out. */
const STOP_AT = 0.80;

export default function IntroScreen() {
  const insets = useSafeAreaInsets();
  const videoRef = useRef<Video>(null);

  // Title slide-down + fade
  const titleY       = useRef(new Animated.Value(-40)).current;
  const titleOpacity = useRef(new Animated.Value(0)).current;
  // Amber underline grows from 0 → 1 (scaleX)
  const underlineScale = useRef(new Animated.Value(0)).current;
  // Skip button fade
  const skipOpacity  = useRef(new Animated.Value(0)).current;
  // Full-screen black fade-out overlay
  const blackOpacity = useRef(new Animated.Value(0)).current;

  const [advanced, setAdvanced] = useState(false);
  const totalDurationRef = useRef<number | null>(null);  // ms
  const frozenRef        = useRef(false);

  // ── Navigate to next screen after fade-to-black ──────────────────────────
  const advance = useCallback(async () => {
    if (advanced) return;
    setAdvanced(true);

    // Fade to black over 500 ms, then navigate
    Animated.timing(blackOpacity, {
      toValue: 1,
      duration: 500,
      easing: Easing.in(Easing.ease),
      useNativeDriver: true,
    }).start(async () => {
      await AsyncStorage.setItem(INTRO_SEEN_KEY, "true");
      const obDone = await AsyncStorage.getItem(ONBOARDING_KEY);
      if (obDone) {
        router.replace("/(tabs)/map" as never);
      } else {
        router.replace("/onboarding" as unknown as Parameters<typeof router.replace>[0]);
      }
    });
  }, [advanced, blackOpacity]);

  // ── Silence audio session ─────────────────────────────────────────────────
  useEffect(() => {
    void Audio.setAudioModeAsync({
      playsInSilentModeIOS: false,
      staysActiveInBackground: false,
      shouldDuckAndroid: false,
    });
  }, []);

  // ── Title + underline + skip animations ──────────────────────────────────
  useEffect(() => {
    // Title slides down and fades in at 600 ms
    Animated.sequence([
      Animated.delay(600),
      Animated.parallel([
        Animated.timing(titleOpacity, {
          toValue: 1, duration: 500, useNativeDriver: true,
        }),
        Animated.timing(titleY, {
          toValue: 0, duration: 500,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    ]).start();

    // Amber underline stretches out at 1 s
    Animated.sequence([
      Animated.delay(1000),
      Animated.timing(underlineScale, {
        toValue: 1, duration: 400,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();

    // Skip button fades in at 1.5 s
    Animated.sequence([
      Animated.delay(1500),
      Animated.timing(skipOpacity, {
        toValue: 1, duration: 400, useNativeDriver: true,
      }),
    ]).start();
  }, []);

  // ── Video playback — freeze at 80 % then fade out ─────────────────────────
  const onPlaybackStatusUpdate = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded) return;

      // Capture total duration on first status with it populated
      if (status.durationMillis && totalDurationRef.current === null) {
        totalDurationRef.current = status.durationMillis;
      }

      // Check if we should freeze
      if (!frozenRef.current && totalDurationRef.current) {
        const fraction = status.positionMillis / totalDurationRef.current;
        if (fraction >= STOP_AT) {
          frozenRef.current = true;
          videoRef.current?.pauseAsync().catch(() => undefined);
          void advance();
          return;
        }
      }

      // Also advance if the video finishes naturally (e.g. short video)
      if (status.didJustFinish && !frozenRef.current) {
        frozenRef.current = true;
        void advance();
      }
    },
    [advance],
  );

  return (
    <View style={s.root}>
      <StatusBar hidden />

      {/* Full-screen video */}
      <Video
        ref={videoRef}
        source={VIDEO_SOURCE}
        style={StyleSheet.absoluteFill}
        resizeMode={ResizeMode.COVER}
        shouldPlay
        isLooping={false}
        isMuted={true}
        volume={0}
        onPlaybackStatusUpdate={onPlaybackStatusUpdate}
      />

      {/* Dark vignette edges */}
      <View style={s.vignette} pointerEvents="none" />

      {/* "TrailForge" title — slides down from above */}
      <Animated.View
        style={[
          s.titleWrap,
          { top: insets.top + 32 },
          { opacity: titleOpacity, transform: [{ translateY: titleY }] },
        ]}
        pointerEvents="none"
      >
        <Text style={s.title}>TrailForge</Text>
        {/* Amber underline scales in from left */}
        <Animated.View
          style={[s.underline, { transform: [{ scaleX: underlineScale }] }]}
        />
      </Animated.View>

      {/* Skip button */}
      <Animated.View style={[s.skipWrap, { top: insets.top + 14, opacity: skipOpacity }]}>
        <TouchableOpacity
          style={s.skipBtn}
          onPress={() => void advance()}
          activeOpacity={0.8}
          accessibilityLabel="Skip intro"
          accessibilityRole="button"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={s.skipTxt}>Skip</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Black fade-out overlay — starts transparent, animates to opaque */}
      <Animated.View
        style={[StyleSheet.absoluteFill, s.blackOverlay, { opacity: blackOpacity }]}
        pointerEvents="none"
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, width: W, height: H, backgroundColor: "#000" },

  vignette: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 80,
    borderColor: "rgba(0,0,0,0.5)",
  },

  // Title — centred horizontally, positioned near top
  titleWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  title: {
    color: "#FFFFFF",
    fontSize: 48,
    fontWeight: "900",
    letterSpacing: 2,
    textShadowColor: "rgba(0,0,0,0.7)",
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 10,
  },
  underline: {
    marginTop: 6,
    height: 3,
    width: 140,
    borderRadius: 2,
    backgroundColor: AMBER,
    // scaleX animated from 0 → 1, originates from centre
    transformOrigin: "center",
  },

  // Skip button — top-right (positioned in JSX, opacity animated)
  skipWrap: { position: "absolute", right: 16, zIndex: 100 },
  skipBtn: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
  },
  skipTxt: { color: "#FFFFFF", fontSize: 14, fontWeight: "700", letterSpacing: 0.3 },

  // Fade-to-black overlay
  blackOverlay: { backgroundColor: "#000" },
});
