import type { Receipt, SignedBlob } from "@gpubnb/protocol";

export class GpubnbError extends Error {
  constructor(message: string, public readonly code: string, public readonly extra: Record<string, unknown> = {}) { super(message); this.name = "GpubnbError"; }
}
/** Non-200 from the runner (409 replay, 404 unknown session, 400 decrypt failure, ...). */
export class GpubnbHttpError extends GpubnbError {
  constructor(public readonly status: number, body: string, code = "http") { super(`runner HTTP ${status}: ${body.slice(0, 200)}`, code, { body }); this.name = "GpubnbHttpError"; }
}
/** The runner refused the request inside the sealed stream (payment_required, upstream, bad_request, busy). */
export class RunnerError extends GpubnbError {
  constructor(code: string, message: string, public readonly receipt?: Receipt, public readonly receiptBlob?: SignedBlob) { super(message, code); this.name = "RunnerError"; }
}
/** Attestation verdict was not acceptable. */
export class NotVerifiedError extends GpubnbError {
  constructor(message: string, public readonly verdict: import("@gpubnb/protocol").Verdict) { super(message, "not_verified"); this.name = "NotVerifiedError"; }
}
