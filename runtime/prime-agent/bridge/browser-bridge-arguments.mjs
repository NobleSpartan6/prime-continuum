const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function browserCommandIndex(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--session" || argument === "-s") {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return index;
  }
  return -1;
}

export function firstBrowserCommand(args) {
  const index = browserCommandIndex(args);
  return index === -1 ? undefined : args[index];
}

export function rewriteBrowserCommand(args, command) {
  const index = browserCommandIndex(args);
  if (index === -1) return [...args, command];
  return args.map((argument, argumentIndex) => argumentIndex === index ? command : argument);
}

export function rewriteBrowserSessionName(args, sessionName) {
  const rewritten = [];
  let found = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--session" || argument === "-s") {
      rewritten.push(argument, sessionName);
      index += 1;
      found = true;
    } else if (argument.startsWith("--session=")) {
      rewritten.push(`--session=${sessionName}`);
      found = true;
    } else if (argument.startsWith("-s=")) {
      rewritten.push(`-s=${sessionName}`);
      found = true;
    } else {
      rewritten.push(argument);
    }
  }
  return found ? rewritten : [`--session=${sessionName}`, ...rewritten];
}

export function parseBrowserSessionName(args, environment = {}) {
  let candidate;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--session" || argument === "-s") candidate = args[index + 1];
    else if (argument.startsWith("--session=")) candidate = argument.slice("--session=".length);
    else if (argument.startsWith("-s=")) candidate = argument.slice(3);
  }
  const session = candidate ?? environment.PLAYWRIGHT_CLI_SESSION ?? "default";
  if (!SESSION_PATTERN.test(session)) throw new Error("Browser session names must be simple bounded identifiers.");
  return session;
}
