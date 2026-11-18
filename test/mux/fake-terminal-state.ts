import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Surface state for the node fakes of the cmux, wezterm and zellij contract tests.
 * Per surface id N in $FAKE_TERMINAL_STATE: screen-N holds the screen, pending-N the
 * typed text that is not submitted yet, submitted-N one line per submitted command
 * (a newline in the typed text moves pending-N there). titles holds the recorded renames.
 * The fake script starts with FAKE_TERMINAL_STATE_JS and then answers its own CLI.
 */
export const FAKE_TERMINAL_STATE_JS = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const S = process.env.FAKE_TERMINAL_STATE;
const file = (kind, id) => path.join(S, kind + "-" + id);
function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}
function requireSurface(id) {
  if (!fs.existsSync(file("screen", id))) fail("no such surface: " + id);
}
function newSurface() {
  const counter = path.join(S, "next");
  const id = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 1;
  fs.writeFileSync(counter, String(id + 1));
  for (const kind of ["screen", "pending", "submitted"]) fs.writeFileSync(file(kind, id), "");
  return String(id);
}
function typeText(id, text) {
  requireSurface(id);
  fs.appendFileSync(file("screen", id), text);
  let pending = fs.readFileSync(file("pending", id), "utf8");
  for (const char of text) {
    if (char === "\n") {
      fs.appendFileSync(file("submitted", id), pending + "\n");
      pending = "";
    } else {
      pending += char;
    }
  }
  fs.writeFileSync(file("pending", id), pending);
}
function screen(id) {
  requireSurface(id);
  return fs.readFileSync(file("screen", id), "utf8");
}
function closeSurface(id) {
  requireSurface(id);
  for (const kind of ["screen", "pending", "submitted"]) fs.rmSync(file(kind, id));
}
function recordTitle(title) {
  fs.appendFileSync(path.join(S, "titles"), title + "\n");
}
`;

/** Creates surface id as the caller surface of the parent session, so a send to the wrong surface succeeds. */
export function seedCallerSurface(stateDir: string, id: string): void {
	for (const kind of ["screen", "pending", "submitted"]) writeFileSync(join(stateDir, `${kind}-${id}`), "");
}

export function readRecordedTitles(stateDir: string): string[] {
	const file = join(stateDir, "titles");
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

/** All text typed into surface id: the submitted lines, then the pending text. */
export function readTypedText(stateDir: string, id: string): string {
	return ["submitted", "pending"]
		.map((kind) => join(stateDir, `${kind}-${id}`))
		.map((file) => (existsSync(file) ? readFileSync(file, "utf8") : ""))
		.join("");
}

export function readSubmittedCommands(stateDir: string, id: string): string[] {
	const file = join(stateDir, `submitted-${id}`);
	if (!existsSync(file)) return [];
	const text = readFileSync(file, "utf8");
	return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}
