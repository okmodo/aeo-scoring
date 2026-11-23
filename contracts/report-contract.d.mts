export type TestCopy = { name: string; description: string; improve: string; fullCredit: string; group?: string; type?: 'Structural' | 'Data' };
export const SUPPORTED_RUBRIC_VERSIONS: readonly string[];
export function getTestCopy(version: string, id: string): TestCopy | null;
export function validateReport(report: unknown): { valid: boolean; errors: string[] };
export function serializeReport<T>(report: T): T;
export function availablePointsForCheck(report: unknown, id: string): number | null;
