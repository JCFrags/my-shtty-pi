import { HARD_EXCLUDED_DIRECTORY_NAMES } from "./constants.ts";
import { normalizeRelativePath } from "./path-utils.ts";

interface CompiledRule {
  source: string;
  basePath: string;
  negative: boolean;
  directoryOnly: boolean;
  hasSlash: boolean;
  pattern: string;
  regex: RegExp;
}

function stripUnescapedTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    let backslashes = 0;
    for (let index = end - 2; index >= 0 && line[index] === "\\"; index -= 1) backslashes += 1;
    if (backslashes % 2 === 1) break;
    end -= 1;
  }
  return line.slice(0, end);
}

function unescapePattern(pattern: string): string {
  return pattern.replace(/\\([ #!\\])/g, "$1");
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globToRegexSource(pattern: string): string {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*") {
      const next = pattern[index + 1];
      if (next === "*") {
        while (pattern[index + 1] === "*") index += 1;
        const following = pattern[index + 1];
        if (following === "/") {
          output += "(?:.*/)?";
          index += 1;
        } else {
          output += ".*";
        }
      } else {
        output += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      output += "[^/]";
      continue;
    }
    if (character === "[") {
      const closing = pattern.indexOf("]", index + 1);
      if (closing !== -1) {
        let body = pattern.slice(index + 1, closing);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        else if (body.startsWith("^")) body = `\\${body}`;
        output += `[${body.replaceAll("\\", "\\\\")}]`;
        index = closing;
        continue;
      }
    }
    output += escapeRegex(character);
  }
  return output;
}

function compileRule(basePath: string, rawLine: string): CompiledRule | undefined {
  let line = stripUnescapedTrailingSpaces(rawLine.replace(/\r$/, ""));
  if (line === "" || line === "/") return undefined;
  if (line.startsWith("#")) return undefined;

  let negative = false;
  if (line.startsWith("!")) {
    negative = true;
    line = line.slice(1);
  } else if (line.startsWith("\\#") || line.startsWith("\\!")) {
    line = line.slice(1);
  }
  if (line === "") return undefined;

  const directoryOnly = line.endsWith("/") && !line.endsWith("\\/");
  if (directoryOnly) line = line.slice(0, -1);
  const anchored = line.startsWith("/");
  if (anchored) line = line.slice(1);
  line = unescapePattern(line);
  if (line === "") return undefined;

  const hasSlash = line.includes("/");
  const body = globToRegexSource(line);
  const regex = hasSlash || anchored ? new RegExp(`^${body}(?:/|$)`) : new RegExp(`(?:^|/)${body}(?:/|$)`);
  return {
    source: rawLine,
    basePath,
    negative,
    directoryOnly,
    hasSlash: hasSlash || anchored,
    pattern: line,
    regex,
  };
}

function localPathForRule(basePath: string, relativePath: string): string | undefined {
  if (basePath === "") return relativePath;
  if (relativePath === basePath) return "";
  const prefix = `${basePath}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : undefined;
}

function ruleMatches(rule: CompiledRule, relativePath: string, isDirectory: boolean): boolean {
  const localPath = localPathForRule(rule.basePath, relativePath);
  if (localPath === undefined || localPath === "") return false;
  const match = rule.regex.exec(localPath);
  if (!match) return false;
  if (!rule.directoryOnly) return true;
  const matched = match[0] ?? "";
  return matched.endsWith("/") || match.index + matched.length < localPath.length || isDirectory;
}

export class GitIgnoreRules {
  readonly rules: readonly CompiledRule[];

  constructor(rules: readonly CompiledRule[] = []) {
    this.rules = rules;
  }

  withFile(basePath: string, content: string): GitIgnoreRules {
    const normalizedBase = normalizeRelativePath(basePath);
    const appended: CompiledRule[] = [...this.rules];
    for (const line of content.split("\n")) {
      const rule = compileRule(normalizedBase, line);
      if (rule) appended.push(rule);
    }
    return new GitIgnoreRules(appended);
  }

  isIgnored(relativePath: string, isDirectory: boolean): boolean {
    const normalized = normalizeRelativePath(relativePath);
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    if (isDirectory && HARD_EXCLUDED_DIRECTORY_NAMES.has(name)) return true;

    let ignored = false;
    for (const rule of this.rules) {
      if (ruleMatches(rule, normalized, isDirectory)) ignored = !rule.negative;
    }
    return ignored;
  }

  explain(relativePath: string, isDirectory: boolean): { ignored: boolean; rule?: string } {
    const normalized = normalizeRelativePath(relativePath);
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    if (isDirectory && HARD_EXCLUDED_DIRECTORY_NAMES.has(name)) {
      return { ignored: true, rule: `<default:${name}>` };
    }
    let ignored = false;
    let source: string | undefined;
    for (const rule of this.rules) {
      if (ruleMatches(rule, normalized, isDirectory)) {
        ignored = !rule.negative;
        source = rule.source;
      }
    }
    return source === undefined ? { ignored } : { ignored, rule: source };
  }
}
