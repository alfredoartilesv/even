import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

/**
 * Hand the backup to the user. On the phone: write it to the app cache and open the
 * share sheet (Drive, email, Files...). The file is already encrypted, so wherever it ends
 * up only the password opens it. In the browser: a normal download.
 */
export async function saveBackupFile(fileName: string, text: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
    a.click();
    URL.revokeObjectURL(url);
    return;
  }
  const { uri } = await Filesystem.writeFile({ path: fileName, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
  await Share.share({ title: "Health backup", files: [uri] });
}

export function backupFileName(nowMs: number = Date.now()): string {
  return `health-backup-${new Date(nowMs).toISOString().slice(0, 10)}.json`;
}
