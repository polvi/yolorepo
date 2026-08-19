// §3, §5.3, §9, §10 payload schemas (zod). Schemas are deliberately liberal on
// unknown keys (passthrough) so newer runners can add fields without breaking
// older verifiers; the fields named here are the ones verification depends on.
import { z } from "zod";

const b64uRe = /^[A-Za-z0-9_-]*$/;
const hexRe = /^[0-9a-f]*$/;
const b64uOf = (bytes: number) => z.string().regex(b64uRe).length(Math.ceil((bytes * 4) / 3));
const hexOf = (bytes: number) => z.string().regex(hexRe).length(bytes * 2);

export const SignedBlobSchema = z.object({
  payload: z.string().regex(b64uRe),
  sig: z.string().regex(b64uRe),
  kid: z.string().optional(),
}).passthrough();

export const SimulatedReportSchema = z.object({
  report_data: hexOf(64),
  gpu_nonce: hexOf(32),
  measurement: hexOf(48),
  hwmodel: z.string(),
  issued_at: z.number().int(),
}).passthrough();
export type SimulatedReport = z.infer<typeof SimulatedReportSchema>;

export const AttestationDocSchema = z.object({
  v: z.literal(1),
  runner_version: z.string().min(1),
  hpke_pub: b64uOf(32),
  sign_pub: b64uOf(32),
  boot_nonce: b64uOf(32),
  binding: hexOf(32),
  challenge: hexOf(32),
  issued_at: z.number().int(),
  model: z.object({ id: z.string(), digest: hexOf(32), ctx_len: z.number().int().nonnegative().optional() }).passthrough(),
  platform: z.object({
    kind: z.enum(["snp", "simulated"]),
    cpu: z.string().optional(),
    gpu_model: z.string().optional(),
    cc_mode: z.enum(["on", "devtools", "off", "simulated"]).optional(),
  }).passthrough(),
  snp: z.object({ report: z.string().regex(b64uRe), vcek_chain: z.array(z.string()).min(1) }).passthrough().nullable().optional(),
  gpu: z.object({ overall: z.string(), devices: z.record(z.string(), z.string()) }).passthrough().nullable().optional(),
  simulated: SignedBlobSchema.nullable().optional(),
}).passthrough();
export type AttestationDoc = z.infer<typeof AttestationDocSchema>;

export const PriceSchema = z.object({ in_per_m: z.number().int().nonnegative(), out_per_m: z.number().int().nonnegative() }).passthrough();
export type Price = z.infer<typeof PriceSchema>;

export const OfferSchema = z.object({
  session_id: b64uOf(16),
  subaddress: z.string().min(1),
  price: PriceSchema,
  hpke_pub: b64uOf(32),
  created_at: z.number().int(),
  expires_at: z.number().int(),
}).passthrough();
export type Offer = z.infer<typeof OfferSchema>;

export const ReceiptSchema = z.object({
  session_id: b64uOf(16),
  seq: z.number().int().nonnegative(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  debit_piconero: z.number().int().nonnegative(),
  cumulative_debit_piconero: z.number().int().nonnegative(),
  balance_piconero: z.number().int(), // may go negative after a reorg (§6)
  ts: z.number().int(),
}).passthrough();
export type Receipt = z.infer<typeof ReceiptSchema>;

export const GoldenEntrySchema = z.object({
  runner_version: z.string().min(1),
  measurement: hexOf(48),
  verity_root: hexOf(32).optional(),
  simulated: z.boolean().default(false),
  note: z.string().optional(),
}).passthrough();
export type GoldenEntry = z.infer<typeof GoldenEntrySchema>;

export const GoldenSetSchema = z.object({
  v: z.literal(1),
  issued_at: z.number().int(),
  entries: z.array(GoldenEntrySchema),
}).passthrough();
export type GoldenSet = z.infer<typeof GoldenSetSchema>;

export const ModelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  digest: hexOf(32),
  license: z.string().optional(),
  note: z.string().optional(),
}).passthrough();
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

export const ModelCatalogSchema = z.object({
  v: z.literal(1),
  issued_at: z.number().int(),
  /** Only models with known weight digests belong here. */
  entries: z.array(ModelCatalogEntrySchema),
  /** When true, simulated docs may carry any model digest (there is no real weight hashing to pin). */
  simulated_any: z.boolean().default(false),
}).passthrough();
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

/** GET /.well-known/gpubnb/info (unsigned public listing info). */
export const ListingInfoSchema = z.object({
  listing: z.string().optional(),
  price: PriceSchema.optional(),
  model: z.object({ id: z.string(), digest: hexOf(32).optional(), ctx_len: z.number().int().optional() }).passthrough().optional(),
  runner_version: z.string().optional(),
  sign_pub: b64uOf(32).optional(),
  hpke_pub: b64uOf(32).optional(),
}).passthrough();
export type ListingInfo = z.infer<typeof ListingInfoSchema>;

/** Plaintext of a session-open request. */
export const OpenRequestSchema = z.object({ client_nonce: b64uOf(32) }).passthrough();
export type OpenRequest = z.infer<typeof OpenRequestSchema>;
