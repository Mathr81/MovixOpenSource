export interface CastRelayDisclosureContext {
  isAndroidNative: boolean;
  isSuppressed: boolean;
}

export interface ContinueCastRelayDisclosureOptions {
  suppress: boolean;
  setSuppressed: (suppressed: boolean) => void | Promise<void>;
  requestNotificationPermission: () => void | Promise<void>;
  onContinue: () => void;
}

export interface OpenCastRelayBatterySettingsOptions {
  openBatterySettings: () => void | Promise<void>;
  setSuppressed?: (suppressed: boolean) => void | Promise<void>;
  onContinue?: () => void;
}

/** The notice is relevant only to the native Android relay, once per user. */
export function shouldShowCastRelayDisclosure({
  isAndroidNative,
  isSuppressed,
}: CastRelayDisclosureContext): boolean {
  return isAndroidNative && !isSuppressed;
}

function runOptional(action: () => void | Promise<void>): void {
  try {
    void Promise.resolve(action()).catch(() => undefined);
  } catch {
    // Optional settings and permission actions must never interrupt Cast.
  }
}

/**
 * Starts Cast synchronously after scheduling optional persistence/permission
 * work. Neither can gate a device selection attempt.
 */
export function continueCastRelayDisclosure({
  suppress,
  setSuppressed,
  requestNotificationPermission,
  onContinue,
}: ContinueCastRelayDisclosureOptions): void {
  if (suppress) runOptional(() => setSuppressed(true));
  runOptional(requestNotificationPermission);
  onContinue();
}

/** Opening Android battery settings is informational and changes no state. */
export function openCastRelayBatterySettings({
  openBatterySettings,
}: OpenCastRelayBatterySettingsOptions): void {
  runOptional(openBatterySettings);
}
