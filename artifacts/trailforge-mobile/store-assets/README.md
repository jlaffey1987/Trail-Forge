# TrailForge Store Assets Checklist

This folder is the staging area for everything the App Store and Play Store
need before submission. Replit's **Expo Launch** flow handles the actual iOS
build + App Store upload — see the `expo` skill in this repo for details.
Android (Play Store) submission is not currently supported by Replit and must
be performed manually with `eas submit` from a local checkout.

## Required assets

### Both stores

- [ ] **App icon** — `assets/images/icon.png` (1024×1024, no transparency, no
  rounded corners — the OS rounds them for you).
- [ ] **App name** — TrailForge (matches `app.json` → `expo.name`).
- [ ] **Bundle id** — `com.trailforge.app` (do NOT change after first submit).
- [ ] **Version** — `1.0.0` (matches `app.json` → `expo.version`).
- [ ] **Marketing copy** — short description (≤170 chars) and full description.
- [ ] **Privacy policy URL** — required because we collect location and
      account data.
- [ ] **Support URL** — public-facing URL for user support.

### iOS (App Store Connect)

- [ ] **Screenshots** — 6.7" iPhone: 1290×2796 (3 minimum). 6.5" iPhone:
      1284×2778 (optional but recommended). iPad 12.9": 2048×2732.
- [ ] **App preview videos** — optional, 15–30s portrait MP4.
- [ ] **App Review Information** — demo account email + password (Clerk test
      user), and a contact phone number.
- [ ] **Export Compliance** — `ITSAppUsesNonExemptEncryption: false` is
      already set in `app.json` because we use only standard HTTPS.
- [ ] **Permission strings** — each `NS*UsageDescription` in `app.json` is
      shown verbatim in the OS prompt; review them before each submission.

### Android (Play Console)

- [ ] **Feature graphic** — 1024×500.
- [ ] **Screenshots** — phone: at least 2 at ≥320px on the short side.
- [ ] **Data safety form** — declare location collection (precise + coarse),
      account data (email, profile), and that data is encrypted in transit.

## Build profiles

Defined in `eas.json`:

- `development` — installable dev client with all dev tools.
- `preview` — internal-distribution build for QA.
- `production` — store-bound build with `appVersionSource: "remote"` so the
  build number is incremented by EAS, not by hand.

## Operator checklist before publishing

1. Confirm `EXPO_PUBLIC_DOMAIN` resolves to the production API.
2. Confirm `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` is the production Clerk key.
3. **Set `expo.extra.eas.projectId`** in `app.json` to the UUID issued by
   `eas init` (or by the Replit Expo Launch flow on first build).
   `getExpoPushTokenAsync()` requires this in standalone / EAS builds —
   without it, push notifications silently fail to register on real
   devices. Expo Go works without it.
4. Bump `expo.version` (and the iOS `buildNumber`) in `app.json` if EAS
   didn't already do it.
5. Verify `assets/images/icon.png` is the final 1024×1024 production icon.
6. Click **Publish** in Replit (Expo Launch handles iOS).
