// Pure helpers (no Firebase, no DOM) so they can be unit-tested in Node.

export const TZ = "Asia/Manila"; // UTC+8, no daylight saving
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** "YYYY-MM-DD" in Philippine time (fixes the UTC date bug). */
export const dateKey = (d = new Date()) => dateFmt.format(d);
export const formatTime = (d) => d ? d.toLocaleTimeString("en-PH", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
export const formatDate = (key) => new Date(key + "T00:00:00+08:00").toLocaleDateString("en-PH", { timeZone: TZ, year: "numeric", month: "short", day: "numeric" });

export function escapeHTML(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

export const isValidLRN = (v) => /^\d{12}$/.test(v);

// ---- QR payloads: "SLNHS:" + 192-bit random token. The LRN is NOT in the QR. ----
export const QR_PREFIX = "SLNHS:";
export function makeToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); // 32 chars
}
export const makeQRData = (token) => QR_PREFIX + token;
export function parseQR(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s.startsWith(QR_PREFIX)) return null;
  const t = s.slice(QR_PREFIX.length);
  return /^[A-Za-z0-9_-]{32}$/.test(t) ? t : null;
}

// ---- Four scans per day: Morning IN/OUT and Afternoon IN/OUT ----
// All times are minutes after midnight in Philippine time. A window is [Start, End) (End is exclusive).
// "Late" = on-time limit for the two IN scans: a scan after that minute is recorded as LATE (orange).
export const SLOTS = ["amIn", "amOut", "pmIn", "pmOut"];
export const IN_SLOTS = ["amIn", "pmIn"];
export const SLOT_LABEL = { amIn: "Morning IN", amOut: "Morning OUT", pmIn: "Afternoon IN", pmOut: "Afternoon OUT" };
export const SLOT_SHORT = { amIn: "AM IN", amOut: "AM OUT", pmIn: "PM IN", pmOut: "PM OUT" };
export const DEFAULT_SCHEDULE = {
  amInStart: 300, amInLate: 480, amInEnd: 600,      // IN 5:00-10:00, on time until 8:00
  amOutStart: 720, amOutEnd: 780,                   // OUT 12:00-12:59
  pmInStart: 780, pmInLate: 795, pmInEnd: 900,      // IN 1:00-3:00 PM, on time until 1:15
  pmOutStart: 960, pmOutEnd: 1080                   // OUT 4:00-5:59 PM
};
export const SCHEDULE_KEYS = Object.keys(DEFAULT_SCHEDULE);

const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function minutesOfDay(d = new Date()) {
  const p = timeFmt.formatToParts(d);
  return (+p.find(x => x.type === "hour").value % 24) * 60 + +p.find(x => x.type === "minute").value;
}
export function toMinutes(s) {                       // "07:30" -> 450
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || "");
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}
export const fromMinutes = (n) => String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");   // 450 -> "07:30"
export function label12(n) {                          // 450 -> "7:30 AM"
  const h = Math.floor(n / 60), m = n % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
export const formatTimeShort = (d) => d ? d.toLocaleTimeString("en-PH", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) : "—";

/** Which scan is open at this minute? "amIn" | "amOut" | "pmIn" | "pmOut" | null */
export function scanSlot(min, s) {
  for (const slot of SLOTS) if (min >= s[slot + "Start"] && min < s[slot + "End"]) return slot;
  return null;
}
/** Only the two IN scans can be late. */
export const isLateScan = (slot, min, s) => IN_SLOTS.includes(slot) && min > s[slot + "Late"];

export function validSchedule(s) {
  if (SCHEDULE_KEYS.some(k => !Number.isInteger(s[k]) || s[k] < 0 || s[k] > 1439)) return "Enter every scanning time.";
  for (const slot of SLOTS) if (s[slot + "Start"] >= s[slot + "End"]) return `${SLOT_LABEL[slot]} must close after it opens.`;
  for (const slot of IN_SLOTS) if (s[slot + "Late"] < s[slot + "Start"] || s[slot + "Late"] >= s[slot + "End"])
    return `${SLOT_LABEL[slot]}: "on time until" must be between its opening and closing time.`;
  for (let i = 0; i < SLOTS.length - 1; i++)
    if (s[SLOTS[i] + "End"] > s[SLOTS[i + 1] + "Start"]) return `${SLOT_LABEL[SLOTS[i]]} must close before ${SLOT_LABEL[SLOTS[i + 1]]} opens.`;
  return null;
}

/** CSV cell with quote escaping + spreadsheet-formula neutralising. */
export function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}

