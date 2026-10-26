/**
 * Human-in-the-loop tool: ask_human.
 *
 * Used when the model encounters ambiguity (e.g. multiple matching vendors),
 * missing required data, or needs supervisor clarification.
 *
 * Pauses run execution until the user answers in the dashboard or CLI.
 */

export async function askHuman({ question, options = [] }, context = {}) {
  if (!question || typeof question !== 'string' || !question.trim()) {
    return {
      ok: false,
      error: {
        type: 'INVALID_QUESTION',
        message: 'A clear question must be provided to ask_human.',
        hint: 'State exactly what is ambiguous and what information you need.'
      }
    };
  }

  // If a context handler is registered (from runtime loop, CLI, or test harness), invoke it
  if (context && typeof context.askHuman === 'function') {
    try {
      const answer = await context.askHuman(question, options);
      return {
        ok: true,
        data: {
          question,
          options,
          answer
        }
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          type: 'HUMAN_INPUT_ERROR',
          message: err.message,
          hint: 'The user interaction could not be completed.'
        }
      };
    }
  }

  // Fallback if no interactive handler is wired up
  return {
    ok: true,
    data: {
      question,
      options,
      answer: null,
      note: 'Question logged. Waiting for user response.'
    }
  };
}
