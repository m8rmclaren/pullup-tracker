import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import type Anthropic from '@anthropic-ai/sdk';
import { MAX_MINUTES_AGO, MAX_REPEAT } from '../shared/compose';
import type { Composer, ComposerInput, ComposerOutput } from './compose';

// Claude in Amazon Bedrock (the Messages API at bedrock-mantle.<region>.api.aws) doesn't offer
// structured outputs, so the model answers by calling one tool whose input is the draft. The
// server validates that input (isValidDraft) whatever the model sends.

const DRAFT_TOOL: Anthropic.Tool = {
  name: 'record_draft',
  description: 'Records the sets the person describes, in order, as a draft they will check before anything is logged.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['sets', 'newExercises'],
    properties: {
      sets: {
        type: 'array',
        description: 'One line per distinct set, in the order done. Identical sets in a row are one line with repeat.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['exercise', 'variations', 'repeat', 'minutesAgo'],
          properties: {
            exercise: { type: 'string', description: 'A known exercise name exactly as listed, or the name of a new exercise.' },
            variations: { type: 'array', items: { type: 'string' }, description: 'Configuration words: grip, tempo, progression, assistance, or anything the person names ("into tuck").' },
            reps: { type: 'integer', minimum: 1, description: "The count in the exercise's unit (reps, laps, flights). Omit for a hold." },
            holdSeconds: { type: 'integer', minimum: 1, description: 'Seconds, for a timed exercise. Omit for a counted one.' },
            addedWeightLbs: { type: 'number', minimum: 0, description: 'Added weight in pounds, when the person says so.' },
            repeat: { type: 'integer', minimum: 1, maximum: MAX_REPEAT },
            minutesAgo: { type: 'integer', minimum: 0, maximum: MAX_MINUTES_AGO, description: 'Minutes before the local time given. 0 unless the person says when.' },
          },
        },
      },
      newExercises: {
        type: 'array',
        description: 'Exercises in sets that are not among the known ones.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'measure'],
          properties: {
            name: { type: 'string', description: 'Short, in the words the person used, title case ("Red Rocks stairs").' },
            measure: { type: 'string', enum: ['count', 'time'] },
            unit: { type: 'string', description: 'For a counted exercise, the singular unit of one count: rep, lap, flight, step. Omit for a timed one.' },
            description: { type: 'string', description: 'One short sentence on what one count is, from what the person said.' },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You turn what someone says they did in a workout into a draft of sets, by calling record_draft once. They check and edit the draft before anything is saved, so draft what they most likely mean.

Rules:
- Use a known exercise's name exactly as listed whenever it is what they mean ("chins" is "Chin-up", "push ups" is "Push-up"). Only name a new exercise when none of the known ones fits, and then also describe it in newExercises.
- Counted exercises take reps, in their own unit (a lap, a flight); timed ones (holds, hangs, levers, planks) take holdSeconds. Never both.
- "3x10" or "3 sets of 10" is one line with repeat 3 and reps 10. "3 laps, 20 push-ups at the top each time" alternates: lap, push-ups, lap, push-ups, lap, push-ups, so write the alternation out as separate lines.
- Configuration goes in variations as short names: "Wide grip", "Negative", "Tuck", "Band", or the person's own words.
- minutesAgo is 0 unless they say when, and then counts back from the local time given ("yesterday evening" at 18:00 local is about 1440).
- If the text describes no exercise at all, call record_draft with empty lists.

Examples, with known exercises Pull-up, Push-up, Front lever:
"4x8 wide pull-ups" → sets [{exercise "Pull-up", variations ["Wide grip"], reps 8, repeat 4, minutesAgo 0}], newExercises [].
"45 second tuck front lever then 20 pushups" → sets [{exercise "Front lever", variations ["Tuck"], holdSeconds 45, repeat 1, minutesAgo 0}, {exercise "Push-up", variations [], reps 20, repeat 1, minutesAgo 0}], newExercises [].
"ran the stadium stairs twice this morning" at 10:00 → sets [{exercise "Stadium stairs", variations [], reps 2, repeat 1, minutesAgo 120}], newExercises [{name "Stadium stairs", measure "count", unit "lap", description "A run of the stadium stairs, bottom to top"}].`;

export interface BedrockComposerConfig {
  region: string;
  /** e.g. anthropic.claude-haiku-5-5 */
  modelId: string;
}

export function bedrockComposer(config: BedrockComposerConfig): Composer {
  // The credentials come from the Lambda role. Retries are off: the request already has a 5s budget.
  const client = new AnthropicBedrockMantle({ awsRegion: config.region, maxRetries: 0 });
  return {
    async compose(input: ComposerInput, signal: AbortSignal): Promise<ComposerOutput> {
      const message = await client.messages.create(
        {
          model: config.modelId,
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          tools: [DRAFT_TOOL],
          tool_choice: { type: 'auto' },
          output_config: { effort: 'low' },
          messages: [{ role: 'user', content: `Local time: ${input.localTime}\nKnown exercises: ${input.exerciseNames.join('; ')}\n\nWhat I did:\n${input.text}` }],
        },
        { signal },
      );
      const toolUse = message.stop_reason === 'refusal' ? undefined : message.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === DRAFT_TOOL.name);
      return { draft: toolUse?.input ?? null, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
    },
  };
}
