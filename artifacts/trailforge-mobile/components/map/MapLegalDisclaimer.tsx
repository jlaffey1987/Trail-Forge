/**
 * Shown once before using the map — rider responsibility for legal/ethical riding.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useEffect, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import { MAP_LEGAL_DISCLAIMER_KEY } from "@/lib/storageKeys";

const AMBER = colors.light.primary;

const BODY = [
  "TrailForge shows trails from riders and open data. We try to keep illegal or closed routes out of the app, but paths, by-laws, and local rules change.",
  "Laws around green lanes and byways vary across England, Wales, Scotland, and Northern Ireland. A trail on the map is not a guarantee you may ride it today.",
  "You are responsible for checking that your planned route is legal, open, and appropriate for your bike and skill level before you ride.",
];

interface Props {
  auto?: boolean;
  visible?: boolean;
  onDismiss?: () => void;
}

export function MapLegalDisclaimer({ auto = false, visible, onDismiss }: Props) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!auto) return;
    void AsyncStorage.getItem(MAP_LEGAL_DISCLAIMER_KEY).then((v) => {
      if (v !== "accepted") setShow(true);
    });
  }, [auto]);

  const isVisible = visible ?? (auto && show);

  async function accept() {
    await AsyncStorage.setItem(MAP_LEGAL_DISCLAIMER_KEY, "accepted");
    setShow(false);
    onDismiss?.();
  }

  if (!isVisible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => undefined}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} />
        <View style={styles.card}>
          <Text style={styles.title}>Ride responsibly</Text>
          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            {BODY.map((para) => (
              <Text key={para.slice(0, 28)} style={styles.body}>
                {para}
              </Text>
            ))}
          </ScrollView>
          <TouchableOpacity style={styles.btn} onPress={() => void accept()}>
            <Text style={styles.btnText}>
              I understand — I&apos;m responsible for where I ride
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "center",
    padding: 20,
  },
  card: {
    backgroundColor: "#1c1917",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#44403c",
    padding: 20,
    maxHeight: "80%",
  },
  title: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "900",
    marginBottom: 12,
  },
  scroll: { marginBottom: 16 },
  body: {
    color: "#d6d3d1",
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 12,
  },
  btn: {
    backgroundColor: AMBER,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    alignItems: "center",
  },
  btnText: {
    color: "#1a0e05",
    fontWeight: "800",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
});
