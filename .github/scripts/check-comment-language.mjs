#!/usr/bin/env node
/**
 * Fails on a Hangul character inside a comment in a plugin's TypeScript.
 *
 * Every comment in these plugins is English, the language of the upstream they track, and a
 * reviewer reads a comment against the code beside it. Agents working this fork are told to write
 * to their human in Korean, and that instruction leaks into code: PR #24 replaced an English comment
 * in `firstmate/server/watches.test.ts` with four Korean ones, and only a reviewer's judgement
 * caught it. This makes it mechanical.
 *
 * Only comments are read. String literals, template literals, regular expressions and JSX text are
 * code — a Korean label a user sees is not this check's business. The scanner is a small lexer, not
 * a parser, and JSX is where it guesses wrong, both ways. A `//` inside JSX text (a bare URL between
 * tags) reads as a comment: put such text in a string literal. And the rest of a line is skipped
 * after an apostrophe in JSX text (`<Text>it's</Text>`, read as a string) or a closing tag
 * (`</b>`, read as a regular expression), so a comment later on that same line is missed.
 *
 * Run as `node .github/scripts/check-comment-language.mjs <plugin-dir>...` from the repository
 * root. No dependencies. It reads the two entries and every `.ts`/`.tsx` under `client/`, `server/`
 * and `shared/`, tests included.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힯ힰ-퟿]/;

/** Keywords after which a `/` starts a regular expression rather than dividing. */
const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do",
  "else", "yield", "await",
]);

/** Every comment in `source` as `{ start, text }`. */
function comments(source) {
  const found = [];
  let i = 0;
  // What came last, for telling a regular expression from a division: "value" or "operator".
  let last = "operator";

  const readString = (quote) => {
    i += 1;
    while (i < source.length && source[i] !== quote && source[i] !== "\n") {
      i += source[i] === "\\" ? 2 : 1;
    }
    i += 1;
  };

  const readRegex = () => {
    i += 1;
    let inClass = false;
    while (i < source.length && source[i] !== "\n") {
      const c = source[i];
      if (c === "\\") i += 2;
      else if (c === "[") (inClass = true), (i += 1);
      else if (c === "]") (inClass = false), (i += 1);
      else if (c === "/" && !inClass) break;
      else i += 1;
    }
    i += 1;
    while (i < source.length && /[a-z]/i.test(source[i])) i += 1;
  };

  // Reads code until an unmatched `}` (when inside a template substitution) or the end.
  const readCode = (inSubstitution) => {
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      const next = source[i + 1];
      if (c === "/" && next === "/") {
        const end = source.indexOf("\n", i);
        const stop = end === -1 ? source.length : end;
        found.push({ start: i, text: source.slice(i, stop) });
        i = stop;
      } else if (c === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        const stop = end === -1 ? source.length : end + 2;
        found.push({ start: i, text: source.slice(i, stop) });
        i = stop;
      } else if (c === "'" || c === '"') {
        readString(c);
        last = "value";
      } else if (c === "`") {
        readTemplate();
        last = "value";
      } else if (c === "/") {
        if (last === "operator") {
          readRegex();
          last = "value";
        } else {
          i += 1;
          last = "operator";
        }
      } else if (/[A-Za-z0-9_$]/.test(c)) {
        const start = i;
        while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i += 1;
        last = REGEX_AFTER_WORD.has(source.slice(start, i)) ? "operator" : "value";
      } else if (/\s/.test(c)) {
        i += 1;
      } else {
        if (c === "{") depth += 1;
        if (c === "}") {
          if (inSubstitution && depth === 0) {
            i += 1;
            return;
          }
          depth -= 1;
        }
        last = c === ")" || c === "]" || c === "}" ? "value" : "operator";
        i += 1;
      }
    }
  };

  const readTemplate = () => {
    i += 1;
    while (i < source.length && source[i] !== "`") {
      if (source[i] === "\\") i += 2;
      else if (source[i] === "$" && source[i + 1] === "{") {
        i += 2;
        last = "operator";
        readCode(true);
      } else i += 1;
    }
    i += 1;
  };

  readCode(false);
  return found;
}

/** The plugin's two entries and every `.ts`/`.tsx` under `client/`, `server/` and `shared/`. */
function sources(plugin) {
  const files = ["index.client.tsx", "index.server.ts"]
    .map((name) => join(plugin, name))
    .filter((file) => exists(file));
  const walk = (dir) => {
    if (!exists(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  for (const dir of ["client", "server", "shared"]) walk(join(plugin, dir));
  return files;
}

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

const directories = process.argv.slice(2);
if (directories.length === 0) {
  console.error("usage: check-comment-language.mjs <plugin-dir>...");
  process.exit(2);
}

let failed = false;
for (const dir of directories) {
  const plugin = basename(dir);
  const files = sources(dir);
  const hits = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (!HANGUL.test(source)) continue;
    for (const { start, text } of comments(source)) {
      const at = text.search(HANGUL);
      if (at === -1) continue;
      const line = source.slice(0, start + at).split("\n").length;
      hits.push({ file: relative(".", file), line });
    }
  }
  if (hits.length === 0) {
    console.log(`✓ ${plugin} (${files.length} files)`);
    continue;
  }
  failed = true;
  for (const { file, line } of hits) {
    // Annotates the pull request's Files tab as well as the log.
    console.log(`::error file=${file},line=${line},title=${plugin}::Korean in a comment; write it in English`);
  }
}

if (failed) process.exit(1);
