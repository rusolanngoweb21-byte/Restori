import { z } from "zod";

export const detectorSchema = z.enum([
  "image-ai",
  "deepfake",
  "text-ai",
  "url-signature",
]);
export type Detector = z.infer<typeof detectorSchema>;
export const capabilitySchema = z
  .object({
    detector: detectorSchema,
    version: z.string().regex(/^[a-f0-9]{64}$/),
    languages: z.array(z.enum(["ru", "en"])).max(2),
  })
  .strict();
export type Capability = z.infer<typeof capabilitySchema>;

/** confidence is the model's AI-class score in percent, NOT proven accuracy. */
export const detectionSchema = z
  .object({
    isAI: z.boolean(),
    confidence: z.number().finite().min(0).max(100),
    details: z.string().min(1).max(2000),
    modality: z.enum(["image", "text"]),
  })
  .strict();
export type DetectionResult = z.infer<typeof detectionSchema>;
export const outcomeSchema = z.union([
  z
    .object({
      status: z.literal("completed"),
      result: detectionSchema,
      scoreKind: z.literal("uncalibrated_model_score"),
    })
    .strict(),
  z
    .object({
      status: z.literal("completed"),
      signature: z
        .object({
          status: z.enum(["clean", "malicious"]),
          signature: z.string().max(200).nullable(),
          engine: z.string().min(1).max(200),
          bytes: z.number().int().min(0).max(8388608),
          finalUrlHash: z.string().regex(/^[a-f0-9]{64}$/),
          redirectCount: z.number().int().min(0).max(3),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      status: z.enum(["inconclusive", "unavailable", "failed"]),
      code: z.string().regex(/^[A-Z_]{2,60}$/),
      details: z.string().min(1).max(2000),
    })
    .strict(),
]);
export type Outcome = z.infer<typeof outcomeSchema>;
export type JobView = {
  id: string;
  detector: Detector;
  version: string;
  state: "queued" | "running" | "finished";
  createdAt: number;
  expiresAt: number;
  cached: boolean;
  outcome: Outcome | null;
};
export const mediaInputSchema = z.discriminatedUnion("detector", [
  z
    .object({
      detector: z.literal("text-ai"),
      text: z.string().min(1).max(12000),
      language: z.enum(["ru", "en"]),
    })
    .strict(),
  z
    .object({
      detector: z.literal("image-ai"),
      imageBase64: z.string().min(1).max(2796204),
    })
    .strict(),
  z
    .object({
      detector: z.literal("deepfake"),
      imageBase64: z.string().min(1).max(2796204),
    })
    .strict(),
]);
export type MediaInput = z.infer<typeof mediaInputSchema>;
export type JobInput = MediaInput | { detector: "url-signature"; url: string };
export type ThreatCheck = {
  source: string;
  status: "clear" | "malicious" | "unavailable";
  detail: string;
};
export type ThreatResult = {
  status: "blocked" | "hold" | "clear";
  reason: string;
  checkedAt: string;
  checks: ThreatCheck[];
  /** No caller-supplied decision can authorize an outbound redirect. */
  navigationAllowed: boolean;
  signatureJob?: JobView;
};
