import { z } from 'zod'

export const VERIFY_CONFIG_FILENAME = 'elodrome.verify.json'

export const verifyConfigSchema = z.record(z.string().min(1), z.string().min(1))
export type VerifyConfig = z.infer<typeof verifyConfigSchema>

export function parseVerifyConfig(raw: string): VerifyConfig {
  return verifyConfigSchema.parse(JSON.parse(raw))
}
