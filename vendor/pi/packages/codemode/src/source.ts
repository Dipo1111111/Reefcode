/**
 * Codemode source format: JavaScript, optionally preceded by one options line.
 *
 * ```js
 * // @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
 * const text = await tools.read({ path: "package.json" });
 * text(JSON.parse(text).name);
 * ```
 */

export const CODEMODE_OPTIONS_PREFIX = "// @options:";

const SUPPORTED_FIELDS = ["max_output_tokens", "timeout_ms", "startInBackground"] as const;
const SUPPORTED_FIELDS_TEXT = "`max_output_tokens`, `timeout_ms`, and `startInBackground`";
/** Largest delay `setTimeout` supports, which bounds `timeout_ms`. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Lark grammar for providers with grammar-constrained tool input. It only fixes the shape of the
 * options line; the options JSON and the code are checked by {@link parseCodemodeSource}.
 */
export const CODEMODE_SOURCE_GRAMMAR = String.raw`
start: options_source | plain_source
options_source: OPTIONS_LINE NEWLINE SOURCE
plain_source: SOURCE

OPTIONS_LINE: /[ \t]*\/\/ @options:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

export interface CodemodeSourceOptions {
	/** Token budget for the script's output. */
	maxOutputTokens?: number;
	/** Hard deadline for the whole script in milliseconds, including tool calls. */
	timeoutMs?: number;
	/**
	 * Return as soon as the script starts, and keep running it in the background. The tool result
	 * carries the job id; `wait_for_script` waits on it, polls it, or kills it.
	 */
	startInBackground?: boolean;
}

export interface ParsedCodemodeSource {
	/** The script with the options line replaced by an empty line, so line numbers are unchanged. */
	code: string;
	options: CodemodeSourceOptions;
}

export class CodemodeSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodemodeSourceError";
	}
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseOptions(directive: string): CodemodeSourceOptions {
	if (directive === "") {
		throw new CodemodeSourceError(`@options must be a JSON object with supported fields ${SUPPORTED_FIELDS_TEXT}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(directive);
	} catch (error) {
		throw new CodemodeSourceError(
			`@options must be valid JSON with supported fields ${SUPPORTED_FIELDS_TEXT}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CodemodeSourceError(`@options must be a JSON object with supported fields ${SUPPORTED_FIELDS_TEXT}`);
	}
	const fields = value as Record<string, unknown>;
	for (const key of Object.keys(fields)) {
		if (!(SUPPORTED_FIELDS as readonly string[]).includes(key)) {
			throw new CodemodeSourceError(`@options only supports ${SUPPORTED_FIELDS_TEXT}; got \`${key}\``);
		}
	}
	const options: CodemodeSourceOptions = {};
	const { max_output_tokens, timeout_ms, startInBackground } = fields;
	if (startInBackground !== undefined && typeof startInBackground !== "boolean") {
		throw new CodemodeSourceError("`startInBackground` must be true or false");
	}
	if (startInBackground === true) options.startInBackground = true;
	if (max_output_tokens !== undefined) {
		if (!isSafeInteger(max_output_tokens)) {
			throw new CodemodeSourceError("@options field `max_output_tokens` must be a non-negative safe integer");
		}
		options.maxOutputTokens = max_output_tokens;
	}
	if (timeout_ms !== undefined) {
		if (!isSafeInteger(timeout_ms) || timeout_ms === 0 || timeout_ms > MAX_TIMEOUT_MS) {
			throw new CodemodeSourceError(
				`@options field \`timeout_ms\` must be a positive integer up to ${MAX_TIMEOUT_MS}`,
			);
		}
		options.timeoutMs = timeout_ms;
	}
	return options;
}

/**
 * Split an optional first-line `// @options: {...}` from the script. Throws
 * {@link CodemodeSourceError} for empty input, invalid options, and an options line that is not the
 * first line, which would otherwise be ignored without notice.
 */
