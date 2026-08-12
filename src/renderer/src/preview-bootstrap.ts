export const INTERNAL_VISUAL_QA_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 PrimeContinuimVisualQA/1'

export function isInternalVisualQaRequest(input: {
  protocol: string
  hostname: string
  userAgent: string
  search: string
}): boolean {
  return input.protocol === 'http:' &&
    input.hostname === '127.0.0.1' &&
    input.userAgent === INTERNAL_VISUAL_QA_USER_AGENT &&
    new URLSearchParams(input.search).has('visualState')
}
