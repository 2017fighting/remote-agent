import { K8sApiError } from "../ports/errors.js";

/**
 * The API server's metadata validation, reproduced so the fake rejects what the
 * real server rejects.
 *
 * The fake used to accept any label value, which let the App write
 * `remote-agent/ticket: owner/name#34` for months while the whole suite stayed
 * green — a value k8s answers 422 for, so the App could never create a Job in a
 * real cluster. A fake more permissive than the server turns a production bug
 * into a test suite that lies, so the grammar lives here and every create path
 * goes through it.
 *
 * Rules (k8s.io/apimachinery `validation.IsQualifiedName` / `IsValidLabelValue`):
 * - keys and values are `[prefix/]name`; an optional prefix is a DNS subdomain
 *   (≤253 chars), the name is ≤63 chars of `[A-Za-z0-9._-]` and must start and
 *   end with an alphanumeric character;
 * - annotation values are free text;
 * - label values additionally obey the 63-char/alphanumeric-boundary rule.
 */

const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const NAME_PART = /^([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]$/;
const NAME_MAX = 63;
const PREFIX_MAX = 253;

/** `validation.IsQualifiedName` for one key. Returns the violations, empty when valid. */
export function keyViolations(key: string): string[] {
  if (key === "") return ["name part must be non-empty"];
  const slash = key.indexOf("/");
  const prefix = slash === -1 ? "" : key.slice(0, slash);
  const name = slash === -1 ? key : key.slice(slash + 1);
  const violations: string[] = [];
  if (slash !== -1) {
    if (prefix === "") violations.push("prefix part must be non-empty");
    else if (prefix.length > PREFIX_MAX) violations.push("prefix part must be no more than 253 characters");
    else if (!DNS_SUBDOMAIN.test(prefix)) violations.push("prefix part must be a valid DNS subdomain");
  }
  if (name === "") violations.push("name part must be non-empty");
  else if (name.length > NAME_MAX) violations.push("name part must be no more than 63 characters");
  else if (!NAME_PART.test(name)) {
    violations.push(
      `name part must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character`,
    );
  }
  return violations;
}

/** `validation.IsValidLabelValue`; empty is legal (it means "no value"). */
export function labelValueViolations(value: string): string[] {
  if (value === "") return [];
  if (value.length > NAME_MAX) return ["must be no more than 63 characters"];
  if (!NAME_PART.test(value)) {
    return [
      "a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character",
    ];
  }
  return [];
}

/**
 * Validate one object's `metadata.labels` / `metadata.annotations` the way the
 * API server does, throwing the 422 it would return. `kind` and `name` only
 * shape the message, so a test failure names the object.
 */
export function assertMetadataValid(input: {
  kind: string;
  name: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}): void {
  const causes: string[] = [];
  for (const [key, value] of Object.entries(input.labels ?? {})) {
    for (const violation of keyViolations(key)) causes.push(`metadata.labels: Invalid value: ${JSON.stringify(key)}: ${violation}`);
    for (const violation of labelValueViolations(value)) {
      causes.push(`metadata.labels: Invalid value: ${JSON.stringify(value)}: ${violation}`);
    }
  }
  for (const key of Object.keys(input.annotations ?? {})) {
    for (const violation of keyViolations(key)) {
      causes.push(`metadata.annotations: Invalid value: ${JSON.stringify(key)}: ${violation}`);
    }
  }
  if (causes.length === 0) return;
  throw new K8sApiError(
    422,
    `${input.kind} ${JSON.stringify(input.name)} is invalid: ${causes.join("; ")}`,
  );
}
