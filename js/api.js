// All Firestore / Auth data access lives here. UI code (app.js) never touches Firestore directly.
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, writeBatch, runTransaction,
  onSnapshot, query, where, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { firebaseConfig } from "./firebase-config.js";
import { dateKey, makeToken, parseQR, scanSlot, isLateScan, minutesOfDay, SLOTS, IN_SLOTS } from "./utils.js";

/*  Data model
 *  users/{uid}                 {name,email,role:'admin'|'teacher'}          role decides what rules allow
 *  settings/system             {schoolName,...}                              shared customization
 *  students/{lrn}              {name,section,status,registeredDate}          readable by all staff
 *  studentDetails/{lrn}        {address,contact,guardian,adviser,principal,schoolYear,photo}   ADMIN ONLY
 *  qrTokens/{token}            {studentId}                                   QR secret -> student lookup
 *  attendance/{date}_{lrn}     {studentId,name,section,date, amIn?,amOut?,pmIn?,pmOut?}   one per student per day;
 *                              each slot = {at,by[,late]}; IN slots carry late:true|false
 */

const toRecord = (d) => {
  const x = d.data({ serverTimestamps: "estimate" });
  const slots = {};
  for (const k of SLOTS) if (x[k] && x[k].at) slots[k] = { time: x[k].at.toDate(), late: !!x[k].late };
  return { id: d.id, studentId: x.studentId, name: x.name, section: x.section, date: x.date, slots };
};

// ---------- live subscriptions ----------
export const subscribeStudents = (cb, err) =>
  onSnapshot(collection(db, "students"), snap => cb(snap.docs.map(d => ({ studentId: d.id, ...d.data() }))), err);

export const subscribeAttendance = (date, cb, err) =>
  onSnapshot(query(collection(db, "attendance"), where("date", "==", date)), snap => cb(snap.docs.map(toRecord)), err);

export async function getAttendanceRange(from, to) {
  const snap = await getDocs(query(collection(db, "attendance"), where("date", ">=", from), where("date", "<=", to)));
  return snap.docs.map(toRecord);
}

// ---------- students ----------
export async function getDetails(lrn) {
  const s = await getDoc(doc(db, "studentDetails", lrn));
  return s.exists() ? s.data() : {};
}

export async function getQrToken(lrn) {
  const q = await getDocs(query(collection(db, "qrTokens"), where("studentId", "==", lrn), limit(1)));
  return q.empty ? null : q.docs[0].id;
}

/** Atomically creates the student, their private details and their unique QR token. */
export async function registerStudent(core, details) {
  const lrn = core.studentId;
  const token = makeToken();
  await runTransaction(db, async (tx) => {
    const ref = doc(db, "students", lrn);
    if ((await tx.get(ref)).exists()) throw new Error("That LRN is already registered.");
    tx.set(ref, { name: core.name, section: core.section, status: core.status, registeredDate: dateKey(), createdAt: serverTimestamp() });
    tx.set(doc(db, "studentDetails", lrn), details);
    tx.set(doc(db, "qrTokens", token), { studentId: lrn, createdAt: serverTimestamp() });
  });
  return token;
}

export async function updateStudent(lrn, core, details) {
  const b = writeBatch(db);
  b.update(doc(db, "students", lrn), { name: core.name, section: core.section, status: core.status });
  b.set(doc(db, "studentDetails", lrn), details);
  await b.commit();
}

/** Deletes the student + details + QR. Past attendance records are kept (they store the name). */
export async function deleteStudent(lrn) {
  const toks = await getDocs(query(collection(db, "qrTokens"), where("studentId", "==", lrn)));
  const b = writeBatch(db);
  b.delete(doc(db, "students", lrn));
  b.delete(doc(db, "studentDetails", lrn));
  toks.forEach(t => b.delete(t.ref));
  await b.commit();
}

/** Lost/stolen ID: invalidates the old QR and issues a new one. */
export async function regenerateQR(lrn) {
  const old = await getDocs(query(collection(db, "qrTokens"), where("studentId", "==", lrn)));
  const token = makeToken();
  const b = writeBatch(db);
  old.forEach(t => b.delete(t.ref));
  b.set(doc(db, "qrTokens", token), { studentId: lrn, createdAt: serverTimestamp() });
  await b.commit();
  return token;
}

