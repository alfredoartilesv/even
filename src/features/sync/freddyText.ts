import { addDays, localDayStart } from "../../core/tz";
import type { SampleInput } from "./types";

/**
 * Parsers for the plain-text output of freddy's MCP tools. The MCP tools return text
 * meant for an AI, not JSON, so this is the most fragile part of the integration:
 * lines we do not understand are returned in `skipped` (never thrown away silently),
 * and the tests pin the formats we have actually seen.
 */

export interface MetricInfo {
  name: string;
  records: number;
  from: string;
  to: string;
  unit?: string;
  device?: string;
}

export function parseListMetrics(text: string): MetricInfo[] {
  const out: MetricInfo[] = [];
  const re = /^([A-Za-z0-9_]+): (\d+) records? \((\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})(.*?)\)(?: \[.*\])?\s*$/;
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    const rest = m[5];
    out.push({
      name: m[1],
      records: Number(m[2]),
      from: m[3],
      to: m[4],
      unit: /unit: ([^,)]+)/.exec(rest)?.[1],
      device: /device: "([^"]+)"/.exec(rest)?.[1],
    });
  }
  return out;
}

export interface ParsedQuery {
  timeZone?: string;
  samples: SampleInput[];
  /** Lines starting with "Note:" (for example the plan-window clamp message). */
  notes: string[];
  /** Indented lines inside a day block that did not match the metric-line format. */
  skipped: string[];
}

const DAY_RE = /^(\d{4}-\d{2}-\d{2}):\s*$/;
const METRIC_RE = /^\s+([A-Za-z0-9_]+):\s+(.+?)\s*$/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const UNIT_RE = /^[A-Za-z_%/]*$/;

export function parseQueryMetrics(text: string, fallbackTimeZone = "UTC", sourceId = "freddy"): ParsedQuery {
  const timeZone = /local days in ([A-Za-z_]+(?:\/[A-Za-z_+-]+)+)/.exec(text)?.[1];
  const tz = timeZone ?? fallbackTimeZone;
  const notes: string[] = [];
  const skipped: string[] = [];
  const samples: SampleInput[] = [];

  let day: string | null = null;
  let partial = false;
  const seen = new Map<string, number>(); // "<day>|<metric>|<label>" -> occurrences so far

  for (const line of text.split(/\r?\n/)) {
    const d = DAY_RE.exec(line);
    if (d) {
      day = d[1];
      partial = false;
      continue;
    }
    if (line.startsWith("Note:")) {
      notes.push(line.slice(5).trim());
      continue;
    }
    if (day === null) continue;
    if (/^\s+\(possibly incomplete/.test(line)) {
      partial = true;
      continue;
    }
    if (!/^\s+\S/.test(line)) continue; // blank line ends nothing; just skip

    const m = METRIC_RE.exec(line);
    const src = m ? /\s\(([^)]+)\)$/.exec(m[2]) : null;
    if (!m || !src) {
      skipped.push(line.trim());
      continue;
    }
    const label = src[1];
    const body = m[2].slice(0, m[2].length - src[0].length).trim();
    const [first, ...restTokens] = body.split(/\s+/);
    const rest = restTokens.join(" ");

    const key = `${day}|${m[1]}|${label}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);

    const start = localDayStart(day, tz);
    const next = localDayStart(addDays(day, 1), tz);
    const sample: SampleInput = {
      source: sourceId,
      device: label,
      externalId: `${day}#${n}`,
      metric: m[1],
      startMs: start.startMs,
      endMs: next.startMs,
      offsetMin: start.offsetMin,
    };
    if (NUMBER_RE.test(first) && UNIT_RE.test(rest)) {
      sample.valueNum = Number(first);
      if (rest) sample.unit = rest;
    } else {
      sample.valueText = body; // keep anything we cannot read as "<number> [unit]"
    }
    if (partial) sample.raw = { partial: true };
    samples.push(sample);
  }
  return { timeZone, samples, notes, skipped };
}
