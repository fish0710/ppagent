export interface CustomSmokeEnvironment {
  baseUrl: string;
  apiKey?: string;
}

export function readCustomSmokeEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): CustomSmokeEnvironment {
  const baseUrl = env['PPAGENT_CUSTOM_BASE_URL']?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error(
      'PPAGENT_CUSTOM_BASE_URL is required for the custom smoke test',
    );
  }

  const apiKey = env['PPAGENT_CUSTOM_API_KEY']?.trim();
  return {
    baseUrl,
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
  };
}
