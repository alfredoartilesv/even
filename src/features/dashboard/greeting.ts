/** "Good morning, Alex" by the hour, with the first name when the profile has one. */
export function greeting(hour: number, name: string | null): string {
  const part = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}
