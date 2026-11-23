// Internal input/job/cache policy; no public report contract change.
export const PREPARED_ASSESSMENT_POLICY = 'prepared-assessment-v3';

export function keyedGraniteEnabled(env) {
  return env.AUDIT_QUEUE_MODE === 'enabled' && env.AUDIT_AI_PROVIDER === 'granite' && env.AUDIT_GRANITE_KEYED === 'enabled';
}

export function preparedAssessmentPolicy(provider, keyed = false) {
  if (provider === 'granite' && keyed) return 'prepared-assessment-granite-keyed-v1';
  return provider === 'granite' ? 'prepared-assessment-granite-v2' : PREPARED_ASSESSMENT_POLICY;
}

export function configuredAssessmentProvider(value) {
  if (value == null || value === '') return 'terra';
  return value === 'terra' || value === 'granite' ? value : null;
}
