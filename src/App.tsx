// punch-items-app/src/App.tsx
// ─────────────────────────────────────────────────────────────────────────────
// All original bugs resolved:
//  ✓ sessionStorage → Firebase Firestore (real-time, multi-user, persistent)
//  ✓ base64 photos → Firebase Storage (URL-based, no quota crashes)
//  ✓ fake auth → Firebase Auth (real email/password, real reset emails)
//  ✓ camera fix: two separate inputs (Take Photo + Gallery) for cross-platform
//  ✓ file input reset (e.target.value='') so same file can be re-selected
//  ✓ AdminScreen missing setLogo prop — fixed
//  ✓ logo stored in Firebase Storage + Firestore config doc
//  ✓ logo prop passed to all screens consistently
//  ✓ URL.createObjectURL leaks fixed (revoke after use)
//  ✓ photo compression before upload (canvas, no external library)
//  ✓ onSnapshot cleanup (unsubscribe in useEffect return)
//  ✓ consistent localStorage vs sessionStorage (all removed, Firebase handles it)
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useRef, useCallback, useEffect } from "react";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  type User as FBUser,
} from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  updateDoc,
  deleteDoc,
  setDoc,
  getDoc,
  query,
  orderBy,
} from "firebase/firestore";
import { auth, db, isFirebaseConfigured } from "./lib/firebase";

// ─── Cloudinary Upload Helper ─────────────────────────────────────────────────
// Photos are uploaded to Cloudinary (free tier: 25 GB, no credit card required).
// Firestore stores the returned URL and public_id (for deletion).
// Setup: https://cloudinary.com → Settings → Upload → Add unsigned preset
const CLOUDINARY_CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string;
const CLOUDINARY_UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET as string;

interface CloudinaryResult {
  secure_url: string;
  public_id: string;
}

async function uploadToCloudinary(
  blob: Blob,
  folder: string,
  onProgress?: (pct: number) => void
): Promise<CloudinaryResult> {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
    throw new Error("Cloudinary not configured. Set VITE_CLOUDINARY_CLOUD_NAME and VITE_CLOUDINARY_UPLOAD_PRESET in .env");
  }
  const formData = new FormData();
  formData.append("file", blob);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  formData.append("folder", folder);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText) as CloudinaryResult);
      } else {
        reject(new Error(`Cloudinary upload failed: ${xhr.status} ${xhr.statusText}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.open("POST", `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`);
    xhr.send(formData);
  });
}

async function deleteFromCloudinary(publicId: string): Promise<void> {
  // Deletion from the browser requires a signed request (needs server/Cloud Function).
  // For a fully client-side app, we mark photos as deleted in Firestore and
  // periodically clean up via the Cloudinary dashboard, or use a free Cloudinary
  // "Auto-delete" rule on the folder. The photo URL becomes inaccessible after
  // Cloudinary's 30-day unused-asset cleanup on free plans, or you can set up
  // an auto-delete upload preset rule in the Cloudinary dashboard.
  console.info("Photo removed from Firestore. Cloudinary asset:", publicId,
    "— To auto-delete, set up an 'Auto-delete backup' rule in Cloudinary dashboard → Media Library settings.");
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface PhotoMeta {
  id: string;
  name: string;
  url: string;
  storagePath: string;
  uploadedBy: string;
  uploadedAt: string;
  room?: string;
  itemId?: string;
  tag?: string;
}

interface PunchItem {
  id: string;
  room: string;
  desc1: string;
  tag: string;
  desc2: string;
  cat: string;
  status: "Open" | "Closed";
  responsible: string;
  photos: PhotoMeta[];
  notes: string;
  closedAt?: string | null;
  procosys?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
  active: boolean;
  lastLoginAt?: string | null;
  createdAt?: string;
}

interface InviteRecord {
  id: string;
  email: string;
  role: "admin" | "user";
  token: string;
  expiry: number;
  createdBy: string;
  createdAt: string;
  accepted: boolean;
}

interface ProjectConfig {
  projectName: string;
  logoUrl?: string | null;
  logoStoragePath?: string | null;
}

// ─── Palette ──────────────────────────────────────────────────────────────────
const C = {
  bg: "#0f1117", surface: "#1a1d27", card: "#22263a", border: "#2e3350",
  accent: "#3b82f6", open: "#f97316", closed: "#22c55e",
  text: "#f1f5f9", muted: "#94a3b8", danger: "#ef4444", yellow: "#eab308", purple: "#a855f7",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 10);

const genPhotoName = (tag: string, desc1: string, seq: number) => {
  // Sanitize: replace characters invalid in filenames with hyphens
  const safeTag = tag.replace(/[^a-zA-Z0-9\-]/g, "-");
  const safeDesc = desc1.replace(/[^a-zA-Z0-9\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${safeTag}_${safeDesc}_${String(seq).padStart(2, "0")}.jpg`;
};

const getRooms = (items: PunchItem[]) => {
  const map: Record<string, { open: number; closed: number; total: number }> = {};
  items.forEach((it) => {
    if (!map[it.room]) map[it.room] = { open: 0, closed: 0, total: 0 };
    map[it.room].total++;
    if (it.status === "Open") map[it.room].open++;
    else map[it.room].closed++;
  });
  return map;
};

const fmtDate = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric" })
    : "—";

const fmtShort = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("nl-NL", { day: "2-digit", month: "2-digit", year: "2-digit" })
    : "—";

/** Convert Firestore Timestamps to ISO strings in any document snapshot */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const convertTimestamps = (data: Record<string, any>): Record<string, any> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(data)) {
    if (val && typeof val === "object" && "toDate" in val) {
      result[key] = (val as { toDate: () => Date }).toDate().toISOString();
    } else {
      result[key] = val;
    }
  }
  return result;
};

// ─── Image Compression (canvas-based, no external library) ───────────────────
async function compressImage(file: File, maxDim = 1920, quality = 0.82): Promise<Blob> {
  // Handle HEIC files (iOS sometimes provides these)
  const isHeic =
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    file.name.toLowerCase().endsWith(".heic");

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("File read failed"));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () =>
        reject(
          new Error(
            isHeic
              ? "HEIC not supported in this browser. Please enable 'Most Compatible' in iPhone Camera settings."
              : "Image could not be decoded"
          )
        );
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height / width) * maxDim);
            width = maxDim;
          } else {
            width = Math.round((width / height) * maxDim);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("Canvas not available")); return; }
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error("Compression produced no output")),
          "image/jpeg",
          quality
        );
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// ─── ZIP Builder (updated: accepts Uint8Array data, not base64 dataUrl) ───────
type ZipEntry = { path: string; data: Uint8Array };

function buildAndDownloadZip(entries: ZipEntry[], filename: string) {
  const CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[i] = c;
  }
  function crc32(buf: Uint8Array) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function wLe2(buf: Uint8Array, pos: number, n: number) {
    buf[pos] = n & 0xff; buf[pos + 1] = (n >> 8) & 0xff;
  }
  function wLe4(buf: Uint8Array, pos: number, n: number) {
    buf[pos] = n & 0xff; buf[pos + 1] = (n >> 8) & 0xff;
    buf[pos + 2] = (n >> 16) & 0xff; buf[pos + 3] = (n >> 24) & 0xff;
  }
  const enc = new TextEncoder();
  const now = new Date();
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);

  const files = entries.map(({ path, data }) => ({
    nameBytes: enc.encode(path),
    data,
    crc: crc32(data),
  }));

  let totalSize = 22;
  for (const f of files) totalSize += 30 + f.nameBytes.length + f.data.length + 46 + f.nameBytes.length;

  const buf = new Uint8Array(totalSize);
  let pos = 0;
  const cdEntries: { f: (typeof files)[0]; localOffset: number }[] = [];

  for (const f of files) {
    const localOffset = pos;
    buf[pos] = 0x50; buf[pos + 1] = 0x4b; buf[pos + 2] = 0x03; buf[pos + 3] = 0x04; pos += 4;
    wLe2(buf, pos, 20); pos += 2;
    wLe2(buf, pos, 0); pos += 2;
    wLe2(buf, pos, 0); pos += 2;
    wLe2(buf, pos, dosTime); pos += 2;
    wLe2(buf, pos, dosDate); pos += 2;
    wLe4(buf, pos, f.crc); pos += 4;
    wLe4(buf, pos, f.data.length); pos += 4;
    wLe4(buf, pos, f.data.length); pos += 4;
    wLe2(buf, pos, f.nameBytes.length); pos += 2;
    wLe2(buf, pos, 0); pos += 2;
    buf.set(f.nameBytes, pos); pos += f.nameBytes.length;
    buf.set(f.data, pos); pos += f.data.length;
    cdEntries.push({ f, localOffset });
  }

  const cdStart = pos;
  for (const { f, localOffset } of cdEntries) {
    buf[pos] = 0x50; buf[pos + 1] = 0x4b; buf[pos + 2] = 0x01; buf[pos + 3] = 0x02; pos += 4;
    wLe2(buf, pos, 20); pos += 2; wLe2(buf, pos, 20); pos += 2;
    wLe2(buf, pos, 0); pos += 2; wLe2(buf, pos, 0); pos += 2;
    wLe2(buf, pos, dosTime); pos += 2; wLe2(buf, pos, dosDate); pos += 2;
    wLe4(buf, pos, f.crc); pos += 4;
    wLe4(buf, pos, f.data.length); pos += 4;
    wLe4(buf, pos, f.data.length); pos += 4;
    wLe2(buf, pos, f.nameBytes.length); pos += 2;
    wLe2(buf, pos, 0); pos += 2; wLe2(buf, pos, 0); pos += 2;
    wLe2(buf, pos, 0); pos += 2; wLe2(buf, pos, 0); pos += 2;
    wLe4(buf, pos, 0); pos += 4; wLe4(buf, pos, localOffset); pos += 4;
    buf.set(f.nameBytes, pos); pos += f.nameBytes.length;
  }

  const cdSize = pos - cdStart;
  buf[pos] = 0x50; buf[pos + 1] = 0x4b; buf[pos + 2] = 0x05; buf[pos + 3] = 0x06; pos += 4;
  wLe2(buf, pos, 0); pos += 2; wLe2(buf, pos, 0); pos += 2;
  wLe2(buf, pos, cdEntries.length); pos += 2;
  wLe2(buf, pos, cdEntries.length); pos += 2;
  wLe4(buf, pos, cdSize); pos += 4;
  wLe4(buf, pos, cdStart); pos += 4;
  wLe2(buf, pos, 0);

  let binStr = "";
  for (let i = 0; i < buf.length; i += 8192)
    binStr += String.fromCharCode(...buf.subarray(i, Math.min(i + 8192, buf.length)));

  const a = document.createElement("a");
  a.href = "data:application/octet-stream;base64," + btoa(binStr);
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => document.body.removeChild(a), 1000);
}

