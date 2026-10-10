import { X509Certificate } from "node:crypto";
import type { Certificate, WebContents } from "electron";
import type { BrowserDialogs, DialogResponse } from "./dialogs";

export interface CertificateIdentity { origin: string; fingerprint: string }
export interface CertificateFailure {
  origin: string | null;
  fingerprint: string | null;
  error: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validUntil: string;
  mainFrame: boolean;
}
export type CertificateRequest =
  | { action: "status" }
  | { action: "approve" | "reject"; dialogId: string; origin: string; fingerprint: string }
  | { action: "revoke"; origin: string; fingerprint: string };

export function certificateOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

export function parseCertificateRequest(action: unknown, dialogId: unknown, origin: unknown, fingerprint: unknown): CertificateRequest {
  if (action === "status") {
    if (dialogId !== undefined || origin !== undefined || fingerprint !== undefined) throw new Error("certificate status takes no decision or identity");
    return { action };
  }
  if (action !== "approve" && action !== "reject" && action !== "revoke") throw new Error("certificate action must be status, approve, reject, or revoke");
  if (typeof origin !== "string" || origin.length > 2048 || certificateOrigin(origin) !== origin) throw new Error("certificate requires an exact HTTPS origin, without a path");
  if (typeof fingerprint !== "string" || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(fingerprint)) throw new Error("certificate requires the exact SHA-256 fingerprint");
  if (action === "revoke") {
    if (dialogId !== undefined) throw new Error("certificate revoke takes no dialog id");
    return { action, origin, fingerprint };
  }
  if (typeof dialogId !== "string" || !dialogId || dialogId.length > 128) throw new Error("certificate decision requires a dialog id");
  return { action, dialogId, origin, fingerprint };
}

export function describeCertificate(url: string, error: string, certificate: Certificate, mainFrame: boolean): CertificateFailure {
  let fingerprint: string | null = null;
  // Hash the actual DER certificate. Do not rely on Electron's unspecified fingerprint algorithm.
  try { fingerprint = new X509Certificate(certificate.data).fingerprint256; } catch {}
  const date = (seconds: number) => Number.isFinite(seconds) && Math.abs(seconds) < 8.64e12 ? new Date(seconds * 1000).toISOString() : "unknown";
  return { origin: certificateOrigin(url), fingerprint, error: error.slice(0, 256),
    subject: certificate.subjectName.slice(0, 256), issuer: certificate.issuerName.slice(0, 256),
    validFrom: date(certificate.validStart), validUntil: date(certificate.validExpiry), mainFrame };
}

/** Decisions belong to one WebContents, not the shared Chromium profile or trust store. */
export class BrowserCertificates {
  private readonly exceptions = new Map<string, CertificateIdentity>();
  private lastFailure: CertificateFailure | null = null;
  private disposed = false;

  constructor(private readonly contents: WebContents, private readonly dialogs: BrowserDialogs) {
    contents.on("certificate-error", this.onCertificateError);
    contents.once("destroyed", () => this.dispose());
  }

  status() {
    return { scope: "context-lifetime" as const, lastFailure: this.lastFailure,
      pending: this.dialogs.pending?.type === "certificate" ? this.dialogs.pending : null,
      exceptions: [...this.exceptions.values()].map(value => ({ ...value })) };
  }

  async decide(request: Extract<CertificateRequest, { action: "approve" | "reject" }>, epoch: number, signal?: AbortSignal) {
    const pending = this.dialogs.pending;
    if (!pending || pending.type !== "certificate" || pending.id !== request.dialogId ||
        pending.certificate?.origin !== request.origin || pending.certificate.fingerprint !== request.fingerprint) throw new Error("stale or mismatched certificate decision");
    const response: DialogResponse = { dialogId: request.dialogId, expectedControlEpoch: epoch,
      accept: request.action === "approve", certificate: { origin: request.origin, fingerprint: request.fingerprint }, signal };
    await this.dialogs.respond(response);
    return this.status();
  }

  revoke(identity: CertificateIdentity) {
    if (!this.exceptions.delete(this.key(identity))) throw new Error("no matching certificate exception in this context");
    return this.status();
  }

  revokeAll() { this.exceptions.clear(); return this.status(); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.exceptions.clear();
    this.contents.off("certificate-error", this.onCertificateError);
  }

  private key(identity: CertificateIdentity) { return identity.origin + "\n" + identity.fingerprint; }

  private readonly onCertificateError = (event: Electron.Event, url: string, error: string, certificate: Certificate,
    callback: (trusted: boolean) => void, mainFrame: boolean) => {
    // Hold only this request. No hostname-only verify proc, cached profile exception, or global bypass.
    event.preventDefault();
    if (this.disposed) { callback(false); return; }
    const failure = describeCertificate(url, error, certificate, mainFrame);
    const identity = failure.origin && failure.fingerprint ? { origin: failure.origin, fingerprint: failure.fingerprint } : null;
    if (identity && this.exceptions.has(this.key(identity))) { callback(true); return; }
    this.lastFailure = failure;
    this.dialogs.openCertificate(failure, async accept => {
      if (accept && identity && mainFrame && !this.disposed) {
        if (this.exceptions.size >= 16) { callback(false); throw new Error("certificate exception limit reached; remove an exception first"); }
        this.exceptions.set(this.key(identity), identity);
        callback(true);
      } else callback(false);
    });
  };
}
