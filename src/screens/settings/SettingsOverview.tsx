import type { ReactNode } from "react";
import { APP_VERSION } from "../../platform/buildInfo";
import { platformName } from "../../platform/device";
import { CHAT_MODEL } from "../../domain/chat/engine";
import { fmtDay } from "../../ui/common";
import { StatusBadge } from "../../ui/controls";
import { SectionHeader } from "../../ui/layout";
import type { SettingsPage } from "./SettingsScreen";
import { InventoryGrid, PLATFORM, type SettingsSummary } from "./summary";

/** One label and value line in a card's list. */
function Line({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div>
      <dt className="muted">{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Every settings page at a glance, for a wide screen with nothing open yet: connections, privacy
 * and backup, profile, the app, and what is stored. Each card opens its page.
 */
export function SettingsOverview({ summary: s, onPage }: { summary: SettingsSummary; onPage: (p: SettingsPage) => void }) {
  const readings = s.inventory.find((r) => r.label.startsWith("Health readings"))?.count ?? 0;
  return (
    <div className="wide-grid stretch">
      <p className="muted small span-12">Every settings page at a glance; pick one on the left to change it.</p>
      <section className="card span-6">
        <SectionHeader title="Connections" action="Connections" onAction={() => onPage("connections")} />
        <dl className="overview-lines">
          <Line k="Garmin sync">
            {s.garmin === "connected" ? (
              <StatusBadge status="good">connected</StatusBadge>
            ) : s.garmin === "needs_attention" ? (
              <StatusBadge status="warning">needs attention</StatusBadge>
            ) : (
              "not connected"
            )}
          </Line>
          <Line k="Coach">{s.chatOn ? <StatusBadge status="good">on</StatusBadge> : "off"}</Line>
        </dl>
      </section>
      <section className="card span-6">
        <SectionHeader title="Privacy & data" action="Privacy & data" onAction={() => onPage("privacy")} />
        <dl className="overview-lines">
          <Line k="On this phone">{`${readings.toLocaleString()} health readings`}</Line>
          <Line k="Backup">
            {s.lastBackupMs ? fmtDay(new Date(s.lastBackupMs).toLocaleDateString("en-CA")) : <StatusBadge status="warning">no backup yet</StatusBadge>}
          </Line>
        </dl>
      </section>
      <section className="card span-6">
        <SectionHeader title="Profile" action="Profile" onAction={() => onPage("profile")} />
        <dl className="overview-lines">
          <Line k="Name">{s.name ?? "–"}</Line>
          <Line k="Calorie target">{s.calorieTarget !== null ? `${Math.round(s.calorieTarget).toLocaleString()} kcal` : "not set"}</Line>
          <Line k="Protein target">{s.targets.protein !== null ? `${Math.round(s.targets.protein)} g` : "not set"}</Line>
          <Line k="Steps a day">{s.targets.steps !== null ? Math.round(s.targets.steps).toLocaleString() : "not set"}</Line>
          <Line k="Drinks a week">{s.targets.drinks !== null ? `at most ${s.targets.drinks}` : "not set"}</Line>
        </dl>
      </section>
      <section className="card span-6">
        <SectionHeader title="About" action="About" onAction={() => onPage("about")} />
        <dl className="overview-lines">
          <Line k="Version">{APP_VERSION}</Line>
          <Line k="Platform">{PLATFORM[platformName] ?? platformName}</Line>
          <Line k="Database schema">{s.schema ? `v${s.schema}` : "–"}</Line>
          <Line k="Chat model">{CHAT_MODEL}</Line>
        </dl>
      </section>
      <section className="card span-12">
        <h3>On this phone</h3>
        <p className="muted small">Encrypted database, this phone only. Keys are in secure storage, never in the database or a backup.</p>
        <InventoryGrid rows={s.inventory} wide />
      </section>
    </div>
  );
}
