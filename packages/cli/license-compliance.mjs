import parseSpdx from "spdx-expression-parse";
import { isIP } from "node:net";

const REMOTE_PROTOCOLS = new Set(["git:", "http:", "https:", "ssh:"]);
const GITHUB_OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?";
const GITHUB_REPOSITORY = "[A-Za-z0-9_.-]*[A-Za-z0-9][A-Za-z0-9_.-]*";
const GITHUB_PATH = `(${GITHUB_OWNER})/(${GITHUB_REPOSITORY}(?:#[A-Za-z0-9_.\/-]+)?)`;

function privateIpv4(parts) {
  return parts[0] === 0
    || parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function ipv6Words(input) {
  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part) => part === "" ? [] : part.split(":").map((word) => Number.parseInt(word, 16));
  const left = parse(halves[0]);
  const right = parse(halves[1] ?? "");
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  return [...left, ...Array(missing).fill(0), ...right];
}

function privateHost(input) {
  const hostname = input.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (isIP(hostname) === 4) return privateIpv4(hostname.split(".").map(Number));
  if (isIP(hostname) !== 6) return false;
  const words = ipv6Words(hostname);
  if (!words) return true;
  const unspecified = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const uniqueLocal = (words[0] & 0xfe00) === 0xfc00;
  const linkLocal = (words[0] & 0xffc0) === 0xfe80;
  const mappedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
    ? [(words[6] >> 8) & 0xff, words[6] & 0xff, (words[7] >> 8) & 0xff, words[7] & 0xff]
    : undefined;
  return unspecified || loopback || uniqueLocal || linkLocal
    || (mappedIpv4 !== undefined && privateIpv4(mappedIpv4));
}

export function normalizeSourceUrl(input) {
  if (typeof input !== "string" || input.trim() !== input || input === "") {
    throw new Error("Expected an explicit remote source URL");
  }

  const github = input.match(new RegExp(`^github:${GITHUB_PATH}$`));
  if (github) return `https://github.com/${github[1]}/${github[2]}`;

  const shorthand = input.match(new RegExp(`^${GITHUB_PATH}$`));
  if (shorthand) {
    return `https://github.com/${shorthand[1]}/${shorthand[2]}`;
  }

  const normalizedInput = input.replace(/^git\+(?=(?:https?|ssh):)/, "");
  if (!/^(?:git|https?|ssh):\/\//.test(normalizedInput)) {
    throw new Error(`Expected an explicit remote source URL, received '${input}'`);
  }
  let url;
  try {
    url = new URL(normalizedInput);
  } catch {
    throw new Error(`Expected an explicit remote source URL, received '${input}'`);
  }
  if (!REMOTE_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Expected an explicit remote source URL, received '${input}'`);
  }
  const githubHost = url.hostname.toLowerCase() === "github.com";
  const allowedGithubSshUser = githubHost && url.protocol === "ssh:" && url.username === "git";
  if (
    url.hostname === ""
    || url.password !== ""
    || (url.username !== "" && !allowedGithubSshUser)
    || privateHost(url.hostname)
  ) {
    throw new Error(`Expected a public credential-free remote source URL, received '${input}'`);
  }
  if (githubHost) {
    return `https://github.com${url.pathname}`;
  }
  return url.href;
}

export function validateSpdxExpression(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("License metadata must contain an SPDX expression");
  }
  const expression = input.trim();
  try {
    parseSpdx(expression);
  } catch (error) {
    throw new Error(`Invalid SPDX license expression '${expression}'`, { cause: error });
  }
  return expression;
}

export function validateAttributableLicenseText(input, source, options = {}) {
  const text = typeof input === "string" ? input.replace(/\r\n/g, "\n").trimEnd() : "";
  const legalLanguage = /copyright|permission|redistribution|licensed under|warranty/i;
  if (
    text.length < 200
    || !legalLanguage.test(text)
    || (options.requireCopyright === true && !/copyright/i.test(text))
  ) {
    throw new Error(`${source} does not contain complete attributable license text`);
  }
  return text;
}

export function extractReadmeLicenseSection(source, file) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^(#{1,6})[ \t]+licen[cs]e[ \t]*#*[ \t]*$/i.test(line));
  if (start < 0) return undefined;
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})[ \t]+/);
    if (heading && heading[1].length <= level) {
      end = index;
      break;
    }
  }
  const text = lines.slice(start + 1, end).join("\n").trim();
  if (text === "") return undefined;
  return { kind: "readme", source: `${file}#License`, text };
}

function requiredString(value, field, identifier) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`License override ${identifier} is missing ${field}`);
  }
  return value.trim();
}

export function validateLicenseOverrides(input) {
  if (
    input === null
    || typeof input !== "object"
    || input.schemaVersion !== 1
    || input.packages === null
    || typeof input.packages !== "object"
    || Array.isArray(input.packages)
  ) {
    throw new Error("License overrides must use schemaVersion 1 and a packages object");
  }
  const overrides = new Map();
  for (const [identifier, value] of Object.entries(input.packages)) {
    if (!/^(?:@[^/]+\/)?[^@/]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(identifier)) {
      throw new Error(`License override '${identifier}' must lock an exact package version`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`License override ${identifier} is invalid`);
    }
    const reason = requiredString(value.reason, "reason", identifier);
    const source = normalizeSourceUrl(requiredString(value.source, "source", identifier));
    const text = validateAttributableLicenseText(
      requiredString(value.licenseText, "licenseText", identifier),
      `License override ${identifier}`,
      { requireCopyright: true }
    );
    overrides.set(identifier, { kind: "override", reason, source, text });
  }
  return overrides;
}

export function takeLicenseOverride(overrides, identifier, used) {
  const override = overrides.get(identifier);
  if (override) used.add(identifier);
  return override;
}

export function assertNoUnusedLicenseOverrides(overrides, used) {
  const unused = [...overrides.keys()].filter((identifier) => !used.has(identifier)).sort();
  if (unused.length > 0) {
    throw new Error(`Unused license overrides: ${unused.join(", ")}`);
  }
}