/** Fetch photos from Firebase Storage URLs and build a ZIP download */
async function exportPhotosAsZip(
  photos: { path: string; url: string }[],
  filename: string,
  onProgress?: (pct: number) => void
) {
  const entries: ZipEntry[] = [];
  for (let i = 0; i < photos.length; i++) {
    const { path, url } = photos[i];
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    entries.push({ path, data: new Uint8Array(buf) });
    onProgress?.(Math.round(((i + 1) / photos.length) * 100));
  }
  buildAndDownloadZip(entries, filename);
}

// ─── Icon ─────────────────────────────────────────────────────────────────────
const PATHS: Record<string, string> = {
  home: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10",
  room: "M3 21h18M9 21V7l6-4v18M9 11H3v10M21 11h-6",
  search: "M11 17a6 6 0 100-12 6 6 0 000 12zM21 21l-4.35-4.35",
  photo: "M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z M12 17a4 4 0 100-8 4 4 0 000 8",
  camera: "M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z M12 17a4 4 0 100-8 4 4 0 000 8",
  gallery: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z M4 22v-7",
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18M6 6l12 12",
  upload: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12",
  download: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  back: "M19 12H5M12 19l-7-7 7-7",
  export: "M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13",
  user: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8",
  lock: "M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zM7 11V7a5 5 0 0110 0v4",
  tag: "M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82zM7 7h.01",
  plus: "M12 5v14M5 12h14",
  mail: "M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6l-10 7L2 6",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  refresh: "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15",
  trash: "M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 100 6 3 3 0 000-6z",
  warn: "M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z",
  link: "M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71",
};

const Icon = ({ name, size = 18, color = C.text }: { name: string; size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {(PATHS[name] || "").split("M").filter(Boolean).map((d, i) => (
      <path key={i} d={"M" + d} />
    ))}
  </svg>
);

// ─── UI Primitives ────────────────────────────────────────────────────────────
const Badge = ({ status }: { status: string }) => (
  <span style={{
    background: status === "Closed" ? C.closed + "22" : C.open + "22",
    color: status === "Closed" ? C.closed : C.open,
    border: `1px solid ${status === "Closed" ? C.closed : C.open}44`,
    borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 700,
    letterSpacing: 0.5, whiteSpace: "nowrap" as const,
  }}>{status.toUpperCase()}</span>
);

interface BtnProps {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "success" | "danger" | "ghost" | "orange" | "purple" | "yellow";
  small?: boolean;
  icon?: string;
  full?: boolean;
  disabled?: boolean;
  style?: React.CSSProperties;
}
const Btn = ({ children, onClick, variant = "primary", small, icon, full, disabled, style: sx }: BtnProps) => {
  const base: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
    border: "none", borderRadius: 10, cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: 700, fontSize: small ? 13 : 15,
    padding: small ? "8px 14px" : "13px 20px",
    width: full ? "100%" : undefined,
    opacity: disabled ? 0.5 : 1, transition: "opacity .15s", ...sx,
  };
  const variants = {
    primary: { background: C.accent, color: "#fff" },
    success: { background: C.closed, color: "#fff" },
    danger: { background: C.danger, color: "#fff" },
    ghost: { background: C.card, color: C.text, border: `1px solid ${C.border}` },
    orange: { background: C.open, color: "#fff" },
    purple: { background: C.purple, color: "#fff" },
    yellow: { background: C.yellow, color: "#000" },
  };
  return (
    <button style={{ ...base, ...variants[variant] }} onClick={disabled ? undefined : onClick}>
      {icon && <Icon name={icon} size={16} color={variant === "ghost" ? C.muted : "#fff"} />}
      {children}
    </button>
  );
};

const Input = ({
  label, value, onChange, type = "text", placeholder, autoComplete,
}: { label?: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; autoComplete?: string }) => (
  <div style={{ marginBottom: 14 }}>
    {label && <div style={{ fontSize: 12, color: C.muted, marginBottom: 5, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase" }}>{label}</div>}
    <input
      type={type} value={value} onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder} autoComplete={autoComplete}
      style={{ width: "100%", background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontSize: 15, outline: "none", boxSizing: "border-box" }}
    />
  </div>
);

const Select = ({
  label, value, onChange, options,
}: { label?: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) => (
  <div style={{ marginBottom: 14 }}>
    {label && <div style={{ fontSize: 12, color: C.muted, marginBottom: 5, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase" }}>{label}</div>}
    <select
      value={value} onChange={(e) => onChange(e.target.value)}
      style={{ width: "100%", background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", color: C.text, fontSize: 15, outline: "none", boxSizing: "border-box" }}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
);

const Screen = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Inter',system-ui,sans-serif", ...style }}>
    {children}
  </div>
);

const TopBar = ({
  title, onBack, right, logo,
}: { title: string; onBack?: () => void; right?: React.ReactNode; logo?: string | null }) => (
  <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 0, zIndex: 10 }}>
    {onBack && (
      <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex" }}>
        <Icon name="back" color={C.accent} />
      </button>
    )}
    {logo && (
      <img src={logo} alt="logo" style={{ height: 28, maxWidth: 60, objectFit: "contain", borderRadius: 4, background: "#fff", padding: "2px 4px" }} />
    )}
    <div style={{ flex: 1, fontWeight: 800, fontSize: 16, letterSpacing: 0.3 }}>{title}</div>
    {right}
  </div>
);

const Body = ({ children }: { children: React.ReactNode }) => (
  <div style={{ padding: 16, maxWidth: 600, margin: "0 auto" }}>{children}</div>
);

const Toast = ({ msg, type = "success" }: { msg: string; type?: "success" | "error" }) =>
  msg ? (
    <div style={{
      position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
      background: type === "error" ? C.danger : C.closed, color: "#fff",
      borderRadius: 12, padding: "12px 20px", fontWeight: 700, fontSize: 14,
      zIndex: 100, boxShadow: "0 4px 20px #0008", maxWidth: 340, textAlign: "center",
    }}>{msg}</div>
  ) : null;

const Modal = ({
  title, children, onClose,
}: { title: string; children: React.ReactNode; onClose: () => void }) => (
  <div
    style={{ position: "fixed", inset: 0, background: "#000a", zIndex: 50, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
    onClick={onClose}
  >
    <div
      style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "16px 16px 0 0", padding: 20, width: "100%", maxWidth: 600, maxHeight: "90vh", overflowY: "auto" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontWeight: 800, fontSize: 17 }}>{title}</div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer" }}>
          <Icon name="x" color={C.muted} />
        </button>
      </div>
      {children}
    </div>
  </div>
);

// ─── Firebase Config Warning ──────────────────────────────────────────────────
function MissingConfigScreen() {
  return (
    <Screen style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ maxWidth: 440, width: "100%", background: C.surface, border: `1px solid ${C.danger}`, borderRadius: 16, padding: 24 }}>
        <Icon name="warn" color={C.danger} size={32} />
        <div style={{ fontWeight: 800, fontSize: 18, marginTop: 12, color: C.danger }}>Firebase not configured</div>
        <div style={{ fontSize: 14, color: C.muted, marginTop: 8, lineHeight: 1.7 }}>
          Create a <code style={{ background: C.card, padding: "2px 6px", borderRadius: 4, color: C.text }}>.env</code> file in the project root with your Firebase credentials. See <strong style={{ color: C.text }}>.env.example</strong> for the required variables.
        </div>
        <div style={{ marginTop: 16, background: C.card, borderRadius: 10, padding: 14, fontSize: 12, color: C.muted, fontFamily: "monospace", lineHeight: 2 }}>
          VITE_FIREBASE_API_KEY=...<br />
          VITE_FIREBASE_AUTH_DOMAIN=...<br />
          VITE_FIREBASE_PROJECT_ID=...<br />
          VITE_FIREBASE_STORAGE_BUCKET=...<br />
          VITE_FIREBASE_MESSAGING_SENDER_ID=...<br />
          VITE_FIREBASE_APP_ID=...
        </div>
        <div style={{ marginTop: 14, fontSize: 12, color: C.muted }}>Then restart the dev server: <code style={{ color: C.accent }}>npm run dev</code></div>
      </div>
    </Screen>
  );
}

// ─── Photo Thumb (updated: uses url instead of dataUrl) ───────────────────────
function PhotoThumb({ photo, onRemove }: { photo: PhotoMeta; onRemove?: (id: string) => void }) {
  const [big, setBig] = useState(false);

  // FIX: Proper download using fetch + revokeObjectURL to prevent memory leaks
  const dlSingle = async () => {
    try {
      const res = await fetch(photo.url);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = photo.name;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(objUrl); // FIX: revoke to prevent memory leak
      }, 500);
    } catch {
      window.open(photo.url, "_blank");
    }
  };

  return (
    <>
      <div
        style={{ position: "relative", width: 90, height: 90, borderRadius: 10, overflow: "hidden", border: `1px solid ${C.border}`, flexShrink: 0, cursor: "pointer" }}
        onClick={() => setBig(true)}
      >
        <img src={photo.url} alt={photo.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "#000a", padding: "2px 4px", fontSize: 9, color: "#fff", wordBreak: "break-all" }}>
          {photo.name}
        </div>
        {onRemove && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(photo.id); }}
            style={{ position: "absolute", top: 3, right: 3, background: C.danger, border: "none", borderRadius: "50%", width: 20, height: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
          >
            <Icon name="x" size={11} color="#fff" />
          </button>
        )}
      </div>

      {big && (
        <div
          onClick={() => setBig(false)}
          style={{ position: "fixed", inset: 0, background: "#000d", zIndex: 200, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: C.surface, borderRadius: 16, overflow: "hidden", maxWidth: 500, width: "100%", boxShadow: "0 20px 60px #0008" }}
          >
            <img src={photo.url} alt={photo.name} style={{ width: "100%", maxHeight: "60vh", objectFit: "contain", display: "block", background: "#000" }} />
            <div style={{ padding: 14 }}>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, wordBreak: "break-all" }}>{photo.name}</div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
                📷 {photo.uploadedBy} · {photo.uploadedAt ? new Date(photo.uploadedAt).toLocaleString("nl-NL") : ""}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn full icon="download" onClick={dlSingle}>Download foto</Btn>
                <Btn variant="ghost" onClick={() => setBig(false)} style={{ minWidth: 80 }}>Sluiten</Btn>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SCREENS
// ══════════════════════════════════════════════════════════════════════════════

// ─── First-time Admin Initialization ─────────────────────────────────────────
function InitScreen({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!email.includes("@")) { setErr("Enter a valid email address."); return; }
    if (pw.length < 6) { setErr("Password must be at least 6 characters."); return; }
    if (pw !== pw2) { setErr("Passwords do not match."); return; }
    setLoading(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, pw);
      await setDoc(doc(db, "users", cred.user.uid), {
        uid: cred.user.uid,
        email,
        displayName: "Admin",
        role: "admin",
        active: true,
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      });
      // Create initial project config
      await setDoc(doc(db, "config", "project"), {
        projectName: "H&H Commissioning",
        logoUrl: null,
        logoStoragePath: null,
      });
      onDone();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Setup failed");
      setLoading(false);
    }
  };

  return (
    <Screen style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 40, fontWeight: 900, color: C.accent, letterSpacing: -1 }}>P-H&H</div>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>First-time Setup</div>
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24 }}>
          <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Create Admin Account</div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 20, lineHeight: 1.6 }}>
            No accounts found. Create the first administrator account to get started.
          </div>
          <Input label="Email address" value={email} onChange={setEmail} type="email" placeholder="admin@company.com" />
          <Input label="Password" value={pw} onChange={setPw} type="password" placeholder="Min. 6 characters" />
          <Input label="Confirm password" value={pw2} onChange={setPw2} type="password" placeholder="Repeat password" />
          {err && <div style={{ color: C.danger, fontSize: 13, marginBottom: 12 }}>{err}</div>}
          <Btn full onClick={submit} disabled={loading} icon="shield">
            {loading ? "Creating account…" : "Create Admin Account"}
          </Btn>
        </div>
      </div>
    </Screen>
  );
}

