/**
 * Clerk session-token cache backed by `expo-secure-store`. Clerk calls this
 * on every cold-start to rehydrate the session, so the implementation has
 * to be defensive: keys can contain characters that SecureStore disallows
 * (`/`, `:`), and any read failure must NOT crash the app — the worst that
 * happens is the user has to sign in again.
 */
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type { TokenCache } from "@clerk/clerk-expo";

// SecureStore on iOS only allows [A-Za-z0-9._-] in keys. Replace anything
// outside that set so colon-prefixed keys like `clerk-js-jwt:foo` work.
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

export const tokenCache: TokenCache | undefined =
  Platform.OS === "web"
    ? undefined
    : {
        async getToken(key: string) {
          try {
            return await SecureStore.getItemAsync(safeKey(key));
          } catch {
            // A previously-corrupt entry — drop it so Clerk re-authenticates.
            try {
              await SecureStore.deleteItemAsync(safeKey(key));
            } catch {
              // ignore
            }
            return null;
          }
        },
        async saveToken(key: string, value: string) {
          try {
            await SecureStore.setItemAsync(safeKey(key), value);
          } catch {
            // Storage full / hardware-unavailable: silently degrade. Clerk
            // will prompt the user to sign in next launch.
          }
        },
      };
