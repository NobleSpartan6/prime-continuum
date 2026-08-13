export interface ResidentDisplayRedactionContext {
  readonly exactValues: readonly Readonly<{ value: string; replacement: string }>[];
  readonly childNamesById: ReadonlyMap<string, string>;
}

/**
 * Reduce Prime Agent's displayable protocol text to the useful human result.
 * This is intentionally pure so the renderer can also clean historical
 * transcript blocks that were persisted before the host boundary added it.
 */
export function sanitizeResidentDisplayText(
  value: string,
  context?: ResidentDisplayRedactionContext,
): string {
  let sanitized = summarizeRlmSpawnHandles(value, context);
  sanitized = summarizeAgentMessage(sanitized);

  for (const exact of context?.exactValues ?? []) {
    sanitized = sanitized.replaceAll(exact.value, exact.replacement);
  }

  // Quoted paths may contain spaces. Redact them before the conservative
  // unquoted pass so a partial username or directory is never retained.
  sanitized = sanitized.replace(
    /([`'"])\/(?:Users|home|private|tmp|var\/folders|Volumes|Applications|Library|opt|usr|etc)(?:\/[^`'"\r\n]*)?\1/g,
    (_match, quote: string) => `${quote}[local path]${quote}`,
  );
  sanitized = sanitized.replace(
    /([`'"])[A-Za-z]:\\[^`'"\r\n]*\1/g,
    (_match, quote: string) => `${quote}[local path]${quote}`,
  );
  sanitized = sanitized.replace(
    /(^|[\s(=:[{])\/(?:Users|home|private|tmp|var\/folders|Volumes|Applications|Library|opt|usr|etc)(?:\/(?:Application Support|Caches|Containers|Group Containers|Saved Application State|[^\/\s,'"`)\]}]+))*/gm,
    (_match, prefix: string) => `${prefix}[local path]`,
  );
  sanitized = sanitized.replace(
    /(^|[\s(=:[{])[A-Za-z]:\\[^\s,'"`)\]}]*/gm,
    (_match, prefix: string) => `${prefix}[local path]`,
  );

  return sanitized.replace(/\n{3,}/g, "\n\n").trim();
}

function summarizeRlmSpawnHandles(
  value: string,
  context?: ResidentDisplayRedactionContext,
): string {
  return value.replace(/RLMSpawnHandle\([^\r\n]*\)/g, (handle) => {
    const agentId = /(?:rlm_child_id|child_agent_id|agent_id|child_id|id)\s*=\s*['"]([^'"]+)['"]/.exec(handle)?.[1];
    const model = /model\s*=\s*['"]([^'"]+)['"]/.exec(handle)?.[1];
    const onlyChildName = context?.childNamesById.size === 1
      ? context.childNamesById.values().next().value as string | undefined
      : undefined;
    const rawName = (agentId ? context?.childNamesById.get(agentId) : undefined) ?? onlyChildName;
    const name = rawName ? compactDisplayName(rawName) : "RLM child";
    return `Delegated to ${name}${model ? ` · ${model}` : ""}`;
  });
}

function summarizeAgentMessage(value: string): string {
  const lines = value.split(/\r?\n/);
  const isAgentMessage = lines[0]?.trim() === "agent_message" ||
    lines.some((line) => /^\[from child:[^\]]+\]$/i.test(line.trim())) ||
    lines.some((line) => line.trim() === "Agent-to-agent message received.");
  if (!isAgentMessage) return value;

  let sender: string | undefined;
  const body: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const childTag = /^\[from child:([^\]]+)\]$/i.exec(trimmed);
    if (childTag) {
      sender = childTag[1]?.trim() || sender;
      continue;
    }
    const fromMetadata = /^From:\s*([^,]+)(?:,.*)?$/i.exec(trimmed);
    if (fromMetadata) {
      sender = fromMetadata[1]?.trim() || sender;
      continue;
    }
    if (
      trimmed === "agent_message" ||
      trimmed === "Agent-to-agent message received." ||
      /^Source:/i.test(trimmed) ||
      /^To:/i.test(trimmed) ||
      /^Message id:/i.test(trimmed)
    ) {
      continue;
    }
    body.push(line);
  }

  const usefulBody = body.join("\n").trim();
  return ["Agent message", ...(sender ? [`From ${sender}`] : []), ...(usefulBody ? [usefulBody] : [])]
    .join("\n");
}

function compactDisplayName(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 255) return compact;
  return `${compact.slice(0, 254).trimEnd()}…`;
}
