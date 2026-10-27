/** "Hi, Alex" with the first name when the profile has one; short, so it fits next to the picture and sync. */
export function greeting(name: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? `Hi, ${first}` : "Hi";
}