export function parseCodemodeSource(input: string): ParsedCodemodeSource {
	if (input.trim() === "") {
		throw new CodemodeSourceError(
			'Expected JavaScript source text (non-empty). Provide JS only, optionally with a first line `// @options: {"max_output_tokens": 1000}`.',
		);
	}
	const lines = input.split("\n");
	const misplaced = lines.findIndex(
		(line, index) => index > 0 && line.trimStart().startsWith(CODEMODE_OPTIONS_PREFIX),
	);
	if (misplaced !== -1) {
		throw new CodemodeSourceError(
			`The ${CODEMODE_OPTIONS_PREFIX} line must be the first line of the input; found one on line ${misplaced + 1}`,
		);
	}
	const newline = input.indexOf("\n");
	const firstLine = lines[0].replace(/\r$/, "");
	const trimmed = firstLine.trimStart();
	if (!trimmed.startsWith(CODEMODE_OPTIONS_PREFIX)) return { code: input, options: {} };
	const code = newline === -1 ? "" : input.slice(newline);
	if (code.trim() === "") {
		throw new CodemodeSourceError("The @options line must be followed by JavaScript source on subsequent lines");
	}
	return { code, options: parseOptions(trimmed.slice(CODEMODE_OPTIONS_PREFIX.length).trim()) };
}

// =============================================================================
// Script input blocks (`// @input: name <<'EOF' ... EOF`)
// =============================================================================

/** One heredoc input block, available to the script as `inputs[name]`. */
export interface ScriptInput {
	name: string;
	value: string;
	/** 1-based line of the `// @input:` directive. */
	line: number;
}

export interface ParsedScriptSource extends ParsedCodemodeSource {
	/** Input blocks, in source order. Later blocks with the same name win. */
	inputs: readonly ScriptInput[];
}

const INPUT_DIRECTIVE = /^\s*\/\/\s*@input:\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2\s*$/;
/** `// @script: {...}` is an alias of `// @options: {...}`, named for the tool the model calls. */
const SCRIPT_OPTIONS_PREFIX = "// @script:";

/**
 * Extract `// @input: name <<'TAG'` blocks.
 *
 * The block's body is removed from the executable source and replaced by blank lines, so line
 * numbers in error messages still match what the model wrote. The values are handed to the
 * sandbox as `inputs`, which the prelude defines as a frozen object.
 */
export function parseScriptInputs(code: string): { code: string; inputs: ScriptInput[] } {
	const lines = code.split("\n");
	const inputs: ScriptInput[] = [];
	for (let i = 0; i < lines.length; i++) {
		const match = INPUT_DIRECTIVE.exec(lines[i] ?? "");
		if (!match) continue;
		const name = match[1] as string;
		const tag = match[3] as string;
		const body: string[] = [];
		let closed = false;
		let j = i + 1;
		for (; j < lines.length; j++) {
			const line = lines[j] ?? "";
			if (line.trim() === tag) {
				closed = true;
				break;
			}
			body.push(line);
		}
		if (!closed) {
			throw new CodemodeSourceError(
				`@input \`${name}\` on line ${i + 1} is not closed: expected a line containing only \`${tag}\``,
			);
		}
		inputs.push({ name, value: body.join("\n"), line: i + 1 });
		for (let k = i; k <= j; k++) lines[k] = "";
		i = j;
	}
	return { code: lines.join("\n"), inputs };
}

/** `parseScriptInputs` after `parseCodemodeSource`: options line first, then input blocks. */
export function parseScriptSource(source: string, options?: CodemodeSourceOptions): ParsedScriptSource {
	// A caller that omitted `script` gets a parse of the empty string, not a crash in the parser.
	const text = typeof source === "string" ? source : "";
	const normalized = text.trimStart().startsWith(SCRIPT_OPTIONS_PREFIX)
		? `// @options:${text.trimStart().slice(SCRIPT_OPTIONS_PREFIX.length)}`
		: text;
	const parsed = parseCodemodeSource(normalized);
	const { code, inputs } = parseScriptInputs(parsed.code);
	return { code, options: parsed.options, inputs };
}
