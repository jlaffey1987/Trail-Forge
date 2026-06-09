/**
 * Free vs Premium comparison — onboarding slide, membership screen, and reuse elsewhere.
 */
import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import colors from "@/constants/colors";
import {
  FREE_TIER_HEADLINE,
  FREE_TIER_ITEMS,
  PREMIUM_HOW_STEPS,
  PREMIUM_TIER_HEADLINE,
  PREMIUM_TIER_ITEMS,
  PREMIUM_WHY_PARAGRAPH,
  type MembershipBullet,
} from "@/lib/membershipBenefits";
import { openPremiumUpgrade } from "@/lib/premiumUpgrade";

const AMBER = colors.light.primary;

interface Props {
  isPremium?: boolean;
  /** Hide title row when parent supplies its own (onboarding slide). */
  showHeader?: boolean;
  /** Embedded in onboarding — tighter padding, no outer scroll wrapper. */
  embedded?: boolean;
}

export function MembershipExplainer({
  isPremium = false,
  showHeader = true,
  embedded = false,
}: Props) {
  const body = (
    <>
      {showHeader ? (
        <View style={styles.headerBlock}>
          <View style={styles.iconPill}>
            <Feather name="layers" size={20} color={AMBER} />
          </View>
          <Text style={styles.title}>Free vs Premium</Text>
          <Text style={styles.subtitle}>
            Start free — upgrade when you want guided rides and full control
          </Text>
        </View>
      ) : null}

      {isPremium ? (
        <View style={styles.premiumBanner}>
          <Feather name="check-circle" size={18} color={colors.light.trailGreen} />
          <Text style={styles.premiumBannerText}>
            You're on Premium — all features below are unlocked.
          </Text>
        </View>
      ) : null}

      <View style={styles.columns}>
        <TierCard
          tier="free"
          headline={FREE_TIER_HEADLINE}
          items={FREE_TIER_ITEMS}
        />
        <TierCard
          tier="premium"
          headline={PREMIUM_TIER_HEADLINE}
          items={PREMIUM_TIER_ITEMS}
        />
      </View>

      <View style={styles.whyBox}>
        <Text style={styles.whyTitle}>Why Premium is worth it</Text>
        <Text style={styles.whyBody}>{PREMIUM_WHY_PARAGRAPH}</Text>
      </View>

      {!isPremium ? (
        <>
          <View style={styles.howBox}>
            <Text style={styles.howTitle}>How to get Premium</Text>
            {PREMIUM_HOW_STEPS.map((step, i) => (
              <View key={step} style={styles.howRow}>
                <View style={styles.howNum}>
                  <Text style={styles.howNumText}>{i + 1}</Text>
                </View>
                <Text style={styles.howText}>{step}</Text>
              </View>
            ))}
          </View>

          <TouchableOpacity
            style={styles.upgradeBtn}
            activeOpacity={0.85}
            onPress={() => void openPremiumUpgrade("TrailForge Premium")}
          >
            <Feather name="star" size={18} color="#1a0e05" />
            <Text style={styles.upgradeBtnText}>Get Premium</Text>
          </TouchableOpacity>
          <Text style={styles.checkoutNote}>
            Secure checkout in your browser. Cancel anytime.
          </Text>
        </>
      ) : null}
    </>
  );

  if (embedded) {
    return <View style={styles.embeddedRoot}>{body}</View>;
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      {body}
    </ScrollView>
  );
}

function TierCard({
  tier,
  headline,
  items,
}: {
  tier: "free" | "premium";
  headline: string;
  items: MembershipBullet[];
}) {
  const isPremium = tier === "premium";
  return (
    <View style={[styles.tierCard, isPremium && styles.tierCardPremium]}>
      <View style={styles.tierHeader}>
        <Text style={[styles.tierLabel, isPremium && styles.tierLabelPremium]}>
          {isPremium ? "Premium" : "Free"}
        </Text>
        {isPremium ? (
          <Feather name="star" size={14} color={AMBER} />
        ) : (
          <Feather name="gift" size={14} color={colors.light.trailGreen} />
        )}
      </View>
      <Text style={styles.tierHeadline}>{headline}</Text>
      {items.map((item) => (
        <View key={item.text} style={styles.bulletRow}>
          <Feather
            name={item.icon === "lock" ? "lock" : "check-circle"}
            size={14}
            color={item.icon === "lock" ? AMBER : colors.light.trailGreen}
          />
          <Text style={styles.bulletText}>{item.text}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  embeddedRoot: {
    flex: 1,
  },
  headerBlock: {
    marginBottom: 16,
  },
  iconPill: {
    alignSelf: "flex-start",
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: AMBER + "22",
    borderWidth: 1,
    borderColor: AMBER + "55",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  title: {
    color: colors.light.foreground,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.6,
    marginBottom: 6,
  },
  subtitle: {
    color: colors.light.mutedForeground,
    fontSize: 15,
    lineHeight: 22,
  },
  premiumBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.light.trailGreen + "18",
    borderWidth: 1,
    borderColor: colors.light.trailGreen + "44",
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  premiumBannerText: {
    flex: 1,
    color: colors.light.foreground,
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 19,
  },
  columns: {
    gap: 12,
    marginBottom: 16,
  },
  tierCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.card,
    padding: 14,
  },
  tierCardPremium: {
    borderColor: AMBER + "66",
    backgroundColor: AMBER + "0d",
  },
  tierHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  tierLabel: {
    color: colors.light.trailGreen,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  tierLabelPremium: {
    color: AMBER,
  },
  tierHeadline: {
    color: colors.light.foreground,
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
    marginBottom: 10,
  },
  bulletRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginBottom: 8,
  },
  bulletText: {
    flex: 1,
    color: colors.light.foreground,
    fontSize: 13,
    lineHeight: 19,
  },
  whyBox: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.muted,
    padding: 14,
    marginBottom: 16,
  },
  whyTitle: {
    color: colors.light.foreground,
    fontSize: 15,
    fontWeight: "800",
    marginBottom: 8,
  },
  whyBody: {
    color: colors.light.mutedForeground,
    fontSize: 14,
    lineHeight: 21,
  },
  howBox: {
    marginBottom: 20,
  },
  howTitle: {
    color: colors.light.foreground,
    fontSize: 15,
    fontWeight: "800",
    marginBottom: 12,
  },
  howRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 10,
  },
  howNum: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: AMBER,
    alignItems: "center",
    justifyContent: "center",
  },
  howNumText: {
    color: "#1a0e05",
    fontSize: 12,
    fontWeight: "900",
  },
  howText: {
    flex: 1,
    color: colors.light.foreground,
    fontSize: 14,
    lineHeight: 20,
  },
  upgradeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: AMBER,
    borderRadius: 12,
    paddingVertical: 16,
    marginBottom: 8,
  },
  upgradeBtnText: {
    color: "#1a0e05",
    fontSize: 16,
    fontWeight: "900",
  },
  checkoutNote: {
    textAlign: "center",
    color: colors.light.mutedForeground,
    fontSize: 12,
    lineHeight: 18,
  },
});
