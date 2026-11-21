import config from '../config/ai-model.json' with { type: 'json' };

const endpoint = 'https://api.cloudflare.com/client/v4/accounts/495d788b994070692b54c46945a5e577/ai/run';
const fields = ['endpoint','model','gatewayId','apiFormat','reasoningEffort','responseFormat','stream','timeoutMs','requestMaxBytes','outputMaxBytes'];
const keysMatch = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const bounded = (value,max) => Number.isSafeInteger(value) && value > 0 && value <= max;
export function validateAiModelConfig(value) {
  if (!keysMatch(value,fields) || value.endpoint !== endpoint || typeof value.model !== 'string' || !/^openai\/[a-z0-9][a-z0-9._-]{0,100}$/.test(value.model) ||
      value.gatewayId !== 'openai' || value.apiFormat !== 'responses' || value.reasoningEffort !== 'low' || value.responseFormat !== 'json_object' || value.stream !== false || !bounded(value.timeoutMs,30000) ||
      !bounded(value.requestMaxBytes,61440) || !bounded(value.outputMaxBytes,65536)) throw new Error('invalid_model_config');
  return value;
}
validateAiModelConfig(config);
export const AI_MODEL_CONFIG = Object.freeze(config);
