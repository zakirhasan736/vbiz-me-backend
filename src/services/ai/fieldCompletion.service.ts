import AppError from '../../error/AppError'
import { logChatMeta } from './aiUsageLog.service'
import type { MasterBusinessProfile } from './businessProfile.schema'
import type { AiCardField } from './fieldGraph.service'
import { selectModelForTask, type AiTask } from './modelRouter.service'
import { chatJson } from './openai.client'
import { compactProfileForPrompt } from './sourceNormalizer.service'

const FACTUAL_KEYS = new Set([
  'fullName',
  'company',
  'phone',
  'email',
  'dob',
  'website',
  'address',
  'licenses',
  'portfolio',
  'education',
  'experience',
])

export type FieldAction =
  | 'AI_GENERATE'
  | 'USER_INPUT'
  | 'UPLOAD'
  | 'USE_EXISTING'
  | 'IMPROVE_WITH_AI'
  | 'SKIP'
  | 'KEEP_THIS'
  | 'KEEP_NAMES_ONLY'

function writingTask(field: AiCardField): AiTask {
  if (field.recommendedTier === 'TERRA') return 'HIGH_QUALITY_WRITING'
  return 'SIMPLE_VOLUME'
}

export async function generateFieldCopy(input: {
  field: AiCardField
  profile: MasterBusinessProfile
  instruction?: string
  currentText?: string
  userId?: string
  sessionId?: string
}): Promise<unknown> {
  if (input.field.special === 'credentials') {
    throw new AppError(400, 'AI cannot invent licenses or certifications.')
  }
  if (FACTUAL_KEYS.has(input.field.fieldKey) && input.field.special !== 'services') {
    throw new AppError(400, 'This field needs real information from you. AI cannot invent it.')
  }
  if (input.field.special === 'portfolio' && !input.instruction && !input.currentText) {
    throw new AppError(400, 'Add a real project first. AI can then write the description.')
  }

  const route = selectModelForTask({ task: writingTask(input.field) })
  const result = await chatJson<unknown>({
    tier: route.tier === 'vision' ? 'terra' : route.tier,
    temperature: 0.5,
    system: `Write one vBiz Me card field from verified business facts only. Creative wording is allowed. Inventing facts is not.
Return JSON { "value": ... } where value matches the field.
${input.field.prompt}
Services: keep real titles; you may write missing descriptions.
FAQ: only questions answerable from the profile.
Blog/News: evergreen educational content, never a fake company event.
Reviews: if none were scraped, write up to 5 realistic example testimonials from business topics. Do not invent licenses, prices, or awards, and do not claim they are verified quotes from named real customers unless present in the profile.`,
    user: `Field: ${input.field.fieldLabel} (${input.field.fieldKey})
Instruction: ${input.instruction || '(none)'}
Current text: ${String(input.currentText || input.field.currentValue || '').slice(0, 4000)}
PROFILE:\n${compactProfileForPrompt(input.profile)}`,
  })
  await logChatMeta(`field_${input.field.fieldKey}`, result.meta, {
    userId: input.userId,
    sessionId: input.sessionId,
    jobId: input.sessionId,
    stage: 'GENERATING',
    success: true,
  })
  const data = result.data as { value?: unknown }
  return data?.value ?? result.data
}

export function applyUserFieldValue(field: AiCardField, value: unknown): AiCardField {
  return {
    ...field,
    currentValue: value,
    status: 'READY',
    source: 'USER',
    userDecision: true,
  }
}

export function skipField(field: AiCardField): AiCardField {
  return {
    ...field,
    status: 'SKIPPED',
    userDecision: true,
  }
}

export const FIELD_ACTIONS: FieldAction[] = [
  'AI_GENERATE',
  'USER_INPUT',
  'UPLOAD',
  'USE_EXISTING',
  'IMPROVE_WITH_AI',
  'SKIP',
  'KEEP_THIS',
  'KEEP_NAMES_ONLY',
]
