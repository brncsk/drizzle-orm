import {
	normalizeFunctionAttributes,
	normalizeFunctionReturns,
	normalizeIndexOptions,
	normalizeSqlTypeName,
	normalizeTriggerWhen,
	parseTriggerDefinition,
	splitSqlType,
	trimDefaultValueSuffix,
} from 'src/dialects/postgres/grammar';
import { expect, test } from 'vitest';

test.each([
	["'a'::my_enum", "'a'"],
	["'abc'::text", "'abc'"],
	["'abc'::character varying", "'abc'"],
	["'abc'::bpchar", "'abc'"],
	[`'{"attr":"value"}'::json`, `'{"attr":"value"}'`],
	[`'{"attr": "value"}'::jsonb`, `'{"attr": "value"}'`],
	[`'00:00:00'::time without time zone`, `'00:00:00'`],
	[`'2025-04-24 08:30:45.08+00'::timestamp with time zone`, `'2025-04-24 08:30:45.08+00'`],
	[`'2024-01-01'::date`, `'2024-01-01'`],
	[`'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid`, `'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'`],
	[`now()`, `now()`],
	[`CURRENT_TIMESTAMP`, `CURRENT_TIMESTAMP`],
	[`timezone('utc'::text, now())`, `timezone('utc'::text, now())`],
	[`'{a,b}'::my_enum[]`, `'{a,b}'`],
	[`'{10,20}'::smallint[]`, `'{10,20}'`],
	[`'{10,20}'::integer[]`, `'{10,20}'`],
	[`'{99.9,88.8}'::numeric[]`, `'{99.9,88.8}'`],
	[`'{100,200}'::bigint[]`, `'{100,200}'`],
	[`'{t,f}'::boolean[]`, `'{t,f}'`],
	[`'{abc,def}'::text[]`, `'{abc,def}'`],
	[`'{abc,def}'::character varying[]`, `'{abc,def}'`],
	[`'{abc,def}'::bpchar[]`, `'{abc,def}'`],
	[`'{100,200}'::double precision[]`, `'{100,200}'`],
	[`'{100,200}'::real[]`, `'{100,200}'`],
	["'{}'::character(1)[]", "'{}'"],
	[
		`'{"{\"attr\":\"value1\"}","{\"attr\":\"value2\"}"}'::json[]`,
		`'{"{\"attr\":\"value1\"}","{\"attr\":\"value2\"}"}'`,
	],
	[
		`'{"{\"attr\": \"value1\"}","{\"attr\": \"value2\"}"}'::jsonb[]`,
		`'{"{\"attr\": \"value1\"}","{\"attr\": \"value2\"}"}'`,
	],
	[`'{00:00:00,01:00:00}'::time without time zone[]`, `'{00:00:00,01:00:00}'`],
	[
		`'{"2025-04-24 10:41:36.623+00","2025-04-24 10:41:36.623+00"}'::timestamp with time zone[]`,
		`'{"2025-04-24 10:41:36.623+00","2025-04-24 10:41:36.623+00"}'`,
	],
	[`'{2024-01-01,2024-01-02}'::date[]`, `'{2024-01-01,2024-01-02}'`],
	[
		`'{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11,a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12}'::uuid[]`,
		`'{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11,a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12}'`,
	],
	[`'{127.0.0.1,127.0.0.2}'::inet[]`, `'{127.0.0.1,127.0.0.2}'`],
	[`'{127.0.0.1/32,127.0.0.2/32}'::cidr[]`, `'{127.0.0.1/32,127.0.0.2/32}'`],
	[`'{00:00:00:00:00:00,00:00:00:00:00:01}'::macaddr[]`, `'{00:00:00:00:00:00,00:00:00:00:00:01}'`],
	[
		`'{00:00:00:ff:fe:00:00:00,00:00:00:ff:fe:00:00:01}'::macaddr8[]`,
		`'{00:00:00:ff:fe:00:00:00,00:00:00:ff:fe:00:00:01}'`,
	],
	[`'{"1 day 01:00:00","1 day 02:00:00"}'::interval[]`, `'{"1 day 01:00:00","1 day 02:00:00"}'`],
	[`(predict -> 'predictions'::text)`, `(predict -> 'predictions'::text)`],
])('trim default suffix %#: %s', (it, expected) => {
	expect(trimDefaultValueSuffix(it)).toBe(expected);
});

test('split sql type', () => {
	expect.soft(splitSqlType('numeric')).toStrictEqual({ type: 'numeric', options: null });
	expect.soft(splitSqlType('numeric(10)')).toStrictEqual({ type: 'numeric', options: '10' });
	expect.soft(splitSqlType('numeric(10,0)')).toStrictEqual({ type: 'numeric', options: '10,0' });
	expect.soft(splitSqlType('numeric(10,2)')).toStrictEqual({ type: 'numeric', options: '10,2' });

	expect.soft(splitSqlType('numeric[]')).toStrictEqual({ type: 'numeric', options: null });
	expect.soft(splitSqlType('numeric(10)[]')).toStrictEqual({ type: 'numeric', options: '10' });
	expect.soft(splitSqlType('numeric(10,0)[]')).toStrictEqual({ type: 'numeric', options: '10,0' });
	expect.soft(splitSqlType('numeric(10,2)[]')).toStrictEqual({ type: 'numeric', options: '10,2' });

	expect.soft(splitSqlType('numeric[][]')).toStrictEqual({ type: 'numeric', options: null });
	expect.soft(splitSqlType('numeric(10)[][]')).toStrictEqual({ type: 'numeric', options: '10' });
	expect.soft(splitSqlType('numeric(10,0)[][]')).toStrictEqual({ type: 'numeric', options: '10,0' });
	expect.soft(splitSqlType('numeric(10,2)[][]')).toStrictEqual({ type: 'numeric', options: '10,2' });
});