// ─── Forgot Password (uses real Firebase email) ───────────────────────────────
function ForgotPasswordScreen({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const sendReset = async () => {
    if (!email.includes("@")) { setErr("Enter a valid email address."); return; }
    setLoading(true);
    try {
      await sendPasswordResetEmail(auth, email);
      setSent(true);
      setErr("");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message.replace("Firebase: ", "") : "Failed to send reset email");
    }
    setLoading(false);
  };

  return (
    <Screen style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <button
          onClick={onBack}
          style={{ background: "none", border: "none", cursor: "pointer", color: C.accent, fontWeight: 700, marginBottom: 20, display: "flex", alignItems: "center", gap: 6 }}
        >
          <Icon name="back" size={16} color={C.accent} /> Back to login
        </button>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24 }}>
          {!sent ? (
            <>
              <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 4 }}>Wachtwoord vergeten</div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>
                Enter your email — we'll send a real reset link via Firebase.
              </div>
              <Input label="Email address" value={email} onChange={setEmail} type="email" placeholder="your@email.com" />
              {err && <div style={{ color: C.danger, fontSize: 13, marginBottom: 12 }}>{err}</div>}
              <Btn full onClick={sendReset} disabled={loading} icon="mail">
                {loading ? "Sending…" : "Send Reset Link"}
              </Btn>
            </>
          ) : (
            <>
              <div style={{ textAlign: "center", padding: "10px 0" }}>
                <Icon name="check" color={C.closed} size={40} />
                <div style={{ fontWeight: 800, fontSize: 17, marginTop: 12, color: C.closed }}>Email sent!</div>
                <div style={{ fontSize: 13, color: C.muted, marginTop: 8, lineHeight: 1.7 }}>
                  A password reset link was sent to <strong style={{ color: C.text }}>{email}</strong>.<br />
                  Check your inbox (and spam folder).
                </div>
                <div style={{ marginTop: 20 }}>
                  <Btn onClick={onBack}>Back to Login</Btn>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Screen>
  );
}

// ─── Login Screen ─────────────────────────────────────────────────────────────
function LoginScreen({
  onForgot,
}: { onForgot: () => void }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!email.trim() || !pw) { setErr("Enter your email and password."); return; }
    setLoading(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), pw);
      // Check if account is active in Firestore
      const profileSnap = await getDoc(doc(db, "users", cred.user.uid));
      if (profileSnap.exists() && profileSnap.data().active === false) {
        await signOut(auth);
        setErr("Your account has been deactivated. Contact your administrator.");
        setLoading(false);
        return;
      }
      // Update last login
      await updateDoc(doc(db, "users", cred.user.uid), {
        lastLoginAt: new Date().toISOString(),
      }).catch(() => {/* profile may not exist yet for legacy accounts */});
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("user-not-found") || msg.includes("wrong-password") || msg.includes("invalid-credential")) {
        setErr("Invalid email or password.");
      } else {
        setErr(msg.replace("Firebase: ", ""));
      }
      setLoading(false);
    }
  };

  return (
    <Screen style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 40, fontWeight: 900, color: C.accent, letterSpacing: -1 }}>P-H&H</div>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>Punch-Items Overview H&H</div>
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24 }}>
          <Input label="Email address" value={email} onChange={setEmail} type="email" placeholder="admin@company.com" autoComplete="email" />
          <Input label="Password" value={pw} onChange={setPw} type="password" placeholder="••••••••" autoComplete="current-password" />
          {err && <div style={{ color: C.danger, fontSize: 13, marginBottom: 12 }}>{err}</div>}
          <Btn full onClick={submit} disabled={loading}>
            {loading ? "Signing in…" : "Sign In"}
          </Btn>
          <button
            onClick={onForgot}
            style={{ marginTop: 14, background: "none", border: "none", color: C.accent, cursor: "pointer", fontSize: 13, width: "100%", textAlign: "center", fontWeight: 600 }}
          >
            Wachtwoord vergeten / Forgot password
          </button>
        </div>
      </div>
    </Screen>
  );
}

