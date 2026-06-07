/**
 * Intro video screen — shown exactly once on first launch.
 *
 * Uses expo-video (expo-av is deprecated on SDK 54 and often shows a black screen).
 * Falls back to a static poster if the video fails to load.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const POSTER_SOURCE = require("../assets/videos/intoimage.jpeg") as number;

/** Stop video at this fraction of total duration and start fade-out. */
const STOP_AT = 0.80;
const MAX_INTRO_MS = 12_000;

export default function IntroScreen() {
  const insets = useSafeAreaInsets();
  const advancedRef = useRef(false);
  const frozenRef = useRef(false);

  const titleY = useRef(new Animated.Value(-40)).current;
  const titleOpacity = useRef(new Animated.Value(0)).current;
  const underlineScale = useRef(new Animated.Value(0)).current;
  const skipOpacity = useRef(new Animated.Value(0)).current;
  const blackOpacity = useRef(new Animated.Value(0)).current;

  const [showPoster, setShowPoster] = useState(true);
  const [videoFailed, setVideoFailed] = useState(false);

  const player = useVideoPlayer(VIDEO_SOURCE, (p) => {
    p.loop = false;
    p.muted = true;
    p.timeUpdateEventInterval = 0.25;
    p.play();
  });

  const advance = useCallback(async () => {
    if (advancedRef.current) return;
    advancedRef.current = true;
    player.pause();

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
  }, [blackOpacity, player]);

  useEffect(() => {
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

    Animated.sequence([
      Animated.delay(1000),
      Animated.timing(underlineScale, {
        toValue: 1, duration: 400,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();

    Animated.sequence([
      Animated.delay(1500),
      Animated.timing(skipOpacity, {
        toValue: 1, duration: 400, useNativeDriver: true,
      }),
    ]).start();
  }, [titleOpacity, titleY, underlineScale, skipOpacity]);

  useEffect(() => {
    const tick = setInterval(() => {
      if (frozenRef.current || advancedRef.current) return;
      if (player.status === "error") {
        setVideoFailed(true);
        setShowPoster(true);
        return;
      }
      const duration = player.duration;
      if (!duration || duration <= 0) return;
      if (player.currentTime / duration >= STOP_AT) {
        frozenRef.current = true;
        void advance();
      }
    }, 200);
    return () => clearInterval(tick);
  }, [player, advance]);

  useEffect(() => {
    const failTimer = setTimeout(() => {
      if (player.status !== "readyToPlay" && player.status !== "loading" && !advancedRef.current) {
        if (__DEV__) console.warn("[Intro] video slow to start — showing poster");
        setShowPoster(true);
      }
    }, 3000);
    return () => clearTimeout(failTimer);
  }, [player]);

  useEffect(() => {
    const maxTimer = setTimeout(() => {
      void advance();
    }, MAX_INTRO_MS);
    return () => clearTimeout(maxTimer);
  }, [advance]);

  useEffect(() => {
    if (!videoFailed) return;
    const t = setTimeout(() => void advance(), 2500);
    return () => clearTimeout(t);
  }, [videoFailed, advance]);

  return (
    <View style={s.root}>
      <StatusBar hidden />

      {(showPoster || videoFailed) ? (
        <Image
          source={POSTER_SOURCE}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
        />
      ) : null}

      {!videoFailed ? (
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
          onFirstFrameRender={() => setShowPoster(false)}
        />
      ) : null}

      <View style={s.vignette} pointerEvents="none" />

      <Animated.View
        style={[
          s.titleWrap,
          { top: insets.top + 32 },
          { opacity: titleOpacity, transform: [{ translateY: titleY }] },
        ]}
        pointerEvents="none"
      >
        <Text style={s.title}>TrailForge</Text>
        <Animated.View
          style={[s.underline, { transform: [{ scaleX: underlineScale }] }]}
        />
      </Animated.View>

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
  },

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

  blackOverlay: { backgroundColor: "#000" },
});
