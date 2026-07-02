import { z } from 'zod'

export const changeSchema = z.object({
  path: z.string().min(1),
  type: z.enum(['full', 'diff']),
  content: z.string(),
})
export type Change = z.infer<typeof changeSchema>

export const workerResultSchema = z.object({
  summary: z.string().min(1),
  rationale: z.string().min(1),
  changes: z.array(changeSchema),
})
export type WorkerResult = z.infer<typeof workerResultSchema>
