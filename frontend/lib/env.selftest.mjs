/**
 * env.selftest.mjs — the moment control's arithmetic.
 *
 * This exists because the field it guards replaced a native `datetime-local`
 * input, and the thing that input got wrong was silent: it rendered
 * `mm/dd/yyyy` for anyone whose browser is US English, so for the first twelve
 * days of every month a typed date was a DIFFERENT valid date and nothing
 * anywhere said so. A hand-rolled parser can fail the same way, so the cases
 * below are the ones that would be wrong rather than broken: a day that does
 * not exist, a month past twelve, an hour past 23, and the round trip.
 *
 * The zone is deliberately not asserted against a fixed offset — the suite runs
 * on CI in UTC and on a field laptop in UTC+5, and an assertion that only holds
 * in one of them is worse than none. What IS asserted is the invariant that
 * survives both: parse(format(x)) === x, whatever the zone.
 *
 * Run: node lib/env.selftest.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "env-selftest-"));

execFileSync(
  "npx",
  /* env.ts imports the I18nKey type, which pulls in the dictionary: the flags
     below are the project's own (`--resolveJsonModule`, dom lib, interop),
     without which the key type degenerates and the module will not compile
     standalone even though `tsc --noEmit` over the project is clean. */
  ["tsc", "lib/env.ts", "--outDir", outDir, "--rootDir", "lib",
   "--module", "es2020", "--target", "es2020", "--moduleResolution", "node",
   "--lib", "es2020,dom", "--skipLibCheck", "--resolveJsonModule",
   "--esModuleInterop", "--strict"],
  { cwd: frontendDir, stdio: "inherit" },
);

const { formatLocalStamp, parseLocalStamp, localZoneLabel, formatSliceTime } =
  await import(pathToFileURL(path.join(outDir, "env.js")).href);

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`); failed++; }
};

/* ------------------------------------------------------------ round trip */
{
  /* The invariant that holds in every zone: what is shown, read back, is the
     same instant. Instants chosen across the year so a summer-time change
     cannot make this pass only in winter. */
  const instants = [
    "2026-01-15T03:00:00Z", "2026-06-30T23:45:00Z",
    "2026-08-10T19:31:00Z", "2026-12-31T21:00:00Z",
  ];
  ok("shown, retyped, is the same instant", instants.every((iso) => {
    const back = parseLocalStamp(formatLocalStamp(iso));
    return back === iso.replace(/\.\d{3}Z$/, "Z");
  }), JSON.stringify(instants.map((i) => [i, parseLocalStamp(formatLocalStamp(i))])));
}

/* ---------------------------------------------------------- day-first */
{
  /* The whole reason this control exists: 08.10.2026 is the 8th of October,
     never the 10th of August. Checked through the local-time round trip so it
     holds in any zone. */
  const iso = parseLocalStamp("08.10.2026 12:00");
  const d = new Date(iso);
  ok("08.10.2026 is the 8th of October", d.getDate() === 8 && d.getMonth() === 9,
     `${iso} → day ${d.getDate()}, month ${d.getMonth() + 1}`);
}

/* ------------------------------------------------------ what is accepted */
ok("separators people actually type", ["10.08.2026 07:05", "10/08/2026 07:05", "10-08-2026 07:05"]
   .every((s) => parseLocalStamp(s) === parseLocalStamp("10.08.2026 07:05")));
ok("single digits are fine", parseLocalStamp("1.9.2026 7:05") === parseLocalStamp("01.09.2026 07:05"));
ok("a bare date means midnight", (() => {
  const d = new Date(parseLocalStamp("10.08.2026"));
  return d.getHours() === 0 && d.getMinutes() === 0;
})());
ok("surrounding space is not an error", parseLocalStamp("  10.08.2026 07:05  ") !== null);

/* ------------------------------------------------------ what is rejected */
/* Every one of these must be null, never a nearby moment: the layer answers for
   the instant asked for, so an unreadable one has to stop at the field. */
for (const [name, text] of [
  ["a day that does not exist", "31.02.2026 10:00"],
  ["a 13th month", "10.13.2026 10:00"],
  ["a 25th hour", "10.08.2026 25:00"],
  ["a 61st minute", "10.08.2026 10:61"],
  ["a two-digit year", "10.08.26 10:00"],
  ["ISO order", "2026-08-10 10:00"],
  ["words", "вчера"],
  ["empty", ""],
]) ok(`${name} is rejected`, parseLocalStamp(text) === null, String(parseLocalStamp(text)));

/* -------------------------------------------------------------- the zone */
ok("the zone is named, and named consistently", (() => {
  const label = localZoneLabel(new Date("2026-08-10T12:00:00Z"));
  return /^UTC([+-]\d{1,2}(:\d{2})?)?$/.test(label);
})(), localZoneLabel());
ok("a slice says both the time and the zone it is in",
   formatSliceTime("2026-08-09T12:00:00Z").endsWith(localZoneLabel(new Date("2026-08-09T12:00:00Z"))));
ok("an unparseable slice is echoed, not blanked",
   formatSliceTime("not a time") === "not a time");

console.log(failed
  ? `\n${failed} assertion(s) failed`
  : "\nenv.ts: the moment is read day-first, in the reader's zone, or not at all");
process.exit(failed ? 1 : 0);
