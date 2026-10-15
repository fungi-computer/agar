import * as z from "zod";

/** An opted-in App method is still working; poll again after this bounded delay. */
export const pendingSchema = z.strictObject({
  kind: z.literal("pending"),
  retryAfterMs: z.number().int().min(1000).max(60_000),
});

/** The shared polling result, owned by the App contract. */
export type Pending = Readonly<z.output<typeof pendingSchema>>;

/** Return Pending with a polling delay between one and sixty seconds. */
export function pending(retryAfterMs: number): Pending {
  return Object.freeze(pendingSchema.parse({ kind: "pending", retryAfterMs }));
}
