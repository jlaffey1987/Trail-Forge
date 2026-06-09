import { useLocalSearchParams } from "expo-router";
import React from "react";

import { RiderProfileContent } from "../profile";

export default function PublicRiderProfileScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  return <RiderProfileContent userId={String(userId ?? "")} />;
}
