/**
 * Lightweight React context that caches the current user's server-side
 * profile fields that the UI needs at render time without prop-drilling.
 *
 * Populated by PostLoginBootstrap (tabs/_layout.tsx) after /me/sync succeeds.
 */
import React, { createContext, useCallback, useContext, useState } from "react";

export type BikeType = "all" | "adventure" | "trail" | "enduro";

export interface UserProfile {
  isPremium: boolean;
  preferredBikeType: BikeType;
  isLinesman: boolean;
  linesmanGroupId: string | null;
}

interface ProfileContextValue {
  profile: UserProfile;
  setProfile: (updates: Partial<UserProfile>) => void;
}

const DEFAULT_PROFILE: UserProfile = {
  isPremium: false,
  preferredBikeType: "all",
  isLinesman: false,
  linesmanGroupId: null,
};

const ProfileContext = createContext<ProfileContextValue>({
  profile: DEFAULT_PROFILE,
  setProfile: () => undefined,
});

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfileState] = useState<UserProfile>(DEFAULT_PROFILE);

  const setProfile = useCallback((updates: Partial<UserProfile>) => {
    setProfileState((prev) => ({ ...prev, ...updates }));
  }, []);

  return (
    <ProfileContext.Provider value={{ profile, setProfile }}>
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile(): ProfileContextValue {
  return useContext(ProfileContext);
}
