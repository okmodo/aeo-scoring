// Internal input/job/cache policy; no public report contract change.
export const PREPARED_ASSESSMENT_POLICY = 'prepared-assessment-v3';

export function preparedAssessmentPolicy(provider) {
  return provider === 'granite' ? 'prepared-assessment-granite-v1' : PREPARED_ASSESSMENT_POLICY;
}

export function configuredAssessmentProvider(value) {
  if (value == null || value === '') return 'terra';
  return value === 'terra' || value === 'granite' ? value : null;
}
