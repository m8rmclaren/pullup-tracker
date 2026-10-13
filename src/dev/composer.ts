import type { ComposedSet } from '../shared/compose';
import type { Composer } from '../lambda/compose';

// Stands in for the model on the dev server, so the Describe flow can be tried offline. It
// reads only "4x8 pull-ups", "20 push-ups" and "45s plank", split on commas, "then" and "and".
export const patternComposer: Composer = {
  async compose(input) {
    const sets: ComposedSet[] = [];
    for (const part of input.text.split(/,|\bthen\b|\band\b/i)) {
      const clause = part.trim();
      const hold = /^(\d+)\s*(?:s|sec|secs|seconds?)\s+(.+)$/i.exec(clause);
      const repeated = /^(\d+)\s*x\s*(\d+)\s+(.+)$/i.exec(clause);
      const single = /^(\d+)\s+(.+)$/.exec(clause);
      if (hold) sets.push({ exercise: hold[2]!, variations: [], holdSeconds: Number(hold[1]), repeat: 1, minutesAgo: 0 });
      else if (repeated) sets.push({ exercise: repeated[3]!, variations: [], reps: Number(repeated[2]), repeat: Math.min(50, Number(repeated[1])), minutesAgo: 0 });
      else if (single) sets.push({ exercise: single[2]!, variations: [], reps: Number(single[1]), repeat: 1, minutesAgo: 0 });
    }
    return { draft: { sets, newExercises: [] }, inputTokens: 0, outputTokens: 0 };
  },
};
