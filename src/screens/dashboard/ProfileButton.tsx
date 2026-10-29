import { useEffect, useState } from "react";
import type { SqlDriver } from "../../db/driver";
import { Avatar } from "../me/avatar";
import { loadIdentity } from "../../domain/settings/profile";

/** The round picture at the top of the Dashboard that opens the profile. */
export function ProfileButton({ db, version, onOpen }: { db: SqlDriver; version: number; onOpen: () => void }) {
  const [who, setWho] = useState<{ photo: string | null; name: string | null }>({ photo: null, name: null });
  useEffect(() => {
    void loadIdentity(db).then(setWho);
  }, [db, version]);
  return (
    <button type="button" className="profile-button" onClick={onOpen} aria-label="Open your profile and past activity">
      <Avatar photo={who.photo} name={who.name} size={40} />
    </button>
  );
}
