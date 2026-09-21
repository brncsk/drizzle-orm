/**
 * A transform of a loaded schema file: it sees the module's exports and
 * the file's path, and returns what to add to the exports before the
 * schema objects are collected from them; a returned key replaces an
 * export of the same name. What it returns follows the file's own
 * exports, in the order returned, a replaced export among them, so the
 * transform decides the order its objects are created in where that
 * matters (a function after the ones its body calls). The config names
 * them (`transform: [...]`), and each schema file passes through every
 * transform in order. What a
 * transform returns is ordinary schema objects (a table, a function, ...),
 * so a schema may be derived from a file at load time: built, generated,
 * or read off objects drizzle-kit does not know.
 */
export type SchemaTransform = (
	exports: Record<string, unknown>,
	path: string,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export type ResolverOutput<T> = {
	created: T[];
	deleted: T[];
	renamedOrMoved: { from: T; to: T }[];
};

export type Resolver<T extends { name: string; schema?: string; table?: string | null }> = (it: {
	created: T[];
	deleted: T[];
}) => Promise<ResolverOutput<T>>;

const dictionary = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export const hash = (input: string, len: number = 12) => {
	const dictLen = BigInt(dictionary.length);
	const combinationsCount = BigInt(dictionary.length) ** BigInt(len);
	const p = 53n;
	let power = 1n;

	let hash = 0n;
	for (const ch of input) {
		hash = (hash + (BigInt(ch.codePointAt(0) || 0) * power)) % combinationsCount;
		power = (power * p) % combinationsCount;
	}

	const result = [] as string[];

	let index = hash;
	for (let i = len - 1; i >= 0; i--) {
		const element = dictionary[Number(index % dictLen)]!;
		result.unshift(element);
		index = index / dictLen;
	}

	return result.join('');
};