// ---------- attendance ----------
/**
 * Validates the scanned QR and records whichever of the 4 daily scans is open right now
 * (Morning IN / Morning OUT / Afternoon IN / Afternoon OUT), using Philippine time and the saved schedule.
 * An IN scan after the "on time until" limit is stored with late:true (shown orange).
 * Returns {ok:true,slot,late,student,time}
 *      or {ok:false,reason:'invalid'|'inactive'|'closed'|'duplicate',slot?,student?,time?,late?}
 * One document per student per day; each slot can be written once (enforced by the Firestore rules).
 */
export async function recordAttendance(raw, schedule) {
  const token = parseQR(raw);
  if (!token) return { ok: false, reason: "invalid" };

  const tok = await getDoc(doc(db, "qrTokens", token));
  if (!tok.exists()) return { ok: false, reason: "invalid" };
  const lrn = tok.data().studentId;

  const sSnap = await getDoc(doc(db, "students", lrn));
  if (!sSnap.exists()) return { ok: false, reason: "invalid" };
  const student = { studentId: lrn, ...sSnap.data() };
  if (student.status !== "Active") return { ok: false, reason: "inactive", student };

  const now = new Date(), min = minutesOfDay(now);
  const slot = scanSlot(min, schedule);
  if (!slot) return { ok: false, reason: "closed", student };

  const date = dateKey(now);
  const ref = doc(db, "attendance", `${date}_${lrn}`);
  const entry = { at: serverTimestamp(), by: auth.currentUser.uid };
  if (IN_SLOTS.includes(slot)) entry.late = isLateScan(slot, min, schedule);

  try {
    const dup = await runTransaction(db, async (tx) => {
      const s = await tx.get(ref);
      const d = s.exists() ? s.data() : null;
      if (d && d[slot]) return d[slot];                              // this scan was already recorded today
      if (d) tx.update(ref, { [slot]: entry });
      else tx.set(ref, { studentId: lrn, name: student.name, section: student.section, date, [slot]: entry });
      return null;
    });
    if (dup) return { ok: false, reason: "duplicate", slot, student, time: dup.at?.toDate?.() ?? null, late: !!dup.late };
  } catch (e) {
    if (e.code === "permission-denied") return { ok: false, reason: "closed", student };   // server clock says the window isn't open
    throw e;
  }
  const saved = (await getDoc(ref)).data()[slot];
  return { ok: true, slot, late: !!saved?.late, student, time: saved?.at?.toDate?.() ?? new Date() };
}

// ---------- staff accounts ----------
export async function loadProfile(uid) {
  const s = await getDoc(doc(db, "users", uid));
  return s.exists() ? s.data() : null;
}

export async function listUsers() {
  const snap = await getDocs(collection(db, "users"));
  return snap.docs.map(d => ({ uid: d.id, ...d.data() })).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

/** Creates the login on a *secondary* Firebase app so the admin stays signed in. */
export async function createStaffUser({ name, email, password, role }) {
  const sec = getApps().find(a => a.name === "secondary") || initializeApp(firebaseConfig, "secondary");
  const secAuth = getAuth(sec);
  const cred = await createUserWithEmailAndPassword(secAuth, email, password);
  await signOut(secAuth);
  await setDoc(doc(db, "users", cred.user.uid), { name, email, role, createdAt: serverTimestamp(), createdBy: auth.currentUser.uid });
}

/** Removing the profile removes all access (rules deny anyone without a profile). */
export async function removeStaffAccess(uid) {
  const b = writeBatch(db);
  b.delete(doc(db, "users", uid));
  await b.commit();
}

// ---------- settings ----------
export async function getSettings() {
  const s = await getDoc(doc(db, "settings", "system"));
  return s.exists() ? s.data() : null;
}
export const saveSettings = (c) => setDoc(doc(db, "settings", "system"), c);
export const subscribeSettings = (cb, err) => onSnapshot(doc(db, "settings", "system"), s => cb(s.exists() ? s.data() : null), err);
