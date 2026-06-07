/**
 * App entry — routes first-time users to the intro video before tabs.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Redirect } from "expo-router";
import React, { useEffect, useState } from "react";

import { BrandedLoader } from "@/components/BrandedLoader";
import { INTRO_SEEN_KEY } from "@/lib/storageKeys";

export default function Index() {
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    void AsyncStorage.getItem(INTRO_SEEN_KEY).then((seen) => {
      setHref(seen ? "/(tabs)/map" : "/intro");
    });
  }, []);

  if (!href) return <BrandedLoader />;
  return <Redirect href={href as never} />;
}
