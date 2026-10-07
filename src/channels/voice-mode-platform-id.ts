export function platformMessageId(scopedId: string, agentGroupId: string): string {
  const suffix = `:${agentGroupId}`;
  return scopedId.endsWith(suffix) ? scopedId.slice(0, -suffix.length) : scopedId;
}
