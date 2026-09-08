export type MemoryAdmissionComponent =
  | "pendingLoad"
  | "pendingBuild"
  | "liveIndex"
  | "queryResults"
  | "retainedReferences";

export type MemoryAdmissionRequest = Readonly<Partial<Record<MemoryAdmissionComponent, number>>>;

export interface MemoryAdmissionStatus {
  readonly byteLimit: number;
  readonly totalBytes: number;
  readonly reservations: number;
  readonly components: Readonly<Record<MemoryAdmissionComponent, number>>;
}

const COMPONENTS: readonly MemoryAdmissionComponent[] = [
  "pendingLoad",
  "pendingBuild",
  "liveIndex",
  "queryResults",
  "retainedReferences",
];

function emptyComponents(): Record<MemoryAdmissionComponent, number> {
  return { pendingLoad: 0, pendingBuild: 0, liveIndex: 0, queryResults: 0, retainedReferences: 0 };
}

function normalize(request: MemoryAdmissionRequest): Record<MemoryAdmissionComponent, number> {
  const normalized = emptyComponents();
  for (const component of COMPONENTS) {
    const value = request[component] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid-memory-admission-request");
    normalized[component] = value;
  }
  if (COMPONENTS.every((component) => normalized[component] === 0)) throw new Error("invalid-memory-admission-request");
  return normalized;
}

function total(request: Readonly<Record<MemoryAdmissionComponent, number>>): number {
  return COMPONENTS.reduce((sum, component) => sum + request[component], 0);
}

export class MemoryAdmissionController {
  readonly #byteLimit: number;
  readonly #components = emptyComponents();
  readonly #reservations = new Set<MemoryReservation>();

  constructor(byteLimit: number) {
    if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0) throw new Error("invalid-memory-admission-limit");
    this.#byteLimit = byteLimit;
  }

  reserve(request: MemoryAdmissionRequest): MemoryReservation | undefined {
    const normalized = normalize(request);
    if (this.status().totalBytes + total(normalized) > this.#byteLimit) return undefined;
    const reservation = new MemoryReservation(this, normalized);
    this.#reservations.add(reservation);
    this.#add(normalized, 1);
    return reservation;
  }

  status(): MemoryAdmissionStatus {
    const components = { ...this.#components };
    return Object.freeze({
      byteLimit: this.#byteLimit,
      totalBytes: total(components),
      reservations: this.#reservations.size,
      components: Object.freeze(components),
    });
  }

  move(reservation: MemoryReservation, request: MemoryAdmissionRequest): boolean {
    if (!this.#reservations.has(reservation)) throw new Error("memory-reservation-released");
    const normalized = normalize(request);
    const prior = reservation.current();
    if (this.status().totalBytes - total(prior) + total(normalized) > this.#byteLimit) return false;
    this.#add(prior, -1);
    this.#add(normalized, 1);
    reservation.replace(normalized);
    return true;
  }

  release(reservation: MemoryReservation): void {
    if (!this.#reservations.delete(reservation)) return;
    this.#add(reservation.current(), -1);
    reservation.markReleased();
  }

  #add(request: Readonly<Record<MemoryAdmissionComponent, number>>, direction: 1 | -1): void {
    for (const component of COMPONENTS) this.#components[component] += request[component] * direction;
  }
}

export class MemoryReservation {
  readonly #controller: MemoryAdmissionController;
  #request: Record<MemoryAdmissionComponent, number>;
  #released = false;

  constructor(controller: MemoryAdmissionController, request: Record<MemoryAdmissionComponent, number>) {
    this.#controller = controller;
    this.#request = request;
  }

  move(request: MemoryAdmissionRequest): boolean {
    return this.#controller.move(this, request);
  }

  release(): void {
    this.#controller.release(this);
  }

  current(): Readonly<Record<MemoryAdmissionComponent, number>> {
    return this.#request;
  }

  replace(request: Record<MemoryAdmissionComponent, number>): void {
    this.#request = request;
  }

  markReleased(): void {
    this.#released = true;
  }

  get released(): boolean {
    return this.#released;
  }
}
