#!/usr/bin/env node
/**
 * Regression suite for the permission-gate /tmp rm exemption
 * (extensions/permission-gate.ts). Plain node, no test framework:
 *
 *   node tests/permission-gate.test.mjs
 *
 * Each case asserts the verdict the gate's handler reaches for a bash
 * command: "run" (isDangerousCommand never flags it, the gate is
 * irrelevant), "exempt" (dangerous, but the /tmp exemption auto-runs
 * it), or "gate" (prompt in UI sessions, block headless).
 *
 * Classes pinned here come from the unit review of 580b1cc: gate-blind
 * rm flag orders and patternless destructive siblings in compound
 * position (DC1), carriage returns in operands and between segments
 * (DC4), trailing backslashes, symlink operand shapes (DC3), glob and
 * normalization edges, and true traversal escapes.
 *
 * Two conventions to read expectations correctly:
 * - `rm -rf /tmp/a/../a/b` is a CONFINED path (lexically inside /tmp
 *   after normalization) and must stay exempt.
 * - Standalone `rm -fr`, `rm -f -r`, `rm --force -r`, `rm -fR` verdicts
 *   of "run" are pre-existing gaps in the gate's own regex, unchanged
 *   by the exemption work; they are pinned to catch accidental changes.
 *   The exemption analyzer parses those flag orders itself, so the same
 *   orders in compound position are exempt when every segment parses as
 *   a confined recursive rm, and gate otherwise.
 * - Symlink residual, accepted knowingly (see the extension header):
 *   `/tmp/link/sub` through a planted symlink stays exempt; the
 *   trailing-slash shapes refuse.
 */

import { isDangerousCommand, isTmpConfinedRmOnlyCommand } from "../extensions/permission-gate.ts";

function gateVerdict(command) {
	if (!isDangerousCommand(command)) return "run";
	return isTmpConfinedRmOnlyCommand(command) ? "exempt" : "gate";
}

