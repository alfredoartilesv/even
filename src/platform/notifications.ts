import { LocalNotifications } from "@capacitor/local-notifications";
import { createLogger } from "../core/log";
import { noopNotifier, pluginNotification, type Notifier } from "../core/notifier";
import { isNative } from "./device";

const log = createLogger("platform.notifications");

/**
 * Local notifications through @capacitor/local-notifications. On Android 13+ the first
 * ensurePermission() shows the system prompt; after a "no" it stays no until changed in the
 * phone's settings. allowWhileIdle lets Doze deliver it close to the time (inexact is fine here).
 * The browser build has no scheduled notifications.
 */
export const notifier: Notifier = isNative
  ? {
      async ensurePermission() {
        let { display } = await LocalNotifications.checkPermissions();
        if (display === "prompt" || display === "prompt-with-rationale") ({ display } = await LocalNotifications.requestPermissions());
        log.debug("permission", { display });
        return display === "granted";
      },
      async schedule(n) {
        await LocalNotifications.schedule({ notifications: [pluginNotification(n)] });
      },
      async cancel(id) {
        await LocalNotifications.cancel({ notifications: [{ id }] });
      },
    }
  : noopNotifier;
