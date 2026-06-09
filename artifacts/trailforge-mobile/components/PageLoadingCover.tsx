/**
 * Shows the ride POV loading image only when `loading` stays true past a
 * short delay — avoids flashing on fast network responses.
 */
import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { RidePovLoadingView } from "@/components/RidePovLoadingView";

interface PageLoadingCoverProps {
  loading: boolean;
  /** Wait this long before showing the cover (ms). */
  delayMs?: number;
  message?: string;
  children: React.ReactNode;
}

function useDelayedTrue(active: boolean, delayMs: number): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const t = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(t);
  }, [active, delayMs]);
  return active && visible;
}

export function PageLoadingCover({
  loading,
  delayMs = 450,
  message,
  children,
}: PageLoadingCoverProps) {
  const showCover = useDelayedTrue(loading, delayMs);

  return (
    <View style={styles.root}>
      {children}
      {showCover ? (
        <View style={styles.overlay} pointerEvents="auto">
          <RidePovLoadingView message={message} style={StyleSheet.absoluteFill} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50,
  },
});