const bySectionName = (a, b) => (a.section || "").localeCompare(b.section || "") || (a.name || "").localeCompare(b.name || "");
const attended = (st) => st.state === "present" || st.state === "late";

/**
 * State of each of the 4 scans for one student on one day.
 *   present = recorded (green)   late = recorded after the on-time limit (orange, IN scans only)
 *   absent  = window has closed and nothing was recorded (red)
 *   pending = window not finished yet today (grey)      none = not applicable (future day / deleted student)
 * A missed OUT scan is red even if the student scanned IN later (e.g. no Morning OUT but Afternoon IN done).
 */
export function slotStates({ rec, date, today, nowMin, schedule, removed }) {
  const out = {};
  for (const slot of SLOTS) {
    const e = rec && rec.slots ? rec.slots[slot] : null;
    if (e) out[slot] = { state: IN_SLOTS.includes(slot) && e.late ? "late" : "present", time: e.time };
    else if (removed || date > today) out[slot] = { state: "none", time: null };
    else if (date < today) out[slot] = { state: "absent", time: null };
    else out[slot] = { state: nowMin >= schedule[slot + "End"] ? "absent" : "pending", time: null };
  }
  return out;
}

/**
 * students: [{studentId,name,section,status,registeredDate}]
 * records:  [{studentId,name,section,date,slots:{amIn:{time,late},...}}]  (one per student per day)
 * Single day -> per student the 4 scan states.  Date range -> per-student totals.
 * "School days" = dates that have at least one record.
 */
export function computeReport({ students, records, from, to, today, nowMin = 0, schedule = DEFAULT_SCHEDULE, section }) {
  const byStudent = new Map();                         // studentId -> Map(date -> record)
  for (const r of records) {
    if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, new Map());
    byStudent.get(r.studentId).set(r.date, r);
  }
  const known = new Map(students.map(s => [s.studentId, s]));
  const include = (s) => !section || s.section === section;

  const people = [];
  for (const s of students) {
    if (include(s) && (s.status === "Active" || byStudent.has(s.studentId))) people.push(s);
  }
  for (const [id, days] of byStudent) {                // students deleted after they were scanned
    if (!known.has(id)) {
      const r = [...days.values()][0];
      const s = { studentId: id, name: r.name, section: r.section, status: "Removed", registeredDate: "" };
      if (include(s)) people.push(s);
    }
  }
  people.sort(bySectionName);
  const dates = [...new Set(records.map(r => r.date))].sort();
  const statesFor = (s, date) => slotStates({ rec: byStudent.get(s.studentId)?.get(date), date, today, nowMin, schedule, removed: s.status === "Removed" });

  if (from === to) {
    const rows = people
      .filter(s => byStudent.has(s.studentId) || !s.registeredDate || s.registeredDate <= from)
      .map(s => {
        const slots = statesFor(s, from);
        return { studentId: s.studentId, name: s.name, section: s.section, slots, attended: SLOTS.filter(k => attended(slots[k])).length };
      });
    return { mode: "day", rows, schoolDays: dates.length };
  }

  const rows = people.map(s => {
    let presentDays = 0, absentDays = 0, late = 0, missed = 0, att = 0;
    for (const d of dates) {
      if (s.registeredDate && d < s.registeredDate) continue;
      const slots = statesFor(s, d);
      if (IN_SLOTS.some(k => attended(slots[k]))) presentDays++;
      else if (IN_SLOTS.every(k => slots[k].state === "absent")) absentDays++;
      for (const k of SLOTS) {
        if (attended(slots[k])) att++;
        if (slots[k].state === "late") late++;
        if (slots[k].state === "absent") missed++;
      }
    }
    const due = att + missed;
    return { studentId: s.studentId, name: s.name, section: s.section, presentDays, absentDays, late, missed, pct: due ? Math.round(att * 100 / due) : 0 };
  });
  return { mode: "range", rows, schoolDays: dates.length };
}
