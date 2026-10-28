import { Health, type HealthDataType, type HealthPlugin } from "@capgo/capacitor-health";
import { platformName } from "./device";

/**
 * Apple Health through @capgo/capacitor-health, on the iPhone only. The plugin is left out of the
 * Android build (capacitor.config.json android.includePlugins): Health Connect would need min SDK
 * 26 and its own permissions. What is read, and how, is domain/sync/appleHealth.ts.
 */
export const appleHealthSupported = platformName === "ios";

export const healthStore: HealthPlugin = Health;

/**
 * Shows iOS's Health permission sheet (only the first time: after that iOS answers without asking,
 * and changes are made in the Health app). Resolves false when HealthKit is not on this device.
 */
export async function requestAppleHealthAccess(read: HealthDataType[]): Promise<boolean> {
  const { available } = await Health.isAvailable();
  if (!available) return false;
  await Health.requestAuthorization({ read });
  return true;
}
