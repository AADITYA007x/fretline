import { Capacitor } from "@capacitor/core";

/** Running inside the Android app (not a browser). */
export const isNativeApp = Capacitor.isNativePlatform();
