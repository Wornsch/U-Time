import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "at.wornsch.utime",
  appName: "U-Time",
  webDir: "dist",
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
