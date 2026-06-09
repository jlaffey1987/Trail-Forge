/**

 * Full-screen overlay shown when a free user taps a premium-gated feature.

 */

import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";

import {

  Modal,

  Pressable,

  StyleSheet,

  Text,

  TouchableOpacity,

  View,

} from "react-native";



import colors from "@/constants/colors";
import { PREMIUM_UPGRADE_BENEFITS } from "@/lib/membershipBenefits";
import { openPremiumUpgrade } from "@/lib/premiumUpgrade";



interface Props {

  visible: boolean;

  featureName: string;

  onDismiss: () => void;

}



export function UpgradePrompt({ visible, featureName, onDismiss }: Props) {

  async function handleUpgrade() {

    onDismiss();

    await openPremiumUpgrade(featureName);

  }



  return (

    <Modal

      visible={visible}

      transparent

      animationType="fade"

      onRequestClose={onDismiss}

    >

      <Pressable style={styles.backdrop} onPress={onDismiss}>

        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>

          <View style={styles.iconWrap}>

            <Feather name="lock" size={28} color={colors.light.primary} />

          </View>



          <Text style={styles.title}>Premium feature</Text>

          <Text style={styles.body}>

            <Text style={styles.featureName}>{featureName}</Text> is part of

            TrailForge Premium — built for riders who want guided routes matched

            to their skill level.

          </Text>



          <View style={styles.benefits}>

            {PREMIUM_UPGRADE_BENEFITS.map((b) => (

              <View key={b} style={styles.benefitRow}>

                <Feather

                  name="check-circle"

                  size={14}

                  color={colors.light.trailGreen}

                />

                <Text style={styles.benefitText}>{b}</Text>

              </View>

            ))}

          </View>



          <TouchableOpacity

            style={styles.upgradeBtn}

            activeOpacity={0.8}

            onPress={() => void handleUpgrade()}

          >

            <Text style={styles.upgradeBtnText}>Upgrade to Premium</Text>

          </TouchableOpacity>



          <TouchableOpacity style={styles.dismissBtn} onPress={onDismiss}>
            <Text style={styles.dismissBtnText}>Not now</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.learnMoreBtn}
            onPress={() => {
              onDismiss();
              router.push("/membership" as never);
            }}
          >
            <Text style={styles.learnMoreBtnText}>Compare Free vs Premium</Text>
          </TouchableOpacity>

        </Pressable>

      </Pressable>

    </Modal>

  );

}



const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: colors.light.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.light.border,
    padding: 28,
    alignItems: "center",
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.light.muted,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  title: {
    color: colors.light.foreground,
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 10,
    textAlign: "center",
  },
  body: {
    color: colors.light.mutedForeground,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginBottom: 20,
  },
  featureName: {
    color: colors.light.primary,
    fontWeight: "600",
  },
  benefits: {
    alignSelf: "stretch",
    marginBottom: 24,
    gap: 8,
  },
  benefitRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  benefitText: {
    color: colors.light.foreground,
    fontSize: 13,
    flex: 1,
  },
  upgradeBtn: {
    width: "100%",
    backgroundColor: colors.light.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 10,
  },
  upgradeBtnText: {
    color: colors.light.primaryForeground,
    fontWeight: "700",
    fontSize: 15,
  },
  dismissBtn: {
    paddingVertical: 8,
  },
  dismissBtnText: {
    color: colors.light.mutedForeground,
    fontSize: 14,
  },
  learnMoreBtn: {
    paddingVertical: 4,
    marginTop: 2,
  },
  learnMoreBtnText: {
    color: colors.light.primary,
    fontSize: 13,
    fontWeight: "700",
  },
});

