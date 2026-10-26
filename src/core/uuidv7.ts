/**
 * UUIDv7 (RFC 9562): 48-bit unix-ms timestamp + random bits.
 * Sorts roughly by creation time, safe to generate offline on any device.
 * Not strictly monotonic within the same millisecond (fine for our use).
 */
export type RandomBytes = (n: number) => Uint8Array;

const defaultRandom: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export function uuidv7(now: number = Date.now(), random: RandomBytes = defaultRandom): string {
  const b = random(16).slice(0, 16);
  if (b.length !== 16) throw new Error("random() must return 16 bytes");

  b[0] = Math.floor(now / 2 ** 40) & 0xff;
  b[1] = Math.floor(now / 2 ** 32) & 0xff;
  b[2] = (now >>> 24) & 0xff;
  b[3] = (now >>> 16) & 0xff;
  b[4] = (now >>> 8) & 0xff;
  b[5] = now & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10

  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
