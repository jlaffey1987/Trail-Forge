/**
 * Intro video screen — shown exactly once on first launch.
 *
 * Plays artifacts/trailforge-mobile/assets/videos/intro.mp4 full-screen,
 * muted by default, with:
 *   - TrailForge logo overlaid, fading in after 1 second
 *   - Skip button (top-right) appearing after 1.5 seconds
 *   - Auto-advance to onboarding when video ends or skip is tapped
 *
 * AsyncStorage flag: @trailforge/intro_seen
 * Once set, this screen is never shown again.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Video, ResizeMode, Audio, type AVPlaybackStatus } from "expo-av";
import { router } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  StatusBar,
  StyleSheet,
  TouchableOpacity,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BrandLogo } from "@/components/BrandLogo";
import { INTRO_SEEN_KEY, ONBOARDING_KEY } from "@/lib/storageKeys";

const { width: W, height: H } = Dimensions.get("window");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const VIDEO_SOURCE = require("../assets/videos/intro.mp4") as number;

export default function IntroScreen() {
  const insets = useSafeAreaInsets();
  const videoRef = useRef<Video>(null);

  const logoOpacity  = useRef(new Animated.Value(0)).current;
  const skipOpacity  = useRef(new Animated.Value(0)).current;

  const [advanced, setAdvanced] = useState(false);

  // Mark seen and navigate on to the next screen.
  const advance = useCallback(async () => {
    if (advanced) return;
    setAdvanced(true);
    await AsyncStorage.setItem(INTRO_SEEN_KEY, "true");
    const obDone = await AsyncStorage.getItem(ONBOARDING_KEY);
    if (obDone) {
      router.replace("/(tabs)/map" as never);
    } else {
      router.replace("/onboarding" as unknown as Parameters<typeof router.replace>[0]);
    }
  }, [advanced]);

  // Silence the audio session entirely — video is visual only.
  useEffect(() => {
    void Audio.setAudioModeAsync({
      playsInSilentModeIOS: false,   // respect the iOS silent switch
      staysActiveInBackground: false,
      shouldDuckAndroid: false,
    });
  }, []);

  // Start logo + skip animations when component mounts.
  useEffect(() => {
    // Logo fades in after 1 second
    Animated.sequence([
      Animated.delay(1000),
      Animated.timing(logoOpacity, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }),
    ]).start();

    // Skip button fades in after 1.5 seconds
    Animated.sequence([
      Animated.delay(1500),
      Animated.timing(skipOpacity, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  // Handle video playback status — advance when the video finishes.
  const onPlaybackStatusUpdate = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded) return;
      if (status.didJustFinish) {
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
        isMuted={true}       // visual only — no audio ever
        volume={0}           // belt-and-braces zero volume
        onPlaybackStatusUpdate={onPlaybackStatusUpdate}
      />

      {/* Dark vignette around the edges so overlays read clearly */}
      <View style={s.vignette} pointerEvents="none" />

      {/* Brand logo — fades in at 1 s, centred over video */}
      <Animated.View style={[s.logoWrap, { opacity: logoOpacity }]} pointerEvents="none">
        <BrandLogo size={120} circular showWordmark />
      </Animated.View>

      {/* Skip button — top-right, fades in at 1.5 s */}
      <Animated.View
        style={[s.skipWrap, { top: insets.top + 12, opacity: skipOpacity }]}
      >
        <TouchableOpacity
          style={s.skipBtn}
          onPress={() => void advance()}
          activeOpacity={0.8}
          accessibilityLabel="Skip intro"
          accessibilityRole="button"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={s.skipTxt}>Skip</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    width: W,
    height: H,
    backgroundColor: "#000",
  },

  // Radial-style vignette: a transparent centre with dark edges.
  // React Native doesn't support radial gradients natively so we use
  // a border approach — looks great in practice.
  vignette: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 80,
    borderColor: "rgba(0,0,0,0.45)",
    // borderRadius: 0 intentional — we want hard screen-edge darkening
  },

  // Logo centred on screen
  logoWrap: {
    position: "absolute",
    top: "50%",
    left: 0,
    right: 0,
    marginTop: -80,           // half of logo + wordmark height
    alignItems: "center",
    justifyContent: "center",
  },

  // Skip button — top-right
  skipWrap: {
    position: "absolute",
    right: 16,
    zIndex: 100,
  },
  skipBtn: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.45)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
  },
  skipTxt: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
});
