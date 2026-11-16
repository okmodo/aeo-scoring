// Only the provider response's root usage is evidence; model-generated text is not.
export function providerNeurons(output, inputRate, outputRate) {
  if (!Number.isSafeInteger(inputRate) || inputRate <= 0 || !Number.isSafeInteger(outputRate) || outputRate <= 0) return null;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  if (output.choices !== undefined && (!Array.isArray(output.choices) || output.choices.length !== 1 || !['stop', 'length'].includes(output.choices[0]?.finish_reason))) return null;
  const usage = output.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const prompt = usage.prompt_tokens, completion = usage.completion_tokens;
  if (!Number.isSafeInteger(prompt) || prompt < 1 || !Number.isSafeInteger(completion) || completion < 1) return null;
  if (usage.neurons !== undefined) {
    if (!Number.isFinite(usage.neurons) || usage.neurons < 0) return null;
    const estimate = Math.ceil((prompt * inputRate + completion * outputRate) / 1_000_000);
    const neurons = Math.max(Math.ceil(usage.neurons), estimate);
    return Number.isSafeInteger(neurons) ? neurons : null;
  }
  const neurons = Math.ceil((prompt * inputRate + completion * outputRate) / 1_000_000);
  return Number.isSafeInteger(neurons) ? neurons : null;
}