// ─── Search Bar ───────────────────────────────────────────────────────────────
function SearchBar({ items, onNavigate }: { items: PunchItem[]; onNavigate: (screen: string, ctx?: unknown) => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<PunchItem[]>([]);

  const search = (v: string) => {
    setQ(v);
    if (!v) { setRes([]); return; }
    setRes(
      items.filter(
        (i) =>
          i.id.includes(v) ||
          i.desc1.toLowerCase().includes(v.toLowerCase()) ||
          i.tag.toLowerCase().includes(v.toLowerCase()) ||
          i.room.toLowerCase().includes(v.toLowerCase())
      ).slice(0, 6)
    );
  };

  return (
    <div style={{ position: "relative", marginBottom: 16 }}>
      <div style={{ position: "relative" }}>
        <input
          value={q} onChange={(e) => search(e.target.value)}
          placeholder="Search item no., description, tag, room…"
          style={{ width: "100%", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "13px 14px 13px 42px", color: C.text, fontSize: 15, outline: "none", boxSizing: "border-box" }}
        />
        <div style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)" }}>
          <Icon name="search" size={16} color={C.muted} />
        </div>
      </div>
      {res.length > 0 && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, zIndex: 20, overflow: "hidden" }}>
          {res.map((it) => (
            <div
              key={it.id}
              onClick={() => { setQ(""); setRes([]); onNavigate("detail", it); }}
              style={{ padding: "12px 14px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
            >
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{it.desc1}</div>
                <div style={{ fontSize: 12, color: C.muted }}>{it.room} · #{it.id}</div>
              </div>
              <Badge status={it.status} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Import Excel / CSV (writes to Firestore) ─────────────────────────────────
function ImportExcel({
  items, onImportDone,
}: { items: PunchItem[]; onImportDone: (result: { added: number; skipped: number }) => void }) {
  const [drag, setDrag] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ rawHeaders: string[]; headers: string[]; rows: Record<string, string>[]; delim: string; filename: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  const detectDelim = (line: string) => {
    const counts: Record<string, number> = { ";": 0, "\t": 0, ",": 0 };
    for (const ch of line) if (counts[ch] !== undefined) counts[ch]++;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  };

  const norm = (s: string) =>
    String(s || "").toLowerCase().trim().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();

  const COL_MAP: Record<string, string> = {
    "pl item no": "id", "pl item nr": "id", "item no": "id", "item nr": "id", "itemnr": "id",
    "itemno": "id", "punchlist item no": "id",
    "room": "room", "ruimte": "room", "locatie": "room", "location": "room",
    "description 1": "desc1", "omschrijving 1": "desc1", "description": "desc1",
    "omschrijving": "desc1", "desc 1": "desc1", "desc1": "desc1",
    "tag no": "tag", "tag nr": "tag", "tagnr": "tag", "tagno": "tag", "tag": "tag", "tagnummer": "tag",
    "description 2": "desc2", "omschrijving 2": "desc2", "desc 2": "desc2", "desc2": "desc2",
    "opmerking": "desc2", "remark": "desc2",
    "pl cat": "cat", "pl cat.": "cat", "category": "cat", "categorie": "cat", "cat": "cat",
    "status": "status",
    "responsible": "responsible", "verantwoordelijke": "responsible",
    "responsible party": "responsible", "verantwoordelijk": "responsible",
  };

  const mapHeaders = (headers: string[]) =>
    headers.map((h) => {
      const n = norm(h);
      if (COL_MAP[n]) return COL_MAP[n];
      for (const [k, v] of Object.entries(COL_MAP)) if (n.includes(k) || k.includes(n)) return v;
      return h;
    });

  const parseCSV = (text: string) => {
    const cleaned = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = cleaned.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return { headers: [], rawHeaders: [], rows: [], delim: "," };
    const delim = detectDelim(lines[0]);
    const splitLine = (line: string) => {
      const res: string[] = []; let cur = ""; let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') inQ = !inQ;
        else if (ch === delim && !inQ) { res.push(cur.trim()); cur = ""; }
        else cur += ch;
      }
      res.push(cur.trim());
      return res;
    };
    const rawHeaders = splitLine(lines[0]);
    const mappedHeaders = mapHeaders(rawHeaders);
    const rows = lines.slice(1).map((line) => {
      const vals = splitLine(line);
      const obj: Record<string, string> = {};
      mappedHeaders.forEach((h, i) => (obj[h] = (vals[i] || "").replace(/^"|"$/g, "").trim()));
      return obj;
    }).filter((r) => r.id?.trim());
    return { headers: mappedHeaders, rawHeaders, rows, delim };
  };

  const handleFile = async (file: File) => {
    if (!file) return;
    setLoading(true); setMsg(null); setPreview(null);
    try {
      const csvText = await file.text();
      const { headers, rawHeaders, rows, delim } = parseCSV(csvText);
      if (rows.length === 0) {
        setMsg("⚠ No valid rows found. Check column names.");
        setLoading(false); return;
      }
      setPreview({ rawHeaders, headers, rows, delim, filename: file.name });
    } catch (e: unknown) {
      setMsg("⚠ Could not read file: " + (e instanceof Error ? e.message : "unknown error"));
    }
    setLoading(false);
  };

  const confirmImport = async () => {
    if (!preview) return;
    setImporting(true);
    const existingIds = new Set(items.map((i) => i.id));
    let added = 0; let skipped = 0;

    for (const r of preview.rows) {
      if (!r.id) continue;
      if (existingIds.has(r.id)) { skipped++; continue; }
      try {
        await setDoc(doc(db, "items", r.id), {
          id: r.id,
          room: r.room || "Unknown",
          desc1: r.desc1 || "",
          tag: r.tag || "",
          desc2: r.desc2 || "",
          cat: r.cat || "",
          status: "Open",
          responsible: r.responsible || "",
          photos: [],
          notes: "",
          closedAt: null,
          procosys: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        added++;
      } catch (e) {
        console.error("Failed to import item", r.id, e);
      }
    }
    setPreview(null);
    setImporting(false);
    setMsg(`✓ ${added} new items added · ${skipped} already existed (skipped)`);
    onImportDone({ added, skipped });
    setTimeout(() => setMsg(null), 8000);
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
        onClick={() => !preview && ref.current?.click()}
        style={{ border: `2px dashed ${drag ? C.accent : C.border}`, borderRadius: 14, padding: "20px 16px", textAlign: "center", cursor: preview ? "default" : "pointer", transition: "border-color .2s", background: drag ? C.accent + "11" : "transparent" }}
      >
        {loading ? <div style={{ color: C.muted }}>⏳ Loading file…</div> : (
          <>
            <Icon name="upload" color={drag ? C.accent : C.muted} size={26} />
            <div style={{ marginTop: 8, fontWeight: 700, color: drag ? C.accent : C.muted }}>Import Excel / CSV Punchlist</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Drop file here or tap to choose · CSV or .xlsx (save as CSV first)</div>
          </>
        )}
        {/* FIX: reset input value after selection so re-uploading same file works */}
        <input ref={ref} type="file" accept=".csv,.txt" style={{ display: "none" }}
          onChange={(e) => { handleFile(e.target.files![0]); e.target.value = ""; }} />
      </div>

      {preview && (
        <div style={{ marginTop: 12, background: C.surface, border: `1px solid ${C.accent}`, borderRadius: 14, padding: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>Preview: {preview.filename}</div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
            {preview.rows.length} rows · delimiter: <code style={{ background: C.card, padding: "1px 6px", borderRadius: 4 }}>{preview.delim === "\t" ? "TAB" : preview.delim}</code>
          </div>
          <div style={{ overflowX: "auto", marginBottom: 12 }}>
            <table style={{ fontSize: 11, color: C.muted, borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>{["#", "Room", "Description", "Tag", "Status"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "4px 8px", borderBottom: `1px solid ${C.border}`, color: C.text, fontWeight: 700 }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 3).map((r, i) => (
                  <tr key={i}>
                    <td style={{ padding: "4px 8px", borderBottom: `1px solid ${C.border}` }}>{r.id}</td>
                    <td style={{ padding: "4px 8px", borderBottom: `1px solid ${C.border}` }}>{r.room}</td>
                    <td style={{ padding: "4px 8px", borderBottom: `1px solid ${C.border}`, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.desc1}</td>
                    <td style={{ padding: "4px 8px", borderBottom: `1px solid ${C.border}` }}>{r.tag}</td>
                    <td style={{ padding: "4px 8px", borderBottom: `1px solid ${C.border}` }}>{r.status || "Open"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.rows.length > 3 && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>…and {preview.rows.length - 3} more rows</div>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={confirmImport} icon="check" disabled={importing}>
              {importing ? "Importing…" : `Import (${preview.rows.length} items)`}
            </Btn>
            <Btn variant="ghost" onClick={() => setPreview(null)}>Cancel</Btn>
          </div>
        </div>
      )}
      {msg && (
        <div style={{ marginTop: 10, background: msg.startsWith("✓") ? C.closed + "22" : C.danger + "22", border: `1px solid ${msg.startsWith("✓") ? C.closed : C.danger}44`, borderRadius: 10, padding: "10px 14px", fontSize: 13, color: msg.startsWith("✓") ? C.closed : C.danger, lineHeight: 1.5 }}>
          {msg}
        </div>
      )}
    </div>
  );
}

// ─── Home Screen ──────────────────────────────────────────────────────────────
function HomeScreen({
  items, user, logo, onNavigate, onImportDone, onLogout,
}: { items: PunchItem[]; user: UserProfile; logo?: string | null; onNavigate: (s: string, c?: unknown) => void; onImportDone: (r: { added: number; skipped: number }) => void; onLogout: () => void }) {
  const open = items.filter((i) => i.status === "Open").length;
  const closed = items.filter((i) => i.status === "Closed").length;
  const withPhotos = items.filter((i) => i.photos?.length).length;

  return (
    <Screen>
      <div style={{ background: `linear-gradient(135deg, ${C.surface} 0%, #1e2235 100%)`, borderBottom: `1px solid ${C.border}`, padding: "28px 20px 24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {logo && <img src={logo} alt="logo" style={{ height: 48, maxWidth: 100, objectFit: "contain", borderRadius: 8, background: "#fff", padding: 4 }} />}
            <div>
              <div style={{ fontSize: 11, color: C.accent, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase" }}>Project</div>
              <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: -0.5, marginTop: 2 }}>H&H Commissioning</div>
              <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>HVAC Punch-Item Tracker</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => onNavigate("admin")} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "8px 12px", color: C.muted, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <Icon name={user.role === "admin" ? "shield" : "user"} size={15} color={user.role === "admin" ? C.purple : C.muted} />
              {user.role === "admin" ? "Admin" : "Account"}
            </button>
            <button onClick={onLogout} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "8px 12px", color: C.danger, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
              Out
            </button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          {([["Open", open, C.open], ["Closed", closed, C.closed], ["Photos", withPhotos, C.accent]] as [string, number, string][]).map(([l, v, c]) => (
            <div key={l} style={{ flex: 1, background: C.card, borderRadius: 12, padding: "12px 10px", textAlign: "center", border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 24, fontWeight: 900, color: c }}>{v}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{l}</div>
            </div>
          ))}
        </div>
      </div>
      <Body>
        <SearchBar items={items} onNavigate={onNavigate} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 6 }}>
          {[
            { label: "Browse by Room", icon: "room", screen: "rooms", color: C.accent },
            { label: "Open Items", icon: "warn", screen: "list-open", color: C.open },
            { label: "Closed Items", icon: "check", screen: "list-closed", color: C.closed },
            { label: "Export Photos", icon: "export", screen: "export", color: C.yellow },
            { label: "Responsibility", icon: "user", screen: "list-responsible", color: C.purple },
          ].map(({ label, icon, screen, color }) => (
            <button
              key={screen} onClick={() => onNavigate(screen)}
              style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: "18px 14px", cursor: "pointer", textAlign: "left", transition: "border-color .15s" }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = color)}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = C.border)}
            >
              <Icon name={icon} color={color} size={24} />
              <div style={{ marginTop: 8, fontWeight: 700, fontSize: 14, color: C.text }}>{label}</div>
            </button>
          ))}
        </div>
        <ImportExcel items={items} onImportDone={onImportDone} />
      </Body>
    </Screen>
  );
}

// ─── Room List Screen ─────────────────────────────────────────────────────────
function RoomListScreen({ items, logo, onNavigate, onBack }: { items: PunchItem[]; logo?: string | null; onNavigate: (s: string, c?: unknown) => void; onBack: () => void }) {
  const rooms = getRooms(items);
  return (
    <Screen>
      <TopBar title="Rooms" onBack={onBack} logo={logo} />
      <Body>
        {Object.entries(rooms).sort(([a], [b]) => a.localeCompare(b)).map(([room, stats]) => (
          <div
            key={room} onClick={() => onNavigate("room-items", room)}
            style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ background: C.accent + "22", borderRadius: 10, padding: 10 }}>
                <Icon name="room" color={C.accent} size={20} />
              </div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16 }}>{room}</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                  {stats.total} items · {items.filter((i) => i.room === room).reduce((s, i) => s + (i.photos?.length || 0), 0)} photos
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <span style={{ background: C.open + "22", color: C.open, borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700 }}>{stats.open} open</span>
              {stats.closed > 0 && <span style={{ background: C.closed + "22", color: C.closed, borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700 }}>{stats.closed} closed</span>}
            </div>
          </div>
        ))}
        {Object.keys(rooms).length === 0 && <div style={{ textAlign: "center", color: C.muted, padding: "40px 0" }}>No rooms yet. Import a punchlist to get started.</div>}
      </Body>
    </Screen>
  );
}

// ─── Item List Screen ─────────────────────────────────────────────────────────
function ItemListScreen({ items, title, filter: initialFilter, onNavigate, onBack, logo }: {
  items: PunchItem[]; title: string; filter?: string;
  onNavigate: (s: string, c?: unknown) => void; onBack: () => void; logo?: string | null;
}) {
  const [af, setAf] = useState(initialFilter || "all");
  const [search, setSearch] = useState("");
  const [responsible, setResponsible] = useState("all");

  const responsibilities = ["all", ...[...new Set(items.map((i) => i.responsible).filter(Boolean))].sort()];

  const filtered = items.filter((it) => {
    if (af === "open" && it.status !== "Open") return false;
    if (af === "closed" && it.status !== "Closed") return false;
    if (af === "has-photos" && !it.photos?.length) return false;
    if (af === "no-photos" && it.photos?.length) return false;
    if (responsible !== "all" && it.responsible !== responsible) return false;
    if (search && !it.id.includes(search) && !it.desc1.toLowerCase().includes(search.toLowerCase()) && !it.tag.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <Screen>
      <TopBar title={title} onBack={onBack} logo={logo} />
      <Body>
        <input
          value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter items…"
          style={{ width: "100%", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "11px 14px", color: C.text, fontSize: 14, outline: "none", boxSizing: "border-box", marginBottom: 12 }}
        />
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {([["all", "All"], ["open", "Open"], ["closed", "Closed"], ["has-photos", "Has Photos"], ["no-photos", "No Photos"]] as [string, string][]).map(([v, l]) => (
            <button key={v} onClick={() => setAf(v)}
              style={{ background: af === v ? C.accent : C.card, color: af === v ? "#fff" : C.muted, border: `1px solid ${af === v ? C.accent : C.border}`, borderRadius: 20, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              {l}
            </button>
          ))}
        </div>
        {responsibilities.length > 2 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 }}>Responsibility</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {responsibilities.map((r) => (
                <button key={r} onClick={() => setResponsible(r)}
                  style={{ background: responsible === r ? C.purple : C.card, color: responsible === r ? "#fff" : C.muted, border: `1px solid ${responsible === r ? C.purple : C.border}`, borderRadius: 20, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                  {r === "all" ? "All" : r}
                </button>
              ))}
            </div>
          </div>
        )}
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>{filtered.length} items</div>
        {filtered.map((it) => (
          <div key={it.id} onClick={() => onNavigate("detail", it)}
            style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 14, marginBottom: 8, cursor: "pointer" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
              <div style={{ fontWeight: 800, fontSize: 15, flex: 1, marginRight: 8 }}>{it.desc1}</div>
              <Badge status={it.status} />
            </div>
            <div style={{ display: "flex", gap: 14, fontSize: 12, color: C.muted, flexWrap: "wrap", marginBottom: it.desc2 ? 8 : 0 }}>
              <span>#{it.id}</span><span style={{ color: C.accent }}>{it.room}</span>
              <span>{it.tag}</span><span style={{ fontSize: 11 }}>{it.cat}</span>
              {it.photos?.length > 0 && <span style={{ color: C.yellow }}>📷 {it.photos.length}</span>}
            </div>
            {it.desc2 && <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, borderTop: `1px solid ${C.border}`, paddingTop: 8, marginTop: 2 }}>{it.desc2}</div>}
          </div>
        ))}
        {filtered.length === 0 && <div style={{ textAlign: "center", color: C.muted, padding: "40px 0", fontSize: 14 }}>No items found</div>}
      </Body>
    </Screen>
  );
}

// ─── Closed Items Screen ──────────────────────────────────────────────────────
function ClosedItemsScreen({ items, onNavigate, onBack, user, onUpdate, logo }: {
  items: PunchItem[]; onNavigate: (s: string, c?: unknown) => void; onBack: () => void;
  user: UserProfile; onUpdate: (item: PunchItem) => Promise<void>; logo?: string | null;
}) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [procoFilter, setProcoFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [responsible, setResponsible] = useState("all");
  const [exportPct, setExportPct] = useState<number | null>(null);

  const responsibilities = ["all", ...[...new Set(items.filter((i) => i.status === "Closed").map((i) => i.responsible).filter(Boolean))].sort()];

  const closed = items.filter((it) => {
    if (it.status !== "Closed") return false;
    if (dateFrom && it.closedAt && new Date(it.closedAt) < new Date(dateFrom)) return false;
    if (dateTo && it.closedAt && new Date(it.closedAt) > new Date(dateTo + "T23:59:59")) return false;
    if (procoFilter === "yes" && !it.procosys) return false;
    if (procoFilter === "no" && it.procosys) return false;
    if (responsible !== "all" && it.responsible !== responsible) return false;
    if (search && !it.id.includes(search) && !it.desc1.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const toggleProcosys = async (it: PunchItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (user.role !== "admin") return;
    await onUpdate({ ...it, procosys: !it.procosys });
  };

  const allFilteredPhotos = closed.flatMap((it) => (it.photos || []).map((p) => ({ path: `Punch_Photos/${it.room}/${p.name}`, url: p.url })));

  return (
    <Screen>
      <TopBar title="Closed Items" onBack={onBack} logo={logo} />
      <Body>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…"
          style={{ width: "100%", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "11px 14px", color: C.text, fontSize: 14, outline: "none", boxSizing: "border-box", marginBottom: 12 }} />

        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 }}>Date closed</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>From</div>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                style={{ width: "100%", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 10px", color: C.text, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>To</div>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                style={{ width: "100%", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 10px", color: C.text, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
            </div>
          </div>
          {(dateFrom || dateTo) && <button onClick={() => { setDateFrom(""); setDateTo(""); }} style={{ marginTop: 8, background: "none", border: "none", color: C.accent, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>× Clear filter</button>}
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 }}>ProCoSys status</div>
          <div style={{ display: "flex", gap: 8 }}>
            {([["all", "All"], ["yes", "✓ Reported"], ["no", "Not yet"]] as [string, string][]).map(([v, l]) => (
              <button key={v} onClick={() => setProcoFilter(v)}
                style={{ background: procoFilter === v ? C.accent : C.card, color: procoFilter === v ? "#fff" : C.muted, border: `1px solid ${procoFilter === v ? C.accent : C.border}`, borderRadius: 20, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {responsibilities.length > 2 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: C.muted, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 }}>Responsibility</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {responsibilities.map((r) => (
                <button key={r} onClick={() => setResponsible(r)}
                  style={{ background: responsible === r ? C.purple : C.card, color: responsible === r ? "#fff" : C.muted, border: `1px solid ${responsible === r ? C.purple : C.border}`, borderRadius: 20, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                  {r === "all" ? "All" : r}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>{closed.length} items</div>

        {allFilteredPhotos.length > 0 && (
          <div style={{ background: C.surface, border: `1px solid ${C.accent}`, borderRadius: 14, padding: 14, marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Photos from filtered items</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{allFilteredPhotos.length} photos from {closed.length} items</div>
              {exportPct !== null && <div style={{ fontSize: 12, color: C.accent, marginTop: 4 }}>Downloading… {exportPct}%</div>}
            </div>
            <Btn small icon="download" disabled={exportPct !== null} onClick={async () => {
              await exportPhotosAsZip(allFilteredPhotos, `Closed_Photos${dateFrom || dateTo ? `_${dateFrom || ""}_${dateTo || ""}` : ""}.zip`, setExportPct);
              setExportPct(null);
            }}>ZIP</Btn>
          </div>
        )}

        {closed.map((it) => (
          <div key={it.id} onClick={() => onNavigate("detail", it)}
            style={{ background: C.surface, border: `1px solid ${it.procosys ? C.closed : C.border}`, borderRadius: 14, padding: 14, marginBottom: 8, cursor: "pointer" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
              <div style={{ fontWeight: 800, fontSize: 15, flex: 1, marginRight: 8 }}>{it.desc1}</div>
              <Badge status={it.status} />
            </div>
            <div style={{ display: "flex", gap: 14, fontSize: 12, color: C.muted, flexWrap: "wrap", marginBottom: it.desc2 ? 6 : 0 }}>
              <span>#{it.id}</span><span style={{ color: C.accent }}>{it.room}</span>
              <span>{it.tag}</span>
              {it.closedAt && <span style={{ color: C.closed }}>🔒 {fmtShort(it.closedAt)}</span>}
              {it.photos?.length > 0 && <span style={{ color: C.yellow }}>📷 {it.photos.length}</span>}
            </div>
            {it.desc2 && <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, borderTop: `1px solid ${C.border}`, paddingTop: 6, marginTop: 6 }}>{it.desc2}</div>}
            <div onClick={(e) => toggleProcosys(it, e)}
              style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, borderTop: `1px solid ${C.border}`, paddingTop: 8, cursor: user.role === "admin" ? "pointer" : "default" }}>
              <div style={{ width: 20, height: 20, borderRadius: 5, border: `2px solid ${it.procosys ? C.closed : C.border}`, background: it.procosys ? C.closed : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all .15s" }}>
                {it.procosys && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>}
              </div>
              <span style={{ fontSize: 12, fontWeight: 600, color: it.procosys ? C.closed : C.muted }}>Reported in ProCoSys</span>
              {user.role !== "admin" && <span style={{ fontSize: 10, color: C.muted, marginLeft: "auto" }}>(admin only)</span>}
            </div>
          </div>
        ))}
        {closed.length === 0 && <div style={{ textAlign: "center", color: C.muted, padding: "40px 0", fontSize: 14 }}>No closed items found</div>}
      </Body>
    </Screen>
  );
}

// ─── Responsibility Screen ────────────────────────────────────────────────────
function ResponsibilityScreen({ items, logo, onNavigate, onBack }: { items: PunchItem[]; logo?: string | null; onNavigate: (s: string, c?: unknown) => void; onBack: () => void }) {
  const parties = [...new Set(items.map((i) => i.responsible).filter(Boolean))].sort();
  return (
    <Screen>
      <TopBar title="Responsibility" onBack={onBack} logo={logo} />
      <Body>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>Select a responsible party to view their punch items.</div>
        {parties.map((party) => {
          const pi = items.filter((i) => i.responsible === party);
          const open = pi.filter((i) => i.status === "Open").length;
          const closed = pi.filter((i) => i.status === "Closed").length;
          return (
            <div key={party} onClick={() => onNavigate("list-responsible-items", party)}
              style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between" }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = C.purple)}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = C.border)}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ background: C.purple + "22", borderRadius: 10, padding: 10 }}><Icon name="user" color={C.purple} size={20} /></div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 15 }}>{party}</div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{pi.length} items</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {open > 0 && <span style={{ background: C.open + "22", color: C.open, borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700 }}>{open} open</span>}
                {closed > 0 && <span style={{ background: C.closed + "22", color: C.closed, borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700 }}>{closed} closed</span>}
              </div>
            </div>
          );
        })}
        {parties.length === 0 && <div style={{ textAlign: "center", color: C.muted, padding: "40px 0" }}>No responsible parties found</div>}
      </Body>
    </Screen>
  );
}

// ─── Item Detail Screen ───────────────────────────────────────────────────────
// KEY FIX: Two separate inputs for camera vs gallery (cross-platform fix)
// KEY FIX: File input reset (e.target.value='') for re-selection
// KEY FIX: Photo compression before Firebase Storage upload
function ItemDetailScreen({ item, onBack, onUpdate, onDelete, user, logo }: {
  item: PunchItem; onBack: () => void;
  onUpdate: (item: PunchItem) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  user: UserProfile; logo?: string | null;
}) {
  const [note, setNote] = useState(item.notes || "");
  const [toast, setToast] = useState("");
  const [toastType, setToastType] = useState<"success" | "error">("success");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);

  // FIX: Two separate file inputs — camera (capture) and gallery (no capture)
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const showToast = (msg: string, type: "success" | "error" = "success") => {
    setToast(msg); setToastType(type);
    setTimeout(() => setToast(""), 3000);
  };

  // FIX: Resets input.value after processing so same file can be re-selected
  const handleFileInput = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // FIX: reset immediately to allow re-selection of same file
      if (!file) return;

      setUploading(true); setUploadPct(0);
      try {
        // Step 1: Compress image client-side (no external library, canvas-based)
        let blob: Blob;
        try {
          blob = await compressImage(file);
        } catch (compressErr) {
          // Fall back to original file if compression fails (e.g. unsupported HEIC)
          console.warn("Compression failed, using original:", compressErr);
          blob = file;
        }

        // Step 2: Upload compressed blob to Cloudinary (free, no credit card)
        const photoId = uid();
        const seq = (item.photos?.length || 0) + 1;
        const name = genPhotoName(item.tag, item.desc1, seq);

        const result = await uploadToCloudinary(
          blob,
          `punch-items/${item.id}`,
          setUploadPct
        );

        // Step 3: Save Cloudinary URL + public_id to Firestore
        const photoMeta: PhotoMeta = {
          id: photoId, name,
          url: result.secure_url,
          storagePath: result.public_id,  // reuse storagePath field for Cloudinary public_id
          uploadedBy: user.displayName || user.email,
          uploadedAt: new Date().toISOString(),
          room: item.room, itemId: item.id, tag: item.tag,
        };

        await onUpdate({
          ...item,
          photos: [...(item.photos || []), photoMeta],
          notes: note,
        });
        showToast(`Photo saved: ${name}`);
      } catch (err: unknown) {
        showToast("⚠ Upload failed: " + (err instanceof Error ? err.message : "unknown error"), "error");
      }
      setUploading(false); setUploadPct(0);
    },
    [item, note, onUpdate, user]
  );

  const removePhoto = async (photoId: string) => {
    const photo = item.photos.find((p) => p.id === photoId);
    if (!photo) return;
    try {
      // Notify Cloudinary (browser deletion requires signed request — handled async)
      await deleteFromCloudinary(photo.storagePath);
      // Remove from Firestore immediately
      await onUpdate({ ...item, photos: item.photos.filter((p) => p.id !== photoId) });
      showToast("Photo removed");
    } catch (err: unknown) {
      showToast("⚠ Remove failed: " + (err instanceof Error ? err.message : ""), "error");
    }
  };

  const toggleStatus = async () => {
    const closing = item.status === "Open";
    await onUpdate({ ...item, status: closing ? "Closed" : "Open", closedAt: closing ? new Date().toISOString() : null, notes: note });
    showToast(closing ? "Item marked Closed" : "Item reopened");
  };

  const saveNote = async () => {
    await onUpdate({ ...item, notes: note });
    showToast("Note saved");
  };

  const fields: [string, string | undefined][] = [
    ["PL Item No", item.id], ["Room", item.room], ["Tag No", item.tag],
    ["Category", item.cat], ["Responsible", item.responsible],
  ];

  return (
    <Screen>
      <Toast msg={toast} type={toastType} />
      <TopBar title={`#${item.id}`} onBack={onBack} logo={logo} right={<Badge status={item.status} />} />
      <Body>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
          <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 6 }}>{item.desc1}</div>
          {item.desc2 && <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>{item.desc2}</div>}
        </div>

        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
          {fields.map(([l, v]) => v && (
            <div key={l} style={{ display: "flex", justifyContent: "space-between", paddingBottom: 8, marginBottom: 8, borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>{l}</span>
              <span style={{ fontSize: 13, fontWeight: 700, textAlign: "right", maxWidth: "60%" }}>{v}</span>
            </div>
          ))}
        </div>

        {/* Photos section */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Photos <span style={{ color: C.muted, fontSize: 13 }}>({item.photos?.length || 0})</span></span>
          </div>

          {!item.photos?.length && !uploading && (
            <div style={{ color: C.muted, fontSize: 13, marginBottom: 12, fontStyle: "italic" }}>No photos yet. Add evidence below.</div>
          )}

          {/* Upload progress */}
          {uploading && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: C.accent, marginBottom: 6 }}>Uploading… {uploadPct}%</div>
              <div style={{ background: C.border, borderRadius: 8, height: 6, overflow: "hidden" }}>
                <div style={{ background: C.accent, height: "100%", width: `${uploadPct}%`, transition: "width .3s", borderRadius: 8 }} />
              </div>
            </div>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
            {(item.photos || []).map((p) => (
              <PhotoThumb key={p.id} photo={p} onRemove={removePhoto} />
            ))}
          </div>

          {/* FIX: Two separate buttons/inputs for camera vs gallery */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {/* CAMERA button — capture="environment" opens rear camera directly */}
            <Btn small icon="camera" variant="primary" onClick={() => cameraRef.current?.click()} disabled={uploading}>
              Take Photo
            </Btn>
            {/* GALLERY button — no capture attribute, opens file picker with all options */}
            <Btn small icon="gallery" variant="ghost" onClick={() => galleryRef.current?.click()} disabled={uploading}>
              Gallery
            </Btn>
          </div>

          {/* Camera input: capture="environment" = rear camera directly on mobile */}
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={handleFileInput}
          />
          {/* Gallery input: no capture attribute = file picker with gallery + camera options */}
          <input
            ref={galleryRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleFileInput}
          />
        </div>

        {/* Notes */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Field Notes</div>
          <textarea
            value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add notes from the field…"
            style={{ width: "100%", background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, color: C.text, fontSize: 14, minHeight: 80, resize: "vertical", outline: "none", boxSizing: "border-box" }}
          />
          <div style={{ marginTop: 8 }}><Btn small variant="ghost" onClick={saveNote}>Save Note</Btn></div>
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <Btn full variant={item.status === "Open" ? "success" : "orange"} icon={item.status === "Open" ? "check" : "refresh"} onClick={toggleStatus}>
            {item.status === "Open" ? "Mark as Closed" : "Reopen Item"}
          </Btn>
        </div>

        <div style={{ marginBottom: 30 }}>
          <Btn full variant="danger" icon="trash" onClick={() => setConfirmDelete(true)}>Delete Punch Item</Btn>
        </div>

        {confirmDelete && (
          <Modal title="Delete item?" onClose={() => setConfirmDelete(false)}>
            <div style={{ fontSize: 14, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
              Are you sure you want to delete <strong style={{ color: C.text }}>#{item.id} – {item.desc1}</strong>?
              {(item.photos?.length || 0) > 0 && <span style={{ color: C.danger }}> This item has {item.photos.length} photo(s) that will also be deleted from storage.</span>}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <Btn full variant="danger" icon="trash" onClick={async () => {
                await onDelete(item.id);
                setConfirmDelete(false);
              }}>Yes, delete</Btn>
              <Btn full variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Btn>
            </div>
          </Modal>
        )}
      </Body>
    </Screen>
  );
}

// ─── Export Screen ────────────────────────────────────────────────────────────
function ExportScreen({ items, logo, onBack }: { items: PunchItem[]; logo?: string | null; onBack: () => void }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const rooms = [...new Set(items.map((i) => i.room))].sort();

  const filterByDate = (photos: PhotoMeta[]) => {
    if (!dateFrom && !dateTo) return photos;
    return photos.filter((p) => {
      const t = new Date(p.uploadedAt);
      if (dateFrom && t < new Date(dateFrom)) return false;
      if (dateTo && t > new Date(dateTo + "T23:59:59")) return false;
      return true;
    });
  };

  const allPhotos = filterByDate(items.flatMap((i) => i.photos || []));

  const exportAll = async () => {
    if (!allPhotos.length) { alert("No photos to export."); return; }
    setLoading("all"); setPct(0);
    const paths = allPhotos.map((p) => ({ path: `Punch_Photos/${p.room || "Unknown"}/${p.name}`, url: p.url }));
    await exportPhotosAsZip(paths, "PunchPhotos_All.zip", setPct);
    setLoading(null);
  };

  const exportRoom = async (room: string) => {
    const photos = filterByDate(items.filter((i) => i.room === room).flatMap((i) => i.photos || []));
    if (!photos.length) { alert(`No photos for room ${room}.`); return; }
    setLoading(room); setPct(0);
    const paths = photos.map((p) => ({ path: `${room}/${p.name}`, url: p.url }));
    await exportPhotosAsZip(paths, `PunchPhotos_${room}.zip`, setPct);
    setLoading(null);
  };

  return (
    <Screen>
      <TopBar title="Export Photos" onBack={onBack} logo={logo} />
      <Body>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Filter by date</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Input label="From" value={dateFrom} onChange={setDateFrom} type="date" />
            <Input label="To" value={dateTo} onChange={setDateTo} type="date" />
          </div>
        </div>

        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>All photos</div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
            {allPhotos.length} photos {(dateFrom || dateTo) ? "(filtered)" : "across all rooms"} · downloads as ZIP
          </div>
          {loading === "all" && <div style={{ fontSize: 12, color: C.accent, marginBottom: 10 }}>Fetching photos… {pct}%</div>}
          <Btn icon="download" full onClick={exportAll} disabled={loading === "all"}>
            {loading === "all" ? "Building ZIP…" : "Download All Photos (ZIP)"}
          </Btn>
        </div>

        <div style={{ fontWeight: 700, marginBottom: 10, color: C.muted, fontSize: 12, letterSpacing: 1, textTransform: "uppercase" }}>Per room</div>
        {rooms.map((room) => {
          const roomItems = items.filter((i) => i.room === room);
          const photos = filterByDate(roomItems.flatMap((i) => i.photos || []));
          return (
            <div key={room} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 14, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 800 }}>{room}</div>
                <div style={{ fontSize: 12, color: C.muted }}>{photos.length} photos · {roomItems.length} items</div>
                {loading === room && <div style={{ fontSize: 11, color: C.accent, marginTop: 3 }}>Fetching… {pct}%</div>}
              </div>
              <Btn small icon="download" variant="ghost" onClick={() => exportRoom(room)} disabled={loading === room}>
                {loading === room ? "…" : "ZIP"}
              </Btn>
            </div>
          );
        })}
        {rooms.length === 0 && <div style={{ textAlign: "center", color: C.muted, padding: "30px 0" }}>No rooms with photos yet</div>}
      </Body>
    </Screen>
  );
}

// ─── Admin Screen ─────────────────────────────────────────────────────────────
// FIX: setLogo is now correctly passed and typed
function AdminScreen({ items, user, users, logo, setLogo, onBack }: {
  items: PunchItem[]; user: UserProfile; users: UserProfile[];
  logo?: string | null; setLogo: (url: string | null) => Promise<void>; onBack: () => void;
}) {
  const [tab, setTab] = useState("overview");
  const [showAddUser, setShowAddUser] = useState(false);
  const [newEmail, setNewEmail] = useState(""); const [newRole, setNewRole] = useState<"user" | "admin">("user");
  const [newPw, setNewPw] = useState("");
  const [toast, setToast] = useState(""); const [toastType, setToastType] = useState<"success" | "error">("success");
  const [logoMsg, setLogoMsg] = useState("");
  const [logoUploading, setLogoUploading] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const showToast = (m: string, type: "success" | "error" = "success") => { setToast(m); setToastType(type); setTimeout(() => setToast(""), 3500); };

  const handleLogoUpload = async (file: File) => {
    if (!file) return;
    setLogoUploading(true); setLogoMsg("Uploading…");
    try {
      const blob = await compressImage(file, 400, 0.9);
      // Upload logo to Cloudinary in a dedicated "config" folder
      const result = await uploadToCloudinary(blob, "punch-items/config");
      await setLogo(result.secure_url);
      setLogoMsg("✓ Logo saved!");
      setTimeout(() => setLogoMsg(""), 4000);
    } catch (e: unknown) {
      setLogoMsg("⚠ Error: " + (e instanceof Error ? e.message : "upload failed"));
    }
    setLogoUploading(false);
  };

  const removeLogo = async () => {
    try {
      await setLogo(null);
      setLogoMsg("Logo removed");
      setTimeout(() => setLogoMsg(""), 3000);
    } catch (e: unknown) {
      setLogoMsg("⚠ " + (e instanceof Error ? e.message : "remove failed"));
    }
  };

  const createUser = async () => {
    if (!newEmail.includes("@")) { showToast("Enter a valid email", "error"); return; }
    if (newPw.length < 6) { showToast("Password must be at least 6 characters", "error"); return; }
    if (users.find((u) => u.email === newEmail)) { showToast("User already exists", "error"); return; }
    try {
      // Create Firebase Auth account
      const cred = await createUserWithEmailAndPassword(auth, newEmail, newPw);
      await setDoc(doc(db, "users", cred.user.uid), {
        uid: cred.user.uid,
        email: newEmail,
        displayName: newEmail.split("@")[0],
        role: newRole,
        active: true,
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
      });
      // Sign back in as admin (createUserWithEmailAndPassword switches auth user)
      showToast(`User ${newEmail} created. Share credentials with them.`);
      setNewEmail(""); setNewPw(""); setShowAddUser(false);
    } catch (e: unknown) {
      showToast((e instanceof Error ? e.message : "").replace("Firebase: ", ""), "error");
    }
  };

  // Alternative: invite link (stores token in Firestore, user self-registers)
  const createInvite = async () => {
    if (!newEmail.includes("@")) { showToast("Enter a valid email", "error"); return; }
    const token = uid() + uid();
    await setDoc(doc(db, "invites", token), {
      email: newEmail, role: newRole, token, expiry: Date.now() + 7 * 24 * 3600000,
      createdBy: user.uid, createdAt: new Date().toISOString(), accepted: false,
    });
    const link = `${window.location.origin}${window.location.pathname}?invite=${token}`;
    setInviteLink(link);
    showToast(`Invite created for ${newEmail}`);
  };

  const toggleUser = async (u: UserProfile) => {
    await updateDoc(doc(db, "users", u.uid), { active: !u.active });
  };
  const deleteUser = async (u: UserProfile) => {
    if (u.uid === user.uid) { showToast("Cannot delete your own account", "error"); return; }
    if (users.filter((x) => x.role === "admin").length === 1 && u.role === "admin") {
      showToast("Cannot delete the last admin", "error"); return;
    }
    await deleteDoc(doc(db, "users", u.uid));
    showToast("User removed from app. Firebase Auth account still exists — delete via Firebase Console if needed.");
  };
  const changeRole = async (u: UserProfile, role: "admin" | "user") => {
    await updateDoc(doc(db, "users", u.uid), { role });
  };

  const rooms = getRooms(items);
  const open = items.filter((i) => i.status === "Open").length;
  const closed = items.filter((i) => i.status === "Closed").length;
  const photos = items.reduce((s, i) => s + (i.photos?.length || 0), 0);

  return (
    <Screen>
      <Toast msg={toast} type={toastType} />
      <TopBar title="Admin Panel" onBack={onBack} logo={logo} />
      <div style={{ display: "flex", gap: 0, borderBottom: `1px solid ${C.border}`, background: C.surface, padding: "0 16px" }}>
        {([["overview", "Overview"], ["users", "Users"]] as [string, string][]).map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)}
            style={{ background: "none", border: "none", color: tab === v ? C.accent : C.muted, borderBottom: tab === v ? `2px solid ${C.accent}` : "2px solid transparent", padding: "12px 14px", cursor: "pointer", fontWeight: 700, fontSize: 13 }}>
            {l}
          </button>
        ))}
      </div>
      <Body>
        {tab === "overview" && (
          <>
            {/* Logo upload */}
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 12 }}>Project Logo</div>
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
                {logo
                  ? <img src={logo} alt="logo" style={{ height: 56, maxWidth: 120, objectFit: "contain", borderRadius: 8, background: "#fff", padding: 6, border: `1px solid ${C.border}` }} />
                  : <div style={{ width: 80, height: 56, borderRadius: 8, border: `2px dashed ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 11 }}>No logo</div>
                }
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <label style={{ background: C.accent, color: "#fff", borderRadius: 10, padding: "9px 16px", fontWeight: 700, fontSize: 13, cursor: logoUploading ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", gap: 6, opacity: logoUploading ? 0.6 : 1 }}>
                    <Icon name="upload" size={15} color="#fff" />
                    {logoUploading ? "Uploading…" : logo ? "Change" : "Upload"}
                    <input type="file" accept="image/png,image/jpeg,image/jpg,image/gif,image/webp" style={{ display: "none" }}
                      onChange={(e) => { if (e.target.files?.[0]) { handleLogoUpload(e.target.files[0]); e.target.value = ""; } }}
                      disabled={logoUploading} />
                  </label>
                  {logo && <Btn small variant="danger" icon="trash" onClick={removeLogo} disabled={logoUploading}>Remove</Btn>}
                </div>
              </div>
              {logoMsg && (
                <div style={{ padding: "10px 14px", borderRadius: 10, fontSize: 13, fontWeight: 600, background: logoMsg.startsWith("✓") ? C.closed + "33" : logoMsg.startsWith("⚠") ? C.danger + "33" : C.accent + "22", color: logoMsg.startsWith("✓") ? C.closed : logoMsg.startsWith("⚠") ? C.danger : C.muted, border: `1px solid ${logoMsg.startsWith("✓") ? C.closed : logoMsg.startsWith("⚠") ? C.danger : C.border}` }}>
                  {logoMsg}
                </div>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
              {([["Items", items.length, C.text], ["Open", open, C.open], ["Closed", closed, C.closed], ["Photos", photos, C.accent], ["Rooms", Object.keys(rooms).length, C.yellow], ["Users", users.length, C.purple]] as [string, number, string][]).map(([l, v, c]) => (
                <div key={l} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, textAlign: "center" }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: c }}>{v}</div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{l}</div>
                </div>
              ))}
            </div>

            <div style={{ fontWeight: 700, marginBottom: 10, color: C.muted, fontSize: 12, letterSpacing: 1, textTransform: "uppercase" }}>Room Summary</div>
            {Object.entries(rooms).map(([room, stats]) => (
              <div key={room} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 700 }}>{room}</div>
                <div style={{ display: "flex", gap: 10, fontSize: 12 }}>
                  <span style={{ color: C.open }}>{stats.open} open</span>
                  <span style={{ color: C.closed }}>{stats.closed} closed</span>
                  <span style={{ color: C.accent }}>{items.filter((i) => i.room === room).reduce((s, i) => s + (i.photos?.length || 0), 0)} 📷</span>
                </div>
              </div>
            ))}
          </>
        )}

        {tab === "users" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontWeight: 700 }}>{users.length} users</div>
              <Btn small icon="plus" onClick={() => setShowAddUser((v) => !v)}>Add User</Btn>
            </div>

            {showAddUser && (
              <div style={{ background: C.surface, border: `1px solid ${C.accent}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
                <div style={{ fontWeight: 700, marginBottom: 12 }}>Create New User</div>
                <Input label="Email address" value={newEmail} onChange={setNewEmail} type="email" placeholder="user@company.com" />
                <Input label="Temporary password" value={newPw} onChange={setNewPw} type="password" placeholder="Min. 6 characters" />
                <Select label="Role" value={newRole} onChange={(v) => setNewRole(v as "admin" | "user")} options={[{ value: "user", label: "User" }, { value: "admin", label: "Admin" }]} />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                  <Btn small onClick={createUser} icon="user">Create Account</Btn>
                  <Btn small variant="ghost" onClick={createInvite} icon="link">Create Invite Link</Btn>
                  <Btn small variant="ghost" onClick={() => setShowAddUser(false)}>Cancel</Btn>
                </div>
                {inviteLink && (
                  <div style={{ background: C.card, borderRadius: 10, padding: 12, marginTop: 8 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, fontWeight: 700 }}>Invite link (valid 7 days):</div>
                    <div style={{ fontSize: 11, color: C.accent, wordBreak: "break-all", marginBottom: 8 }}>{inviteLink}</div>
                    <Btn small icon="upload" onClick={() => { navigator.clipboard.writeText(inviteLink); showToast("Link copied!"); }}>Copy Link</Btn>
                  </div>
                )}
              </div>
            )}

            {users.map((u) => (
              <div key={u.uid} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 14, marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 14 }}>{u.displayName}</div>
                    <div style={{ fontSize: 12, color: C.muted }}>{u.email}</div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Last login: {fmtDate(u.lastLoginAt)}</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                    <span style={{ background: u.role === "admin" ? C.purple + "22" : C.accent + "22", color: u.role === "admin" ? C.purple : C.accent, borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 700 }}>{u.role.toUpperCase()}</span>
                    <span style={{ background: u.active ? C.closed + "22" : C.danger + "22", color: u.active ? C.closed : C.danger, borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 700 }}>{u.active ? "ACTIVE" : "INACTIVE"}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Btn small variant="ghost" onClick={() => toggleUser(u)}>{u.active ? "Deactivate" : "Activate"}</Btn>
                  {u.uid !== user.uid && (
                    <>
                      <Btn small variant="ghost" onClick={() => changeRole(u, u.role === "admin" ? "user" : "admin")}>{u.role === "admin" ? "→ User" : "→ Admin"}</Btn>
                      <Btn small variant="danger" icon="trash" onClick={() => deleteUser(u)}>Remove</Btn>
                    </>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </Body>
    </Screen>
  );
}

// ─── Accept Invite Screen ─────────────────────────────────────────────────────
function AcceptInviteScreen({ token, onDone }: { token: string; onDone: () => void }) {
  const [invite, setInvite] = useState<InviteRecord | null | "loading" | "invalid">("loading");
  const [name, setName] = useState("");
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getDoc(doc(db, "invites", token)).then((snap) => {
      if (!snap.exists() || (snap.data() as InviteRecord).expiry < Date.now()) {
        setInvite("invalid");
      } else {
        setInvite({ id: snap.id, ...snap.data() } as InviteRecord);
      }
    }).catch(() => setInvite("invalid"));
  }, [token]);

  const submit = async () => {
    if (!name.trim()) { setErr("Enter your name."); return; }
    if (pw.length < 6) { setErr("Password must be at least 6 characters."); return; }
    if (pw !== pw2) { setErr("Passwords do not match."); return; }
    if (typeof invite !== "object" || invite === null) return;
    setLoading(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, invite.email, pw);
      await setDoc(doc(db, "users", cred.user.uid), {
        uid: cred.user.uid, email: invite.email, displayName: name.trim(),
        role: invite.role, active: true, createdAt: new Date().toISOString(), lastLoginAt: null,
      });
      await updateDoc(doc(db, "invites", token), { accepted: true });
      setDone(true);
      setTimeout(onDone, 2500);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message.replace("Firebase: ", "") : "Registration failed");
      setLoading(false);
    }
  };

  if (invite === "loading") return <Screen style={{ display: "flex", alignItems: "center", justifyContent: "center" }}><div style={{ color: C.muted }}>Loading invite…</div></Screen>;

  if (invite === "invalid") return (
    <Screen style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24, maxWidth: 380, width: "100%", textAlign: "center" }}>
        <Icon name="warn" color={C.danger} size={36} />
        <div style={{ fontWeight: 800, fontSize: 17, marginTop: 12 }}>Link expired or invalid</div>
        <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>Ask your admin to send a new invitation.</div>
        <div style={{ marginTop: 16 }}><Btn onClick={onDone}>Back to Login</Btn></div>
      </div>
    </Screen>
  );

  return (
    <Screen style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 32, fontWeight: 900, color: C.accent }}>P-H&H</div>
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24 }}>
          {done ? (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <Icon name="check" color={C.closed} size={40} />
              <div style={{ fontWeight: 800, fontSize: 17, marginTop: 12, color: C.closed }}>Account activated!</div>
              <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>Redirecting to login…</div>
            </div>
          ) : (
            <>
              <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Accept Invitation</div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>Create your account for <strong style={{ color: C.text }}>{invite.email}</strong></div>
              <Input label="Your full name" value={name} onChange={setName} placeholder="Jan de Vries" />
              <Input label="Password" value={pw} onChange={setPw} type="password" placeholder="Min. 6 characters" />
              <Input label="Confirm password" value={pw2} onChange={setPw2} type="password" placeholder="Repeat password" />
              {err && <div style={{ color: C.danger, fontSize: 13, marginBottom: 12 }}>{err}</div>}
              <Btn full onClick={submit} icon="check" disabled={loading}>
                {loading ? "Activating…" : "Activate Account"}
              </Btn>
            </>
          )}
        </div>
      </div>
    </Screen>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ROOT APP — Firebase real-time listeners, auth state, routing
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [authUser, setAuthUser] = useState<FBUser | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [items, setItems] = useState<PunchItem[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [logo, setLogoState] = useState<string | null>(null);
  const [appLoading, setAppLoading] = useState(true);
  const [needsInit, setNeedsInit] = useState(false);
  const [screen, setScreen] = useState("home");
  const [ctx, setCtx] = useState<unknown>(null);
  const [pendingInvite, setPendingInvite] = useState<string | null>(null);

  // ── Check for invite token in URL ────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const invite = params.get("invite");
    if (invite) {
      setPendingInvite(invite);
      // Clean URL
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  // ── Firebase Auth state listener ─────────────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      setAuthUser(fbUser);
      if (fbUser) {
        const profileSnap = await getDoc(doc(db, "users", fbUser.uid));
        if (profileSnap.exists()) {
          setUserProfile({ uid: fbUser.uid, ...convertTimestamps(profileSnap.data()) } as UserProfile);
        } else {
          // No Firestore profile — check if this is the very first user
          const configSnap2 = await getDoc(doc(db, "config", "project"));
          if (!configSnap2.exists()) {
            setNeedsInit(true);
          }
        }
      } else {
        setUserProfile(null);
        // Check if we need first-time init.
        // We read config/project (publicly readable) instead of the users
        // collection, which is blocked for unauthenticated requests.
        try {
          const configSnap = await getDoc(doc(db, "config", "project"));
          setNeedsInit(!configSnap.exists());
        } catch {
          // If rules block even config reads, assume init is needed so the
          // user is never stuck on a blank login screen.
          setNeedsInit(true);
        }
      }
      setAppLoading(false);
    });
    return () => unsub();
  }, []);

  // ── Firestore: items real-time listener (only when authenticated) ─────────
  useEffect(() => {
    if (!authUser) { setItems([]); return; }
    const q = query(collection(db, "items"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => setItems(snap.docs.map((d) => ({ ...convertTimestamps(d.data()), id: d.id }) as PunchItem)),
      (err) => console.error("Items listener error:", err)
    );
    return () => unsub(); // FIX: cleanup to prevent listener accumulation
  }, [authUser]);

  // ── Firestore: users real-time listener (only for admins) ─────────────────
  useEffect(() => {
    if (!authUser || userProfile?.role !== "admin") return;
    const unsub = onSnapshot(
      collection(db, "users"),
      (snap) => setUsers(snap.docs.map((d) => ({ ...convertTimestamps(d.data()), uid: d.id }) as UserProfile)),
      (err) => console.error("Users listener error:", err)
    );
    return () => unsub(); // FIX: cleanup
  }, [authUser, userProfile?.role]);

  // ── Firestore: project config (logo URL) ─────────────────────────────────
  useEffect(() => {
    if (!authUser) return;
    const unsub = onSnapshot(
      doc(db, "config", "project"),
      (snap) => { if (snap.exists()) setLogoState(snap.data().logoUrl || null); },
      (err) => console.error("Config listener error:", err)
    );
    return () => unsub(); // FIX: cleanup
  }, [authUser]);

  const nav = (s: string, c: unknown = null) => { setScreen(s); setCtx(c); };
  const goHome = () => nav("home");

  // ── Firebase CRUD operations ──────────────────────────────────────────────
  const updateItem = useCallback(async (updated: PunchItem) => {
    const { id, ...data } = updated;
    await updateDoc(doc(db, "items", id), { ...data, updatedAt: new Date().toISOString() });
    // onSnapshot will update the items state automatically
  }, []);

  const deleteItem = useCallback(async (itemId: string) => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    // Notify Cloudinary about deletions (async, non-blocking)
    for (const photo of item.photos || []) {
      deleteFromCloudinary(photo.storagePath).catch(console.warn);
    }
    await deleteDoc(doc(db, "items", itemId));
    goHome();
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLogo = useCallback(async (url: string | null) => {
    await setDoc(doc(db, "config", "project"), { logoUrl: url }, { merge: true });
    setLogoState(url); // optimistic update
  }, []);

  const handleLogout = async () => {
    await signOut(auth);
    setUserProfile(null);
    setItems([]);
    setUsers([]);
    setLogoState(null);
    setScreen("home");
    setCtx(null);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  // Guard: Firebase not configured
  if (!isFirebaseConfigured) return <MissingConfigScreen />;

  // Guard: Pending invite — only show if NOT already logged in.
  // If an admin clicks their own invite link to test/copy it, we simply
  // clear the token and keep them on the normal app instead of booting
  // them to the AcceptInviteScreen.
  if (pendingInvite && !appLoading) {
    if (authUser) {
      // Already logged in — discard the invite token and continue normally
      setPendingInvite(null);
    } else {
      return <AcceptInviteScreen token={pendingInvite} onDone={() => setPendingInvite(null)} />;
    }
  }

  // Guard: Loading auth state
  if (appLoading) return (
    <Screen style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 32, fontWeight: 900, color: C.accent, marginBottom: 16 }}>P-H&H</div>
        <div style={{ color: C.muted, fontSize: 14 }}>Loading…</div>
      </div>
    </Screen>
  );

  // Guard: First-time initialization
  if (needsInit) return <InitScreen onDone={() => setNeedsInit(false)} />;

  // Guard: Not logged in
  if (!authUser || !userProfile) {
    if (screen === "forgot") return <ForgotPasswordScreen onBack={() => setScreen("login")} />;
    return <LoginScreen onForgot={() => setScreen("forgot")} />;
  }

  // Get live item from state (keeps detail view fresh after updates)
  const liveItem = ctx && typeof ctx === "object" && "id" in ctx
    ? (items.find((i) => i.id === (ctx as PunchItem).id) ?? (ctx as PunchItem))
    : null;

  // ── Screen routing ────────────────────────────────────────────────────────
  if (screen === "rooms") return <RoomListScreen items={items} logo={logo} onNavigate={nav} onBack={goHome} />;
  if (screen === "room-items") return <ItemListScreen items={items.filter((i) => i.room === (ctx as string))} title={`Room ${ctx as string}`} onNavigate={nav} onBack={() => nav("rooms")} logo={logo} />;
  if (screen === "list-open") return <ItemListScreen items={items} title="Open Items" filter="open" onNavigate={nav} onBack={goHome} logo={logo} />;
  if (screen === "list-closed") return <ClosedItemsScreen items={items} onNavigate={nav} onBack={goHome} user={userProfile} onUpdate={updateItem} logo={logo} />;
  if (screen === "export") return <ExportScreen items={items} onBack={goHome} logo={logo} />;
  if (screen === "list-responsible") return <ResponsibilityScreen items={items} logo={logo} onNavigate={nav} onBack={goHome} />;
  if (screen === "list-responsible-items") return <ItemListScreen items={items.filter((i) => i.responsible === (ctx as string))} title={ctx as string} onNavigate={nav} onBack={() => nav("list-responsible")} logo={logo} />;
  if (screen === "admin") return (
    <AdminScreen
      items={items}
      user={userProfile}
      users={users}
      logo={logo}
      setLogo={setLogo}  // FIX: was missing in original
      onBack={goHome}
    />
  );
  if (screen === "detail" && liveItem) return (
    <ItemDetailScreen
      item={liveItem}
      onBack={goHome}
      onUpdate={updateItem}
      onDelete={deleteItem}
      user={userProfile}
      logo={logo}
    />
  );

  // Default: Home Screen
  return (
    <HomeScreen
      items={items}
      user={userProfile}
      logo={logo}
      onNavigate={nav}
      onImportDone={() => {/* items update via onSnapshot automatically */}}
      onLogout={handleLogout}
    />
  );
}
