import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

/**
 * Hand a text file to the user. On the phone: write it to the app cache and open the share
 * sheet (Drive, email, Files, the Claude app...). In the browser: a normal download.
 */
export async function saveTextFile(fileName: string, text: string, opts: { title: string; mimeType: string }): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(new Blob([text], { type: opts.mimeType }));
    const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
    a.click();
    URL.revokeObjectURL(url);
    return;
  }
  const { uri } = await Filesystem.writeFile({ path: fileName, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
  await Share.share({ title: opts.title, files: [uri] });
}

/** The backup is already encrypted, so wherever it ends up only the password opens it. */
export const saveBackupFile = (fileName: string, text: string) => saveTextFile(fileName, text, { title: "Even backup", mimeType: "application/json" });

export function backupFileName(nowMs: number = Date.now()): string {
  return `even-backup-${new Date(nowMs).toISOString().slice(0, 10)}.json`;
}
