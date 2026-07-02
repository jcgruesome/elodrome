import { z } from 'zod'

export const capabilityTagSchema = z.enum([
  'code-gen', 'deep-reasoning', 'long-context', 'review', 'research', 'fast',
])
export type CapabilityTag = z.infer<typeof capabilityTagSchema>

export const outcomesSchema = z.object({
  accepted: z.number().int().min(0),
  reworked: z.number().int().min(0),
  rejected: z.number().int().min(0),
})

export const modelEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tags: z.array(capabilityTagSchema).min(1),
  contextWindow: z.number().int().positive(),
  toolCalling: z.enum(['reliable', 'unreliable', 'none']),
  evalScore: z.number().min(0).max(1).optional(),
  outcomes: outcomesSchema.default({ accepted: 0, reworked: 0, rejected: 0 }),
})
export type ModelEntry = z.infer<typeof modelEntrySchema>

export const registrySchema = z.object({
  version: z.literal(1),
  models: z.array(modelEntrySchema).min(1),
})
export type Registry = z.infer<typeof registrySchema>
