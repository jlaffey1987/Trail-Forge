const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// `react-native-maps` is iOS / Android only. Expo Router's `require.context`
// enumerates every file in `app/` regardless of platform, so even the
// `.web.tsx` route override can't fully prevent the web bundler from
// touching files that import `react-native-maps`. Aliasing the module to
// an empty stub on web keeps Metro happy without affecting native builds.
const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web" && moduleName === "react-native-maps") {
    return { type: "empty" };
  }
  if (baseResolveRequest) {
    return baseResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