const cases = [
	// --- basic grants ---------------------------------------------------
	["basic confined rm", "rm -rf /tmp/pg-rem/x", "exempt"],
	["-r flag", "rm -r /tmp/a", "exempt"],
	["-R flag", "rm -R /tmp/a", "exempt"],
	["-rfv flag", "rm -rfv /tmp/a", "exempt"],
	["--recursive long flag", "rm --recursive /tmp/a", "exempt"],
	["multiple operands", "rm -rf /tmp/a /tmp/b", "exempt"],
	["literal-prefix glob", "rm -rf /tmp/foo-*", "exempt"],
	["later-component glob", "rm -rf /tmp/x/*", "exempt"],
	["-- separator before operand", "rm -rf -- /tmp/a", "exempt"],
	// The exemption analyzer grants flag-after-operand, but the gate regex
	// requires -r directly after `rm `, so the gate never fires: handler
	// verdict is "run", same class as the standalone flag-order gaps below.
	["flag after operand (gate regex gap)", "rm /tmp/a -rf", "run"],

	// --- standalone gate-blind rm flag orders: pre-existing gate regex
	// gap, pinned unchanged (the gate never fires, verdict is "run") ----
	["standalone rm --force -r (gate regex gap)", "rm --force -r /tmp/a", "run"],
	["standalone rm -f -r (gate regex gap)", "rm -f -r /tmp/a", "run"],
	["standalone rm -fr (gate regex gap)", "rm -fr /tmp/a", "run"],
	["standalone rm -fR (gate regex gap)", "rm -fR /tmp/a", "run"],

	// --- compounds of confined rms stay exempt (DC1 keeps these) -------
	["&& compound of two confined rms", "rm -rf /tmp/a && rm -rf /tmp/b", "exempt"],
	["|| compound of two confined rms", "rm -rf /tmp/a || rm -rf /tmp/b", "exempt"],
	["newline compound of two confined rms", "rm -rf /tmp/a\nrm -rf /tmp/b", "exempt"],
	["semicolon compound without spaces", "rm -rf /tmp/a;rm -rf /tmp/b", "exempt"],
	["piped rm into rm", "rm -rf /tmp/a|rm -rf /tmp/b", "exempt"],
	["trailing &", "rm -rf /tmp/a &", "exempt"],
	["three-segment compound", "rm -rf /tmp/a && rm -rf /tmp/b && rm -rf /tmp/c", "exempt"],
	["compound with flag-order sibling that parses confined", "rm -rf /tmp/a /tmp/b && rm -fR /tmp/c", "exempt"],
	["sibling rm -f -r with confined operand parses exempt", "rm -rf /tmp/a && rm -f -r /tmp/b", "exempt"],
	["sibling rm --force -r with confined operand parses exempt", "rm -rf /tmp/a && rm --force -r /tmp/b", "exempt"],

	// --- DC1: any other companion segment falls back to the gate -------
	["echo companion", "rm -rf /tmp/a && echo done", "gate"],
	["ls companion", "rm -rf /tmp/a && ls /tmp", "gate"],
	["cd companion", "rm -rf /tmp/a && cd /tmp/b", "gate"],
	["gate-blind flag-order sibling, relative operand", "rm -rf /tmp/x && rm -f -r ./build", "gate"],
	["gate-blind rm -fr sibling, home operand", "rm -rf /tmp/a && rm -fr ~", "gate"],
	["non-recursive rm sibling", "rm -rf /tmp/a && rm /tmp/b", "gate"],
	["xargs rm sibling", "rm -rf /tmp/a && xargs rm -fr /etc", "gate"],
	["echo piped into xargs rm", "rm -rf /tmp/a && echo /home/victim | xargs rm -fr", "gate"],
	["dd sibling", "rm -rf /tmp/a && dd if=/dev/zero of=/dev/sda", "gate"],
	["find -delete sibling", "rm -rf /tmp/a && find /tmp -name x -delete", "gate"],
	["shred sibling", "rm -rf /tmp/a && shred /home/victim/disk.img", "gate"],
	["quoted one-word dd companion", "rm -rf /tmp/a && 'dd if=/dev/zero of=/dev/sda'", "gate"],
	["sudo sibling", "rm -rf /tmp/a && sudo id", "gate"],
	["chmod 777 sibling", "rm -rf /tmp/a && chmod -R 777 /tmp/b", "gate"],
	["piped rm into cat", "rm -rf /tmp/a | cat", "gate"],

	// --- DC4: CR is an ordinary word character, matching bash ----------
	["CR smuggled into operand before ..", "rm -rf /tmp/x\r../..", "gate"],
	["CR between segments leaves a relative rm operand", "rm -rf /tmp/a\r rm -rf /tmp/b", "gate"],
	["CR inside one confined component matches bash", "rm -rf /tmp/a\rb", "exempt"],

	// --- trailing backslash bails (matches the scanner's JSDoc) --------
	["trailing backslash", "rm -rf /tmp/x\\", "gate"],

	// --- DC3: symlink shapes -------------------------------------------
	["bare symlink operand unlinks the link only", "rm -rf /tmp/link", "exempt"],
	["trailing-slash symlink operand dereferences", "rm -rf /tmp/link/", "gate"],
	["double trailing slash dereferences", "rm -rf /tmp/link//", "gate"],
	["subpath through planted symlink stays exempt (documented residual)", "rm -rf /tmp/link/sub", "exempt"],
	["trailing slash on a real directory (accepted friction)", "rm -rf /tmp/x/", "gate"],

	// --- glob edges ------------------------------------------------------
	["glob glued to literal, leading *", "rm -rf /tmp/*x", "gate"],
	["bracket glob as first component", "rm -rf /tmp/[a]", "gate"],
	["brace expansion unmodeled", "rm -rf /tmp/{a,b}", "gate"],

	// --- normalization edges --------------------------------------------
	["empty component", "rm -rf /tmp//x", "exempt"],
	["dot component", "rm -rf /tmp/./x", "exempt"],
	["traversal that stays inside /tmp is confined", "rm -rf /tmp/a/../a/b", "exempt"],
	["traversal pops to bare tmp", "rm -rf /tmp/x/../..", "gate"],
	["traversal above root", "rm -rf /../..", "gate"],
	["true traversal escape to /etc", "rm -rf /tmp/x/../../etc", "gate"],
	["traversal out of tmp", "rm -rf /tmp/../etc", "gate"],
	["bare tmp", "rm -rf /tmp", "gate"],
	["filesystem root", "rm -rf /", "gate"],

	// --- operand shapes --------------------------------------------------
	["-- with path-lookalike operand", "rm -r -- -rf /tmp/x", "gate"],
	["bare dash operand", "rm -r - /tmp/x", "gate"],
	["home operand", "rm -rf /tmp/a; rm ~/x", "gate"],
	["relative operand", "rm -rf ./build", "gate"],

	// --- substitutions, executors, prefixes, syntax bails ---------------
	["variable substitution", "rm -rf $VAR", "gate"],
	["brace variable substitution", "rm -rf ${HOME}", "gate"],
	["command substitution", "rm -rf $(cat /tmp/list)", "gate"],
	["backtick substitution", "rm -rf `echo /tmp/a`", "gate"],
	["env prefix", "env rm -rf /tmp/a", "gate"],
	["xargs prefix", "xargs rm -rf /tmp/a", "gate"],
	["escaped name prefix", "\\rm -rf /tmp/a", "gate"],
	["time prefix", "time rm -rf /tmp/a", "gate"],
	["uppercase name", "RM -rf /tmp/a", "gate"],
	["case-mismatched long flag", "rm --RECURSIVE /tmp/a", "gate"],
	["long flag with value", "rm --recursive=always /tmp/a", "gate"],
	["quoted operands", 'rm -rf "/tmp/a /tmp/b"', "gate"],
	["flag glued to quoted operand", 'rm -rf"/tmp/x"', "gate"],
	["redirect", "rm -rf /tmp/a > /etc/passwd", "gate"],
	["stderr redirect", "rm -rf /tmp/a 2>&1", "gate"],
	["grouping", "rm -rf /tmp/a && (rm -rf /tmp/b)", "gate"],
	["comment", "rm -rf /tmp/a # cleanup", "gate"],
	["unterminated quote", 'rm -rf "/tmp/a', "gate"],

	// --- other dangerous commands unchanged -----------------------------
	["sudo alone", "sudo id", "gate"],
	["chmod 777 alone", "chmod 777 /tmp/f", "gate"],
	["echo mentioning rm is flagged", "echo rm -rf /tmp/a", "gate"],

	// --- inert commands unchanged ---------------------------------------
	["quoted rm mention is inert", 'echo "rm -rf /tmp/a"', "run"],
	["plain rm is not gated", "rm /tmp/file", "run"],
	["ls is not gated", "ls /tmp", "run"],
	["cat is not gated", "cat /tmp/pg-rem/file", "run"],
];

let failed = 0;
for (const [label, command, expected] of cases) {
	const actual = gateVerdict(command);
	if (actual !== expected) {
		failed++;
		console.log(`FAIL  ${label}`);
		console.log(`      command : ${JSON.stringify(command)}`);
		console.log(`      expected: ${expected}`);
		console.log(`      actual  : ${actual}`);
	}
}

const passed = cases.length - failed;
console.log(`\n${passed}/${cases.length} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