test('to default array', () => {
	// TODO: wrong test?
	// expect.soft(toDefaultArray([['one'], ['two']], 1, (it) => JSON.stringify(it))).toBe(`{["one"],["two"]}`);
	// expect.soft(toDefaultArray([{ key: 'one' }, { key: 'two' }], 1, (it) => JSON.stringify(it))).toBe(
	// 	`{{"key":"one"},{"key":"two"}}`,
	// );
});

test.each([
	['int', 'integer'],
	['INT4', 'integer'],
	['float8', 'double precision'],
	['double  precision', 'double precision'],
	['uuid []', 'uuid[]'],
	['varchar', 'character varying'],
	['numeric(10,2)', 'numeric(10,2)'],
	['paradedb.searchqueryinput', 'paradedb.searchqueryinput'],
	['"MyType"', '"MyType"'],
])('normalizeSqlTypeName(%s) -> %s', (input, expected) => {
	expect(normalizeSqlTypeName(input)).toBe(expected);
});

test.each([
	['TABLE (line geometry, kind text)', 'TABLE(line geometry, kind text)'],
	['table(a numeric(10,2), b int)', 'TABLE(a numeric(10,2), b integer)'],
	['SETOF int', 'SETOF integer'],
	['trigger', 'trigger'],
	['void', 'void'],
])('normalizeFunctionReturns(%s) -> %s', (input, expected) => {
	expect(normalizeFunctionReturns(input)).toBe(expected);
});

test.each([
	[null, null],
	['', null],
	['VOLATILE', null],
	['immutable strict parallel safe', 'IMMUTABLE STRICT PARALLEL SAFE'],
	['PARALLEL SAFE IMMUTABLE STRICT', 'IMMUTABLE STRICT PARALLEL SAFE'],
	[
		'STABLE SECURITY DEFINER SET search_path = pg_catalog, public',
		'STABLE SECURITY DEFINER SET search_path = pg_catalog, public',
	],
	['SET search_path TO pg_catalog, public STABLE', 'STABLE SET search_path = pg_catalog, public'],
	['RETURNS NULL ON NULL INPUT SECURITY INVOKER COST 10', 'STRICT COST 10'],
	[
		'IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, public',
		'IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, public',
	],
])('normalizeFunctionAttributes(%s) -> %s', (input, expected) => {
	expect(normalizeFunctionAttributes(input)).toBe(expected);
});

test.each([
	['AFTER INSERT OR DELETE OR UPDATE', 'AFTER INSERT OR UPDATE OR DELETE'],
	['before  insert or update', 'BEFORE INSERT OR UPDATE'],
	['AFTER UPDATE OF a,b OR INSERT', 'AFTER INSERT OR UPDATE OF a, b'],
	['INSTEAD OF DELETE', 'INSTEAD OF DELETE'],
])('normalizeTriggerWhen(%s) -> %s', (input, expected) => {
	expect(normalizeTriggerWhen(input)).toBe(expected);
});

test('parseTriggerDefinition reads what pg_get_triggerdef prints', () => {
	expect(
		parseTriggerDefinition(
			'CREATE TRIGGER grants_recompile AFTER INSERT OR DELETE OR UPDATE ON acl.grants FOR EACH ROW EXECUTE FUNCTION acl.grants_recompile()',
		),
	).toStrictEqual({
		when: 'AFTER INSERT OR UPDATE OR DELETE',
		level: 'ROW',
		condition: null,
		function: 'acl.grants_recompile',
	});
	expect(
		parseTriggerDefinition(
			'CREATE TRIGGER "Check" BEFORE INSERT ON public.fields FOR EACH STATEMENT EXECUTE FUNCTION fields_check()',
		),
	).toStrictEqual({ when: 'BEFORE INSERT', level: 'STATEMENT', condition: null, function: 'public.fields_check' });
	// the condition is the text inside `WHEN (...)`, with the parentheses Postgres adds inside it
	expect(
		parseTriggerDefinition(
			"CREATE TRIGGER objects_fan_out AFTER UPDATE ON public._objects FOR EACH ROW WHEN (((old.scope IS DISTINCT FROM new.scope) OR (current_setting('x'::text, true) = 'on'::text))) EXECUTE FUNCTION tree.objects_fan_out()",
		),
	).toStrictEqual({
		when: 'AFTER UPDATE',
		level: 'ROW',
		condition: "((old.scope IS DISTINCT FROM new.scope) OR (current_setting('x'::text, true) = 'on'::text))",
		function: 'tree.objects_fan_out',
	});
	// a transition table is not read
	expect(
		parseTriggerDefinition(
			'CREATE TRIGGER t AFTER INSERT ON public.users REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION audit()',
		),
	).toBeNull();
});

test.each([
	[null, ''],
	['fillfactor=70', 'fillfactor=70'],
	[
		"key_field=id, search_tokenizer='unicode_words(ascii_folding=true)', target_segment_count=2",
		'key_field=id, search_tokenizer=unicode_words(ascii_folding=true), target_segment_count=2',
	],
	['target_segment_count=2, key_field=id', 'key_field=id, target_segment_count=2'],
	["a='it''s'", "a=it's"],
])('normalizeIndexOptions(%s) -> %s', (input, expected) => {
	expect(normalizeIndexOptions(input)).toBe(expected);
});
