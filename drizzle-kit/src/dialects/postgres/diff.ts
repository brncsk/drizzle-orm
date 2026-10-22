import { trimChar } from '../../utils';
import { mockResolver } from '../../utils/mocks';
import { deepStrictEqual } from '../../utils/node-assert/deep-strict-equal';
import { diffStringArrays } from '../../utils/sequence-matcher';
import { parse } from '../../utils/when-json-met-bigint';
import type { Resolver } from '../common';
import { type Delta, delta, diff, type Row } from '../dialect';
import { groupDiffs, preserveEntityNames, sortCreateViews } from '../utils';
import type { SchemaMetadata } from '../utils';
import { fromJson } from './convertor';
import type {
	CheckConstraint,
	Column,
	DiffEntities,
	Enum,
	ForeignKey,
	Function,
	Index,
	Policy,
	PostgresDDL,
	PostgresEntities,
	PrimaryKey,
	Privilege,
	Role,
	Schema,
	Sequence,
	Trigger,
	UniqueConstraint,
	View,
} from './ddl';
import { createDDL, tableFromDDL } from './ddl';
import {
	callsFunction,
	defaults,
	defaultsCommutative,
	existsInViewDef,
	isSerialType,
	normalizePostgisType,
	sameIndexOptions,
	viewColumnsReplaceable,
} from './grammar';
import type { JsonAlterPrimaryKey, JsonRecreateIndex, JsonStatement } from './statements';
import { prepareStatement } from './statements';

export const ddlDiffDry = async (
	ddlFrom: PostgresDDL,
	ddlTo: PostgresDDL,
	mode: 'default' | 'push',
	$metadata?: SchemaMetadata,
) => {
	const mocks = new Set<string>();
	return ddlDiff(
		ddlFrom,
		ddlTo,
		mockResolver(mocks), // schemas
		mockResolver(mocks), // enums
		mockResolver(mocks), // sequences
		mockResolver(mocks), // policies
		mockResolver(mocks), // roles
		mockResolver(mocks), // tables
		mockResolver(mocks), // columns
		mockResolver(mocks), // views
		mockResolver(mocks), // uniques
		mockResolver(mocks), // indexes
		mockResolver(mocks), // checks
		mockResolver(mocks), // pks
		mockResolver(mocks), // fks
		mode,
		$metadata,
	);
};

export const ddlDiff = async (
	ddl1: PostgresDDL,
	ddl2: PostgresDDL,
	schemasResolver: Resolver<Schema>,
	enumsResolver: Resolver<Enum>,
	sequencesResolver: Resolver<Sequence>,
	policyResolver: Resolver<Policy>,
	roleResolver: Resolver<Role>,
	tablesResolver: Resolver<PostgresEntities['tables']>,
	columnsResolver: Resolver<Column>,
	viewsResolver: Resolver<View>,
	uniquesResolver: Resolver<UniqueConstraint>,
	indexesResolver: Resolver<Index>,
	checksResolver: Resolver<CheckConstraint>,
	pksResolver: Resolver<PrimaryKey>,
	fksResolver: Resolver<ForeignKey>,
	mode: 'default' | 'push',
	$metadata?: SchemaMetadata,
	// Keeps the old name of a constraint whose generated name differs between the states, so no statement
	// changes it. With false, the constraint is dropped and created with its new name.
	keepGeneratedNames = true,
): Promise<{
	statements: JsonStatement[];
	sqlStatements: string[];
	groupedStatements: { jsonStatement: JsonStatement; sqlStatements: string[] }[];
	deltas: Delta[];
}> => {
	const ddl1Copy = createDDL();
	for (const entity of ddl1.entities.list()) {
		ddl1Copy.entities.push(entity);
	}

	// Applies each rename or move that the user confirms to `ddl1` and keeps its delta in `renameDeltas` for
	// the snapshot. The same `ddl1.rename` call changes the state and builds the delta, so the stored delta
	// gives the same state when a later command loads the snapshot.
	const renameDeltas: Delta[] = [];
	const applyRename = (from: Row, set: Row) => {
		const renamed = ddl1.rename(from, set);
		if (renamed) renameDeltas.push(renamed);
	};

	const schemasDiff = diff(ddl1, ddl2, 'schemas');
	const { created: createdSchemas, deleted: deletedSchemas, renamedOrMoved: renamedSchemas } = await schemasResolver({
		created: schemasDiff.filter((it) => it.$diffType === 'create'),
		deleted: schemasDiff.filter((it) => it.$diffType === 'drop'),
	});

	for (const rename of renamedSchemas) {
		applyRename(rename.from, { name: rename.to.name });
	}

	const enumsDiff = diff(ddl1, ddl2, 'enums');
	const { created: createdEnums, deleted: deletedEnums, renamedOrMoved: renamedOrMovedEnums } = await enumsResolver({
		created: enumsDiff.filter((it) => it.$diffType === 'create'),
		deleted: enumsDiff.filter((it) => it.$diffType === 'drop'),
	});

	const renamedEnums = renamedOrMovedEnums.filter((it) => it.from.name !== it.to.name);
	const movedEnums = renamedOrMovedEnums.filter((it) => it.from.schema !== it.to.schema);

	for (const it of renamedOrMovedEnums) {
		applyRename(it.from, { name: it.to.name, schema: it.to.schema });
	}

	const sequencesDiff = diff(ddl1, ddl2, 'sequences');
	const { created: createdSeqs, deleted: deletedSeqs, renamedOrMoved: renamedOrMovedSeqs } = await sequencesResolver({
		created: sequencesDiff.filter((it) => it.$diffType === 'create'),
		deleted: sequencesDiff.filter((it) => it.$diffType === 'drop'),
	});

	const renamedSequences = renamedOrMovedSeqs.filter((it) => it.from.name !== it.to.name);
	const movedSequences = renamedOrMovedSeqs.filter((it) => it.from.schema !== it.to.schema);

	for (const it of renamedOrMovedSeqs) {
		applyRename(it.from, { name: it.to.name, schema: it.to.schema });
	}

	const rolesDiff = diff(ddl1, ddl2, 'roles');
	const { created: createdRoles, deleted: deletedRoles, renamedOrMoved: renamedRoles } = await roleResolver({
		created: rolesDiff.filter((it) => it.$diffType === 'create'),
		deleted: rolesDiff.filter((it) => it.$diffType === 'drop'),
	});
	for (const rename of renamedRoles) {
		applyRename(rename.from, { name: rename.to.name });
	}

	const tablesDiff = diff(ddl1, ddl2, 'tables');
	const { created: createdTables, deleted: deletedTables, renamedOrMoved: orMovedTables } = await tablesResolver({
		created: tablesDiff.filter((it) => it.$diffType === 'create'),
		deleted: tablesDiff.filter((it) => it.$diffType === 'drop'),
	});

	const renamedTables = orMovedTables.filter((it) => it.from.name !== it.to.name);
	const movedTables = orMovedTables.filter((it) => it.from.schema !== it.to.schema);

	for (const rename of orMovedTables) {
		applyRename(rename.from, { name: rename.to.name, schema: rename.to.schema });
	}

	const columnsDiff = diff(ddl1, ddl2, 'columns');
	const columnRenames = [] as { from: Column; to: Column }[];
	const columnsToCreate = [] as Column[];
	const columnsToDelete = [] as Column[];

	const groupedByTable = groupDiffs(columnsDiff);

	for (let it of groupedByTable) {
		const { created, deleted, renamedOrMoved } = await columnsResolver({
			created: it.inserted,
			deleted: it.deleted,
		});

		columnsToCreate.push(...created);
		columnsToDelete.push(...deleted);
		columnRenames.push(...renamedOrMoved);
	}

	for (const rename of columnRenames) {
		applyRename(rename.from, { name: rename.to.name, schema: rename.to.schema });
	}

	if (keepGeneratedNames) {
		preserveEntityNames(ddl1.uniques, ddl2.uniques, mode);
		preserveEntityNames(ddl1.fks, ddl2.fks, mode);
		preserveEntityNames(ddl1.pks, ddl2.pks, mode);
		preserveEntityNames(ddl1.indexes, ddl2.indexes, mode);
	}

	const uniquesDiff = diff(ddl1, ddl2, 'uniques');
	const groupedUniquesDiff = groupDiffs(uniquesDiff);

	const uniqueRenames = [] as { from: UniqueConstraint; to: UniqueConstraint }[];
	const uniqueCreates = [] as UniqueConstraint[];
	const uniqueDeletes = [] as UniqueConstraint[];

	for (const entry of groupedUniquesDiff) {
		const { renamedOrMoved: renamed, created, deleted } = await uniquesResolver({
			created: entry.inserted,
			deleted: entry.deleted,
		});

		uniqueCreates.push(...created);
		uniqueDeletes.push(...deleted);
		uniqueRenames.push(...renamed);
	}

	for (const rename of uniqueRenames) {
		applyRename(rename.from, { name: rename.to.name, schema: rename.to.schema });
	}

	const diffChecks = diff(ddl1, ddl2, 'checks');
	const groupedChecksDiff = groupDiffs(diffChecks);
	const checkRenames = [] as { from: CheckConstraint; to: CheckConstraint }[];
	const checkCreates = [] as CheckConstraint[];
	const checkDeletes = [] as CheckConstraint[];

	for (const entry of groupedChecksDiff) {
		const { renamedOrMoved, created, deleted } = await checksResolver({
			created: entry.inserted,
			deleted: entry.deleted,
		});

		checkCreates.push(...created);
		checkDeletes.push(...deleted);
		checkRenames.push(...renamedOrMoved);
	}

	for (const rename of checkRenames) {
		applyRename(rename.from, { name: rename.to.name, schema: rename.to.schema });
	}

	const diffIndexes = diff(ddl1, ddl2, 'indexes');
	const groupedIndexesDiff = groupDiffs(diffIndexes);
	const indexesRenames = [] as { from: Index; to: Index }[];
	const indexesCreates = [] as Index[];
	const indexesDeletes = [] as Index[];

	for (const entry of groupedIndexesDiff) {
		const { renamedOrMoved, created, deleted } = await indexesResolver({
			created: entry.inserted,
			deleted: entry.deleted,
		});

		indexesCreates.push(...created);
		indexesDeletes.push(...deleted);
		indexesRenames.push(...renamedOrMoved);
	}
	// An index that keeps its name on another table must be dropped and created. `diff.alters` reports such an
	// index as an alter, because the identity of an index has no table.
	for (const it of diff.alters(ddl1, ddl2, 'indexes')) {
		if (it.$left.table === it.$right.table) continue;
		indexesDeletes.push(it.$left);
		indexesCreates.push(it.$right);
	}

	for (const rename of indexesRenames) {
		applyRename(rename.from, { name: rename.to.name, schema: rename.to.schema });
	}

	const diffPKs = diff(ddl1, ddl2, 'pks');
	const groupedPKsDiff = groupDiffs(diffPKs);
	const pksRenames = [] as { from: PrimaryKey; to: PrimaryKey }[];
	const pksCreates = [] as PrimaryKey[];
	const pksDeletes = [] as PrimaryKey[];

	for (const entry of groupedPKsDiff) {
		const { renamedOrMoved, created, deleted } = await pksResolver({
			created: entry.inserted,
			deleted: entry.deleted,
		});

		pksCreates.push(...created);
		pksDeletes.push(...deleted);
		pksRenames.push(...renamedOrMoved);
	}

	for (const rename of pksRenames) {
		applyRename(rename.from, { name: rename.to.name, schema: rename.to.schema });
	}

	const diffFKs = diff(ddl1, ddl2, 'fks');
	const groupedFKsDiff = groupDiffs(diffFKs);
	const fksRenames = [] as { from: ForeignKey; to: ForeignKey }[];
	const fksCreates = [] as ForeignKey[];
	const fksDeletes = [] as ForeignKey[];

	for (const entry of groupedFKsDiff) {
		const { renamedOrMoved, created, deleted } = await fksResolver({
			created: entry.inserted,
			deleted: entry.deleted,
		});

		fksCreates.push(...created);
		fksDeletes.push(...deleted);
		fksRenames.push(...renamedOrMoved);
	}

	for (const rename of fksRenames) {
		applyRename(rename.from, { name: rename.to.name, schema: rename.to.schema });
	}

	const policiesDiff = diff(ddl1, ddl2, 'policies');
	const policiesDiffGrouped = groupDiffs(policiesDiff);

	const policyRenames = [] as { from: Policy; to: Policy }[];
	const policyCreates = [] as Policy[];
	const policyDeletes = [] as Policy[];

	for (const entry of policiesDiffGrouped) {
		const { renamedOrMoved, created, deleted } = await policyResolver({
			created: entry.inserted,
			deleted: entry.deleted,
		});

		policyCreates.push(...created);
		policyDeletes.push(...deleted);
		policyRenames.push(...renamedOrMoved);
	}

	for (const rename of policyRenames) {
		applyRename(rename.from, { name: rename.to.name, schema: rename.to.schema });
	}

	const viewsDiff = diff(ddl1, ddl2, 'views');

	const { created: createdViews, deleted: deletedViews, renamedOrMoved: renamedOrMovedViews } = await viewsResolver({
		created: viewsDiff.filter((it) => it.$diffType === 'create'),
		deleted: viewsDiff.filter((it) => it.$diffType === 'drop'),
	});

	const renamedViews = renamedOrMovedViews.filter((it) => it.from.name !== it.to.name);
	const movedViews = renamedOrMovedViews.filter((it) => it.from.schema !== it.to.schema);

	for (const it of renamedOrMovedViews) {
		applyRename(it.from, { name: it.to.name, schema: it.to.schema });
	}

	// After the renames of schemas, tables and views, so that a privilege follows a renamed object and is not
	// revoked and granted again.
	const privilegesDiff = diff(ddl1, ddl2, 'privileges');
	const createdPrivileges = privilegesDiff.filter((it) => it.$diffType === 'create');
	const deletedPrivileges = privilegesDiff.filter((it) => it.$diffType === 'drop');

	// A function, a trigger or an extension is never renamed: a new name is a drop and a create. The diffs run
	// after the renames of schemas and tables, so a trigger follows its renamed table.
	const functionsDiff = diff(ddl1, ddl2, 'functions');
	const createdFunctions = functionsDiff.filter((it) => it.$diffType === 'create');
	const deletedFunctions = functionsDiff.filter((it) => it.$diffType === 'drop');
	const triggersDiff = diff(ddl1, ddl2, 'triggers');
	const createdTriggers = triggersDiff.filter((it) => it.$diffType === 'create');
	const deletedTriggers = triggersDiff.filter((it) => it.$diffType === 'drop');
	const extensionsDiff = diff(ddl1, ddl2, 'extensions');
	const createdExtensions = extensionsDiff.filter((it) => it.$diffType === 'create');
	const deletedExtensions = extensionsDiff.filter((it) => it.$diffType === 'drop');

	// Copies the role order of `ddl1` into a policy of `ddl2` that has the same roles in another order. The
	// order has no meaning in SQL, and a role rename can change it. Without the copy, the snapshot would store
	// a change of the whole `roles` list, and that change would overwrite a role rename of another branch.
	for (const { schema, table, name, roles } of ddl2.policies.list()) {
		const old = ddl1.policies.one({ schema, table, name });
		if (!old || old.roles.length !== roles.length) continue;
		const [before, after] = [[...old.roles].sort(), [...roles].sort()];
		if (before.every((role, idx) => role === after[idx])) {
			ddl2.policies.update({ set: { roles: [...old.roles] }, where: { schema, table, name } });
		}
	}

	const all = diff.all(ddl1, ddl2);
	// `delta(ddl1, ddl2, all)` must run here, because the statement code below deletes fields from the alter
	// rows of `all`.
	const deltas: Delta[] = [...renameDeltas, ...delta(ddl1, ddl2, all)];
	const alters = all.filter((it): it is Extract<typeof it, { $diffType: 'alter' }> => it.$diffType === 'alter');

	const jsonStatements: JsonStatement[] = [];

	/*
		with new DDL when table gets created with constraints, etc.
		or existing table with constraints and indexes gets deleted,
		those entites are treated by diff as newly created or deleted

		we filter them out, because we either create them on table creation
		or they get automatically deleted when table is deleted
	*/
	const tablesFilter = (type: 'deleted' | 'created') => {
		return (it: { schema: string; table: string }) => {
			if (type === 'created') {
				return !createdTables.some((t) => t.schema === it.schema && t.name === it.table);
			} else {
				return !deletedTables.some((t) => t.schema === it.schema && t.name === it.table);
			}
		};
	};

	const jsonCreateIndexes = indexesCreates.map((index) => prepareStatement('create_index', { index }));
	const jsonDropIndexes = indexesDeletes.filter(tablesFilter('deleted')).map((index) =>
		prepareStatement('drop_index', { index })
	);

	const jsonRenameIndexes = indexesRenames.map((r) => {
		return prepareStatement('rename_index', {
			schema: r.to.schema,
			table: r.to.table,
			from: r.from.name,
			to: r.to.name,
			columns: (r.to.columns ?? []).filter((c) => !c.isExpression).map((c) => c.value),
		});
	});

	const indexesAlters = alters.filter((it): it is DiffEntities['indexes'] => {
		if (it.entityType !== 'indexes' || it.$left.table !== it.$right.table) return false;

		delete it.concurrently;
		// the options as Postgres stores them: a quoted value and the same value unquoted are one option
		if (it.with && sameIndexOptions(it.with.from, it.with.to)) delete it.with;

		return ddl2.indexes.hasDiff(it);
	});

	const jsonRecreateIndex: JsonRecreateIndex[] = [];
	for (const idx of indexesAlters) {
		const forWhere = !!idx.where && (idx.where.from !== null && idx.where.to !== null ? mode !== 'push' : true);
		const forColumns = !!idx.columns && (idx.columns.from.length === idx.columns.to.length ? mode !== 'push' : true);

		if (idx.isUnique || idx.concurrently || idx.method || idx.with || forColumns || forWhere) {
			const index = ddl2.indexes.one({ schema: idx.schema, table: idx.table, name: idx.name })!;

			// when a column used by the index is being dropped, emit a plain drop_index instead of recreate
			const prevIndex = ddl1.indexes.one({ schema: idx.schema, table: idx.table, name: idx.name });
			const shouldDrop = !!prevIndex
				&& !columnsToDelete.some((col) =>
					col.schema === idx.schema
					&& col.table === idx.table
					&& prevIndex.columns.some((idxCol) => idxCol.value === col.name)
				);

			if (!shouldDrop) {
				jsonCreateIndexes.push(prepareStatement('create_index', { index }));
				continue;
			}

			jsonRecreateIndex.push(prepareStatement('recreate_index', { index, diff: idx }));
		}
	}

	const jsonDropTables = deletedTables.map((it) => {
		const oldSchema = renamedSchemas.find((x) => x.to.name === it.schema);
		const key = oldSchema ? `"${oldSchema.from.name}"."${it.name}"` : `"${it.schema}"."${it.name}"`;
		return prepareStatement('drop_table', { table: tableFromDDL(it, ddl2), key });
	});
	const jsonRenameTables = renamedTables.map((it) =>
		prepareStatement('rename_table', {
			schema: it.from.schema,
			from: it.from.name,
			to: it.to.name,
		})
	);

	const jsonRenameColumnsStatements = columnRenames.map((it) => prepareStatement('rename_column', it));
	const jsonDropColumnsStatemets = columnsToDelete.filter(tablesFilter('deleted')).map((it) =>
		prepareStatement('drop_column', { column: it })
	);
	const jsonAddColumnsStatemets = columnsToCreate.filter(tablesFilter('created')).map((it) =>
		prepareStatement('add_column', {
			column: it,
			// if pk existed before and new column now has pk, this will trigger alter_pk, that will automatically add pk
			// this flag is needed for column recreation (generated)
			// see tests: "drizzle-kit/tests/postgres/pg-constraints.test.ts" => "remove/add pk" and below
			isPK: false, // ddl2.pks.one({ schema: it.schema, table: it.table, columns: [it.name] }) !== null,
			isCompositePK: ddl2.pks.one({ schema: it.schema, table: it.table, columns: { CONTAINS: it.name } }) !== null,
		})
	);

	const columnAlters = alters.filter((it) => it.entityType === 'columns').filter((it) => {
		if (
			it.default
			&& ((it.$left.type === 'json' && it.$right.type === 'json')
				|| (it.$left.type === 'jsonb' && it.$right.type === 'jsonb'))
		) {
			if (it.default.from !== null && it.default.to !== null) {
				const parsedLeft = parse(trimChar(it.default.from, "'"));
				const parsedRight = parse(trimChar(it.default.to, "'"));

				try {
					deepStrictEqual(parsedLeft, parsedRight);
					delete it.default;
				} catch {}

				// const left = stringify(parsedLeft);
				// const right = stringify(parsedRight);

				// if (left === right) {
				// 	delete it.default;
				// }
			}
		}

		if (!it.type && it.default && defaultsCommutative(it.default, it.$right.type, it.$right.dimensions)) {
			delete it.default;
		}

		// commutative types
		if (it.type) {
			if (
				it.type.from === it.type.to.replace('numeric', 'decimal')
				|| it.type.to === it.type.from.replace('numeric', 'decimal')
			) {
				delete it.type;
			}
		}

		// PostGIS types: casing, SRID 0 and the implicit geography SRID do not make a diff
		if (it.type && normalizePostgisType(it.type.from) === normalizePostgisType(it.type.to)) {
			delete it.type;
		}

		// numeric(19) === numeric(19,0)
		if (it.type && it.type.from.replace(',0)', ')') === it.type.to) {
			delete it.type;
		}

		// Ignores a change of only `typeSchema` when one state has no schema, because a snapshot of an older
		// format can store no schema for the enum of a column.
		if (!it.type && it.typeSchema && (it.typeSchema.from === null || it.typeSchema.to === null)) {
			delete it.typeSchema;
		}

		// Push ignores a change between two counts of array dimensions. Postgres uses the same type for every
		// count, and its catalog shows 0 for a column of a partition, of an inherited table and of a table from
		// CREATE TABLE AS.
		if (mode === 'push' && it.dimensions && it.dimensions.from > 0 && it.dimensions.to > 0) {
			delete it.dimensions;
		}

		return ddl2.columns.hasDiff(it);
	});

	const alteredUniques = alters.filter((it) => it.entityType === 'uniques').filter((it) => {
		if (it.nameExplicit) {
			delete it.nameExplicit;
		}

		return ddl2.uniques.hasDiff(it);
	});

	const jsonAlteredUniqueConstraints = alteredUniques.map((it) => prepareStatement('alter_unique', { diff: it }));

	const jsonAddedUniqueConstraints = uniqueCreates.filter(tablesFilter('created')).map((it) =>
		prepareStatement('add_unique', { unique: it })
	);

	const jsonDropUniqueConstraints = uniqueDeletes.filter(tablesFilter('deleted')).map((it) =>
		prepareStatement('drop_unique', { unique: it })
	);
	const jsonRenamedUniqueConstraints = uniqueRenames.map((it) =>
		prepareStatement('rename_constraint', {
			entityType: 'uniques',
			schema: it.to.schema,
			table: it.to.table,
			from: it.from.name,
			to: it.to.name,
			columns: it.to.columns ?? [],
		})
	);

	const jsonAddPrimaryKeys = pksCreates.filter(tablesFilter('created')).map((it) =>
		prepareStatement('add_pk', { pk: it })
	);

	const jsonDropPrimaryKeys = pksDeletes.filter(tablesFilter('deleted')).map((it) =>
		prepareStatement('drop_pk', { pk: it })
	);

	const jsonRenamePrimaryKey = pksRenames.map((it) => {
		return prepareStatement('rename_constraint', {
			entityType: 'pks',
			schema: it.to.schema,
			table: it.to.table,
			from: it.from.name,
			to: it.to.name,
			columns: it.to.columns ?? [],
		});
	});

	const jsonSetTableSchemas = movedTables.map((it) => {
		const ofTable = { schema: it.to.schema, table: it.to.name };
		return prepareStatement('move_table', {
			name: it.to.name, // rename of table comes first
			from: it.from.schema,
			to: it.to.schema,
			indexNames: [...ddl1.indexes.list(ofTable), ...ddl1.pks.list(ofTable), ...ddl1.uniques.list(ofTable)]
				.map((relation) => relation.name).sort(),
		});
	});

	// columns a check references, found by keeping only expression identifiers that
	// are real columns of the table (so a keyword/function is never mistaken for one)
	const checkColumns = (value: string, ddl: PostgresDDL, schema: string, table: string): string[] => {
		const names = new Set(ddl.columns.list({ schema, table }).map((c) => c.name));
		const found = new Set<string>();
		const re = /"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(value ?? '')) !== null) {
			const id = m[1] ?? m[2];
			if (names.has(id)) found.add(id);
		}
		return [...found];
	};
	const jsonCreatedCheckConstraints = checkCreates.filter(tablesFilter('created')).map((it) =>
		prepareStatement('add_check', { check: it, columns: checkColumns(it.value, ddl2, it.schema, it.table) })
	);
	const jsonDropCheckConstraints = checkDeletes.filter(tablesFilter('deleted')).map((it) =>
		prepareStatement('drop_check', { check: it, columns: checkColumns(it.value, ddl1, it.schema, it.table) })
	);
	const jsonRenamedCheckConstraints = checkRenames.map((it) =>
		prepareStatement('rename_constraint', {
			entityType: 'checks',
			schema: it.to.schema,
			table: it.to.table,
			from: it.from.name,
			to: it.to.name,
			columns: checkColumns(it.to.value, ddl2, it.to.schema, it.to.table),
		})
	);

	// group by tables?
	const alteredPKs = alters.filter((it) => it.entityType === 'pks').filter((it) => {
		return !!it.columns; // ignore explicit name change
	});

	const alteredChecks = alters.filter((it) => it.entityType === 'checks');
	const jsonAlteredPKs: JsonAlterPrimaryKey[] = alteredPKs.map((it) => {
		const deleted = columnsToDelete.some((x) => it.columns?.from.includes(x.name));

		return prepareStatement('alter_pk', { diff: it, pk: it.$right, deleted });
	});

	const jsonRecreateFKs = alters.filter((it) => it.entityType === 'fks').filter((x) => {
		if (x.nameExplicit) delete x.nameExplicit;

		return ddl2.fks.hasDiff(x);
	}).map((it) => prepareStatement('recreate_fk', { fk: it.$right, diff: it }));

	const jsonCreateFKs = fksCreates.map((it) => prepareStatement('create_fk', { fk: it }));

	const jsonDropFKs = fksDeletes.filter((fk) => {
		const fromDeletedTable = deletedTables.some((x) => x.schema === fk.schema && x.name === fk.table);
		const toDeletedTable = fk.table !== fk.tableTo
			&& deletedTables.some((x) => x.schema === fk.schemaTo && x.name === fk.tableTo);
		if (fromDeletedTable && !toDeletedTable) return false;
		return true;
	}).map((it) => prepareStatement('drop_fk', { fk: it }));

	const jsonAlterCheckConstraints = alteredChecks.filter((it) => it.value && mode !== 'push').map((it) =>
		prepareStatement('alter_check', {
			diff: it,
			newColumns: checkColumns(it.$right?.value ?? '', ddl2, it.schema, it.table),
			oldColumns: checkColumns(it.$left?.value ?? '', ddl2, it.schema, it.table),
		})
	);
	const jsonCreatePoliciesStatements = policyCreates.map((it) => prepareStatement('create_policy', { policy: it }));
	const jsonDropPoliciesStatements = policyDeletes.map((it) => prepareStatement('drop_policy', { policy: it }));
	const jsonRenamePoliciesStatements = policyRenames.map((it) => prepareStatement('rename_policy', it));

	const alteredPolicies = alters.filter((it) => it.entityType === 'policies').filter((it) => {
		if (it.withCheck && it.withCheck.from && it.withCheck.to) {
			if (it.withCheck.from === `(${it.withCheck.to})` || it.withCheck.to === `(${it.withCheck.from})`) {
				delete it.withCheck;
			}
		}
		return ddl1.policies.hasDiff(it);
	});

	// if I drop policy/ies, I should check if table only had this policy/ies and turn off
	// for non explicit rls =

	// using/withcheck in policy is a SQL expression which can be formatted by database in a different way,
	// thus triggering recreations/alternations on push
	const jsonAlterOrRecreatePoliciesStatements = alteredPolicies.filter((it) => {
		return it.as || it.for || it.roles || !((it.using || it.withCheck) && mode === 'push');
	}).map(
		(it) => {
			const to = ddl2.policies.one({
				schema: it.schema,
				table: it.table,
				name: it.name,
			})!;
			if (it.for || it.as) {
				return prepareStatement('recreate_policy', {
					diff: it,
					policy: to,
				});
			} else {
				return prepareStatement('alter_policy', {
					diff: it,
					policy: to,
				});
			}
		},
	);

	// explicit rls alters
	const rlsAlters = alters.filter((it) => it.entityType === 'tables').filter((it) => it.isRlsEnabled);

	const jsonAlterRlsStatements = rlsAlters.map((it) =>
		prepareStatement('alter_rls', {
			schema: it.schema,
			name: it.name,
			isRlsEnabled: it.isRlsEnabled?.to || false,
		})
	);

	for (const it of policyDeletes) {
		if (rlsAlters.some((alter) => alter.schema === it.schema && alter.name === it.table)) continue; // skip for explicit

		const had = ddl1.policies.list({ schema: it.schema, table: it.table }).length;
		const has = ddl2.policies.list({ schema: it.schema, table: it.table }).length;

		const prevTable = ddl1.tables.one({ schema: it.schema, name: it.table });
		const table = ddl2.tables.one({ schema: it.schema, name: it.table });

		// I don't want dedup here, not a valuable optimisation
		if (
			table !== null // not external table
			&& (had > 0 && has === 0 && prevTable && prevTable.isRlsEnabled === false)
			&& !jsonAlterRlsStatements.some((st) => st.schema === it.schema && st.name === it.table)
		) {
			jsonAlterRlsStatements.push(prepareStatement('alter_rls', {
				schema: it.schema,
				name: it.table,
				isRlsEnabled: false,
			}));
		}
	}

	for (const it of policyCreates) {
		if (rlsAlters.some((alter) => alter.schema === it.schema && alter.name === it.table)) continue; // skip for explicit
		if (createdTables.some((t) => t.schema === it.schema && t.name === it.table)) continue; // skip for created tables
		if (jsonAlterRlsStatements.some((st) => st.schema === it.schema && st.name === it.table)) continue; // skip for existing rls toggles

		const had = ddl1.policies.list({ schema: it.schema, table: it.table }).length;
		const has = ddl2.policies.list({ schema: it.schema, table: it.table }).length;

		const table = ddl2.tables.one({ schema: it.schema, name: it.table });

		if (
			table !== null // not external table
			&& (had === 0 && has > 0 && !table.isRlsEnabled)
		) {
			jsonAlterRlsStatements.push(prepareStatement('alter_rls', {
				schema: it.schema,
				name: it.table,
				isRlsEnabled: true,
			}));
		}
	}

	const jsonCreateEnums = createdEnums.map((it) => prepareStatement('create_enum', { enum: it }));
	const jsonDropEnums = deletedEnums.map((it) => prepareStatement('drop_enum', { enum: it }));
	const jsonMoveEnums = movedEnums.map((it) => prepareStatement('move_enum', it));
	const jsonRenameEnums = renamedEnums.map((it) =>
		prepareStatement('rename_enum', {
			schema: it.to.schema,
			from: it.from.name,
			to: it.to.name,
		})
	);
	const enumsAlters = alters.filter((it) => it.entityType === 'enums');

	const recreateEnums = [] as Extract<JsonStatement, { type: 'recreate_enum' }>[];
	const jsonAlterEnums = [] as Extract<JsonStatement, { type: 'alter_enum' }>[];

	for (const alter of enumsAlters) {
		const values = alter.values!;
		const res = diffStringArrays(values.from, values.to);
		const e = { ...alter, values: values.to };

		if (res.some((it) => it.type === 'removed')) {
			// recreate enum
			// Finds the columns of this enum. A snapshot of an older format can store no `typeSchema` for a
			// column, and then the same column in `ddl2` gives the schema if it has the same type name.
			const columns = ddl1.columns.list({ type: alter.name })
				.map((it) => {
					const c2 = ddl2.columns.one({ schema: it.schema, table: it.table, name: it.name });
					if (c2 === null) return null;
					const typeSchema = it.typeSchema ?? (c2.type === it.type ? c2.typeSchema : null);
					if (typeSchema !== alter.schema) return null;

					const def = {
						right: c2.default,
						left: it.default,
					};
					return { ...it, typeSchema, default: def };
				})
				.filter((x) => x !== null);
			recreateEnums.push(prepareStatement('recreate_enum', { to: e, columns, from: alter.$left }));
		} else {
			jsonAlterEnums.push(prepareStatement('alter_enum', { diff: res, to: e, from: alter.$left }));
		}
	}

	const jsonAlterColumns = columnAlters.filter((it) => !(it.generated && it.generated.to !== null))
		.filter((it) => {
			// if column is of type enum we're about to recreate - we will reset default anyway
			if (
				it.default
				&& recreateEnums.some((x) =>
					x.columns.some((c) => it.schema === c.schema && it.table === c.table && it.name === c.name)
				)
			) {
				delete it.default;
			}

			if (it.notNull && it.notNull.to && (it.$right.generated || it.$right.identity)) {
				delete it.notNull;
			}

			const pkIn2 = ddl2.pks.one({ schema: it.schema, table: it.table, columns: { CONTAINS: it.name } });
			if (it.notNull && pkIn2) {
				delete it.notNull;
			}

			return ddl2.columns.hasDiff(it);
		})
		.map((it) => {
			const column = it.$right;
			const wasSerial = isSerialType(it.$left.type);
			const toSerial: boolean = !isSerialType(it.$left.type) && isSerialType(it.$right.type);
			const isEnum = ddl2.enums.one({ schema: column.typeSchema ?? 'public', name: column.type }) !== null;
			const wasEnum = !!(it.type || it.typeSchema || it.dimensions)
				&& ddl1.enums.one({ schema: it.$left.typeSchema ?? 'public', name: it.$left.type }) !== null;

			return prepareStatement('alter_column', {
				diff: it,
				to: column,
				isEnum,
				wasEnum,
				wasSerial,
				toSerial,
			});
		});

	const createSequences = createdSeqs.map((it) => prepareStatement('create_sequence', { sequence: it }));
	const dropSequences = deletedSeqs.map((it) => prepareStatement('drop_sequence', { sequence: it }));
	// The move runs first, so a sequence that also gets a new name is renamed in its new schema.
	const moveSequences = movedSequences.map((it) =>
		prepareStatement('move_sequence', { from: it.from, to: { ...it.to, name: it.from.name } })
	);
	const renameSequences = renamedSequences.map((it) =>
		prepareStatement('rename_sequence', { from: { ...it.from, schema: it.to.schema }, to: it.to })
	);
	const sequencesAlter = alters.filter((it) => it.entityType === 'sequences');
	const jsonAlterSequences = sequencesAlter.map((it) =>
		prepareStatement('alter_sequence', { diff: it, sequence: it.$right })
	);

	const jsonCreateRoles = createdRoles.map((it) => prepareStatement('create_role', { role: it }));
	const jsonDropRoles = deletedRoles.map((it) => prepareStatement('drop_role', { role: it }));
	const jsonRenameRoles = renamedRoles.map((it) => prepareStatement('rename_role', it));
	const jsonAlterRoles = alters.filter((it) => it.entityType === 'roles').map((it) =>
		prepareStatement('alter_role', { diff: it, role: it.$right })
	);

	const jsonGrantPrivileges = createdPrivileges.map((it) => prepareStatement('grant_privilege', { privilege: it }));
	// a privilege on an object that is dropped goes with the object
	const jsonRevokePrivileges = deletedPrivileges
		.filter((it) =>
			it.table === null
				? it.schema === 'public' || ddl2.schemas.one({ name: it.schema })
				: ddl2.tables.one({ schema: it.schema, name: it.table })
					|| ddl2.views.one({ schema: it.schema, name: it.table })
		)
		.map((it) => prepareStatement('revoke_privilege', { privilege: it }));
	const jsonAlterPrivileges = alters.filter((it) => it.entityType === 'privileges').map((it) =>
		prepareStatement('regrant_privilege', { privilege: it.$right, diff: it })
	);

	/*
		A function whose body, attributes or comment changed is replaced in
		place; one whose signature changed (its parameters, its return type or
		its language) is dropped and created again, since `CREATE OR REPLACE`
		cannot change a signature. Postgres refuses to drop a function that a
		trigger, an index or a view depends on, so those are dropped before it
		and created after it: the triggers that call it, the indexes whose
		expression calls it, and the views whose definition calls it, which
		join the views to recreate below and take their dependents with them.
	*/
	const functionAlters = alters.filter((it): it is DiffEntities['functions'] => it.entityType === 'functions');
	const signatureChanged = (it: DiffEntities['functions']) => !!(it.args || it.returns || it.language);
	const functionsToRecreate = functionAlters.filter(signatureChanged).map((it) => ({ from: it.$left, to: it.$right }));
	const recreatedFunction = (fn: { schema: string; name: string }) =>
		functionsToRecreate.some((r) => r.to.schema === fn.schema && r.to.name === fn.name);

	const jsonReplaceFunctions = functionAlters
		.filter((it) => !signatureChanged(it) && (it.body || it.attributes))
		.map((it) => prepareStatement('replace_function', { function: it.$right, from: it.$left }));
	const jsonCommentFunctions = functionAlters
		.filter((it) => !signatureChanged(it) && !it.body && !it.attributes && it.comment)
		.map((it) => prepareStatement('comment_function', { function: it.$right }));

	// created in the order the schema declares them, since a SQL body is checked when its function is created, and dropped in the reverse
	const isNewFunction = (fn: Function) =>
		createdFunctions.some((c) => c.schema === fn.schema && c.name === fn.name) || recreatedFunction(fn);
	const jsonCreateFunctions = ddl2.functions.list().filter(isNewFunction).map((it) =>
		prepareStatement('create_function', { function: it })
	);
	const jsonDropFunctions = ddl1.functions
		.list()
		.filter((it) => deletedFunctions.some((d) => d.schema === it.schema && d.name === it.name) || recreatedFunction(it))
		.reverse()
		.map((it) =>
			prepareStatement('drop_function', {
				function: it,
				cause: functionsToRecreate.find((r) => r.from.schema === it.schema && r.from.name === it.name)?.to ?? null,
			})
		);

	const triggerAlters = alters.filter((it): it is DiffEntities['triggers'] => it.entityType === 'triggers');
	const sameTrigger = (a: Trigger, b: Trigger) => a.schema === b.schema && a.table === b.table && a.name === b.name;
	// a trigger that calls a function that is dropped, whether for good or to be created again, is dropped before it and created again after it when the schema still declares it
	const goneFunctions = new Set(
		[...deletedFunctions, ...functionsToRecreate.map((r) => r.from)].map((fn) => `${fn.schema}.${fn.name}`),
	);
	const triggersToDrop = ddl1.triggers.list().filter((it) =>
		goneFunctions.has(`${it.functionSchema}.${it.functionName}`) && !deletedTriggers.some((d) => sameTrigger(d, it))
	);
	const droppedTrigger = (it: Trigger) => triggersToDrop.some((d) => sameTrigger(d, it));
	// a trigger on a dropped table goes with the table
	const jsonDropTriggers = [
		...deletedTriggers
			.filter((it) => ddl2.tables.one({ schema: it.schema, name: it.table }))
			.map((it) => prepareStatement('drop_trigger', { trigger: it })),
		...triggersToDrop.map((it) => prepareStatement('drop_trigger', { trigger: it })),
	];
	const jsonCreateTriggers = [
		...createdTriggers.map((it) => prepareStatement('create_trigger', { trigger: it, from: null })),
		...triggerAlters.map((it) =>
			prepareStatement('create_trigger', { trigger: it.$right, from: droppedTrigger(it.$left) ? null : it.$left })
		),
		...ddl2.triggers
			.list()
			.filter((it) =>
				droppedTrigger(it)
				&& !createdTriggers.some((c) => sameTrigger(c, it))
				&& !triggerAlters.some((a) => sameTrigger(a.$right, it))
			)
			.map((it) => prepareStatement('create_trigger', { trigger: it, from: null })),
	];

	/*
		An extension is altered (`ALTER EXTENSION ... UPDATE TO`, `SET
		SCHEMA`) when its declared version or schema differs from what
		stands: a declaration without one accepts whatever the database has
		(an introspected extension always reports both), and `cascade` says
		how to create it, not what it is. On a push, an extension the schema
		does not declare is left alone: it may be an operator's, or one
		another extension requires, and dropping it is not what a schema that
		says nothing about it asks for.
	*/
	const stated = (field: 'version' | 'namespace', it: DiffEntities['extensions']) =>
		!!it[field] && it.$right[field] !== null && it.$right[field] !== it.$left[field];
	const extensionAlters = alters
		.filter((it): it is DiffEntities['extensions'] => it.entityType === 'extensions')
		.filter((it) => stated('version', it) || stated('namespace', it));
	const jsonCreateExtensions = [
		...createdExtensions.map((it) => prepareStatement('create_extension', { extension: it })),
		...extensionAlters.map((it) => prepareStatement('alter_extension', { extension: it.$right, from: it.$left })),
	];
	const jsonDropExtensions = (mode === 'push' ? [] : deletedExtensions).map((it) =>
		prepareStatement('drop_extension', { extension: it })
	);

	const createSchemas = createdSchemas.map((it) => prepareStatement('create_schema', it));
	const dropSchemas = deletedSchemas.map((it) => prepareStatement('drop_schema', it));
	const renameSchemas = renamedSchemas.map((it) => prepareStatement('rename_schema', it));

	const createTables = createdTables.map((it) => prepareStatement('create_table', { table: tableFromDDL(it, ddl2) }));

	const createViews = createdViews.map((it) => prepareStatement('create_view', { view: it }));

	const jsonDropViews = deletedViews.map((it) => prepareStatement('drop_view', { view: it, cause: null }));

	const jsonReplaceViews: Extract<JsonStatement, { type: 'replace_view' }>[] = [];

	// The rename runs first, so a view that also moves is renamed in its old schema.
	const jsonRenameViews = renamedViews.map((it) =>
		prepareStatement('rename_view', { from: it.from, to: { ...it.to, schema: it.from.schema } })
	);

	// The move uses the old `materialized`, because the view still has its old kind at the move. A view that
	// changes its kind is dropped and created later.
	const jsonMoveViews = movedViews.map((it) =>
		prepareStatement('move_view', {
			fromSchema: it.from.schema,
			toSchema: it.to.schema,
			view: { ...it.to, materialized: it.from.materialized },
		})
	);

	const filteredViewAlters = alters.filter((it): it is DiffEntities['views'] => {
		if (it.entityType !== 'views') return false;

		if (it.definition && mode === 'push') {
			delete it.definition;
		}

		// the columns are what the definition produces: they decide how a
		// changed definition is applied and are never a change of their own
		// (a snapshot written before they were recorded has none)
		if (!it.definition) {
			delete it.columns;
		}

		// default access method
		// from db -> heap,
		// drizzle schema -> null
		//
		// should work for push and generate since that is commutative
		// + when we introspect we recieve heap,
		if (it.using && !it.using.to && it.using.from === defaults.accessMethod) {
			delete it.using;
		}

		if (mode === 'push' && it.tablespace && it.tablespace.from === null && it.tablespace.to === defaults.tablespace) {
			delete it.tablespace;
		}

		return ddl2.views.hasDiff(it);
	});

	const viewsAlters = filteredViewAlters.map((it) => ({ diff: it, view: it.$right }));

	let jsonAlterViews = viewsAlters.filter((it) => !it.diff.definition && !it.diff.materialized).map((it) => {
		return prepareStatement('alter_view', {
			diff: it.diff,
			view: it.view,
		});
	});

	/*
		A changed definition is applied in place (`CREATE OR REPLACE VIEW`)
		when the new columns keep the old ones as a prefix, which is what
		Postgres accepts; the views that select from it and its privileges
		then stay as they are. Otherwise the view is dropped and created
		again, and so is every view that selects from it, since Postgres
		refuses to drop a view another one depends on: the dependents are
		dropped first and created last, in dependency order, and the
		privileges they lost with the drop are granted again.
	*/
	const viewsToRecreate: { from: View; to: View }[] = [];

	// The view in the old state, under its old schema and name.
	const originalView = (it: View): View => {
		const viewRename = renamedOrMovedViews.find((r) => r.to.schema === it.schema && r.to.name === it.name);
		const viewSchema = viewRename ? viewRename.from.schema : it.schema;
		const schemaRename = renamedSchemas.find((r) => r.to.name === viewSchema);
		const schema = schemaRename ? schemaRename.from.name : viewSchema;
		const name = viewRename ? viewRename.from.name : it.name;
		const from = ddl1Copy.views.one({ schema, name });

		if (!from) {
			throw new Error(`
				Missing view in original ddl:
				${it.schema}:${it.name}
				${schema}:${name}
				`);
		}
		return from;
	};

	viewsAlters.filter((it) => it.diff.definition || it.diff.materialized).forEach((entry) => {
		const it = entry.view;
		const from = originalView(it);

		const replaceable = !entry.diff.materialized && !it.materialized
			&& viewColumnsReplaceable(from.columns, it.columns);

		if (replaceable) {
			jsonReplaceViews.push(prepareStatement('replace_view', { view: it, from }));
			return;
		}

		viewsToRecreate.push({ from, to: it });
	});

	// a view whose definition calls a function that is dropped and created again is recreated with it
	for (const candidate of ddl2.views.list()) {
		if (createdViews.some((c) => c.schema === candidate.schema && c.name === candidate.name)) continue;
		if (viewsToRecreate.some((r) => r.to.schema === candidate.schema && r.to.name === candidate.name)) continue;
		if (!functionsToRecreate.some((r) => callsFunction(r.from, candidate.definition))) continue;
		viewsToRecreate.push({ from: originalView(candidate), to: candidate });
	}

	// the closure over the views that select from a recreated one
	const isCreated = (it: View) => createdViews.some((c) => c.schema === it.schema && c.name === it.name);
	for (let added = true; added;) {
		added = false;
		for (const candidate of ddl2.views.list()) {
			if (isCreated(candidate)) continue;
			if (viewsToRecreate.some((r) => r.to.schema === candidate.schema && r.to.name === candidate.name)) continue;
			if (!viewsToRecreate.some((r) => existsInViewDef(r.to, candidate))) continue;

			viewsToRecreate.push({ from: originalView(candidate), to: candidate });
			added = true;
		}
	}

	const recreated = (it: View) => viewsToRecreate.some((r) => r.to.schema === it.schema && r.to.name === it.name);
	for (let i = jsonReplaceViews.length - 1; i >= 0; i--) {
		if (recreated(jsonReplaceViews[i]!.view)) jsonReplaceViews.splice(i, 1);
	}
	jsonAlterViews = jsonAlterViews.filter((st) => !recreated(st.view));

	// dropped in the reverse of the order they are created in: what the views
	// select from now decides the order among views that were independent, and
	// what they selected from before, which is what the database still holds
	// when they are dropped, decides it where the two differ. The drops run
	// after the renames and moves of views, so a drop names the view by the
	// row of `ddl1`, which has the renames applied.
	const byNewDefinition = sortViewsByDependency(viewsToRecreate, (node, other) => existsInViewDef(other.to, node.to));
	const jsonDropRecreatedViews = sortViewsByDependency(
		byNewDefinition,
		(node, other) => existsInViewDef(other.from, node.from),
	)
		.reverse()
		.map(({ from, to }) => {
			const left = ddl1.views.one({ schema: to.schema, name: to.name }) ?? from;
			return prepareStatement('drop_view', { view: left, cause: from });
		});
	createViews.push(...viewsToRecreate.map((r) => prepareStatement('create_view', { view: r.to })));

	// DROP VIEW took the privileges on the view with it. A new privilege on the view is in
	// `jsonGrantPrivileges` already, so it is not granted twice.
	const isCreatedPrivilege = (it: Privilege) =>
		createdPrivileges.some((c) => ddl2.key('privileges', c) === ddl2.key('privileges', it));
	const jsonRegrantRecreatedViews = viewsToRecreate.flatMap((r) =>
		ddl2.privileges.list({ schema: r.to.schema, table: r.to.name }).filter((it) => !isCreatedPrivilege(it)).map((
			privilege,
		) => prepareStatement('grant_privilege', { privilege }))
	);

	// an index whose expression or predicate calls a function that is dropped and created again is recreated with it
	for (const index of ddl2.indexes.list()) {
		if (indexesCreates.some((c) => c.schema === index.schema && c.table === index.table && c.name === index.name)) {
			continue;
		}
		const calls = functionsToRecreate.some((r) =>
			index.columns.some((c) => c.isExpression && callsFunction(r.from, c.value)) || callsFunction(r.from, index.where)
		);
		if (!calls) continue;
		jsonDropIndexes.push(prepareStatement('drop_index', { index }));
		jsonCreateIndexes.push(prepareStatement('create_index', { index }));
	}

	const columnsToRecreate = columnAlters.filter((it) => it.generated && it.generated.to !== null).filter((it) => {
		// if push and definition changed
		return !(it.generated?.to && it.generated.from && mode === 'push');
	});

	const isSameFk = (a: ForeignKey, b: ForeignKey) => a.schema === b.schema && a.table === b.table && a.name === b.name;
	// Collects the foreign keys that must be dropped and created again with the recreated columns. A key can
	// use two recreated columns, so the list holds each key one time.
	const fksOfRecreatedColumns: ForeignKey[] = [];

	const jsonRecreateColumns = columnsToRecreate.map((it) => {
		const indexes = ddl2.indexes.list({ table: it.table, schema: it.schema }).filter((index) =>
			index.columns.some((column) => trimChar(column.value, '`') === it.name)
		);
		// `isListed` skips an index or a unique constraint that already has a create statement: a new one, or
		// one that uses two recreated columns and was found for the other column.
		for (const index of indexes) {
			const isListed = jsonCreateIndexes.some((it) => it.index.schema === index.schema && it.index.name === index.name);
			if (!isListed) jsonCreateIndexes.push({ type: 'create_index', index });
		}

		const uniques = ddl2.uniques.list({ table: it.table, schema: it.schema, columns: { CONTAINS: it.name } });
		for (const unique of uniques) {
			const isListed = jsonAddedUniqueConstraints.some(({ unique: other }) =>
				other.schema === unique.schema && other.table === unique.table && other.name === unique.name
			);
			if (!isListed) jsonAddedUniqueConstraints.push({ type: 'add_unique', unique });
		}

		// Not sure if anyone tries to add fk on generated column or from it, but still...
		const fksFrom = ddl2.fks.list({ table: it.table, schema: it.schema, columns: { CONTAINS: it.name } });
		const fksTo = ddl2.fks.list({ tableTo: it.table, schemaTo: it.schema, columnsTo: { CONTAINS: it.name } });
		for (const fk of [...fksFrom, ...fksTo]) {
			if (!fksOfRecreatedColumns.some((other) => isSameFk(other, fk))) fksOfRecreatedColumns.push(fk);
		}

		return prepareStatement('recreate_column', {
			diff: it,
			isPK: ddl2.pks.one({ schema: it.schema, table: it.table, columns: [it.name] }) !== null,
		});
	});

	for (const fk of fksOfRecreatedColumns) {
		// Skips a new foreign key, because it is not in the database yet and has its own create statement.
		if (fksCreates.some((created) => isSameFk(created, fk))) continue;
		// A renamed key is dropped with its old name (`rename.from`), because the drops of foreign keys run
		// before their renames. The create uses the new name.
		const rename = fksRenames.find((it) => isSameFk(it.to, fk));
		jsonDropFKs.push({ type: 'drop_fk', fk: rename?.from ?? fk });
		jsonCreateFKs.push({ type: 'create_fk', fk });
	}

	// Skips the rename of a key in `fksOfRecreatedColumns`, because the key is created again with its new name.
	const jsonRenameReferences = fksRenames.filter((it) => !fksOfRecreatedColumns.some((fk) => isSameFk(fk, it.to)))
		.map((it) =>
			prepareStatement('rename_constraint', {
				entityType: 'fks',
				schema: it.to.schema,
				table: it.to.table,
				from: it.from.name,
				to: it.to.name,
				columns: it.to.columns ?? [],
			})
		);

	jsonStatements.push(...createSchemas);
	jsonStatements.push(...renameSchemas);
	// an extension is created once the schema it is installed in exists, and before anything that may need its types
	jsonStatements.push(...jsonCreateExtensions);
	jsonStatements.push(...jsonCreateEnums);
	jsonStatements.push(...jsonMoveEnums);
	jsonStatements.push(...jsonRenameEnums);
	jsonStatements.push(...jsonAlterEnums);

	jsonStatements.push(...createSequences);
	jsonStatements.push(...moveSequences);
	jsonStatements.push(...renameSequences);
	jsonStatements.push(...jsonAlterSequences);

	jsonStatements.push(...jsonRenameRoles);
	jsonStatements.push(...jsonCreateRoles);
	jsonStatements.push(...jsonAlterRoles);

	jsonStatements.push(...jsonRevokePrivileges);

	jsonStatements.push(...createTables);

	jsonStatements.push(...jsonDropViews);
	jsonStatements.push(...jsonRenameViews);
	jsonStatements.push(...jsonMoveViews);
	// A drop in `jsonDropRecreatedViews` uses the new schema and name of the view, so it must run after the
	// renames and moves of views.
	jsonStatements.push(...jsonDropRecreatedViews);
	// a trigger is dropped before the function it calls, and before its table is renamed or dropped
	jsonStatements.push(...jsonDropTriggers);
	jsonStatements.push(...jsonAlterViews);

	jsonStatements.push(...jsonRenameTables);
	// `jsonDropTables` runs before `jsonSetTableSchemas`, because a move takes the indexes and constraints of
	// its table into the new schema, where a dropped table can still hold one of their names. `isMoved` puts
	// the policy and foreign key drops of a moved table after the moves, because they name the new schema.
	const isMoved = (it: { schema: string; table: string }) =>
		movedTables.some((moved) => moved.to.schema === it.schema && moved.to.name === it.table);
	jsonStatements.push(...jsonDropPoliciesStatements.filter((it) => !isMoved(it.policy))); // before drop tables
	jsonStatements.push(...jsonDropFKs.filter((it) => !isMoved(it.fk)));

	jsonStatements.push(...jsonDropTables);
	jsonStatements.push(...jsonSetTableSchemas);
	jsonStatements.push(...jsonDropPoliciesStatements.filter((it) => isMoved(it.policy)));
	jsonStatements.push(...jsonDropFKs.filter((it) => isMoved(it.fk)));
	jsonStatements.push(...jsonAlterRlsStatements);
	jsonStatements.push(...jsonRenameColumnsStatements);

	jsonStatements.push(...jsonDropUniqueConstraints);
	jsonStatements.push(...jsonDropCheckConstraints);
	jsonStatements.push(...jsonRenamedCheckConstraints);

	// TODO: ? will need to drop indexes before changing any columns in table
	// Then should go column alternations and then index creation
	jsonStatements.push(...jsonRenameIndexes);
	jsonStatements.push(...jsonDropIndexes);
	jsonStatements.push(...jsonDropPrimaryKeys);
	// a function is dropped once nothing depends on it: its triggers, the indexes and the views that call it are gone by now
	jsonStatements.push(...jsonDropFunctions);

	jsonStatements.push(...jsonRenameReferences);
	jsonStatements.push(...jsonAddColumnsStatemets);
	jsonStatements.push(...jsonAddPrimaryKeys);
	jsonStatements.push(...jsonRenamePrimaryKey);
	jsonStatements.push(...recreateEnums);
	jsonStatements.push(...jsonRecreateColumns);

	jsonStatements.push(...jsonDropColumnsStatemets);
	jsonStatements.push(...jsonAlteredPKs);
	jsonStatements.push(...jsonAlterColumns);

	// a function is created once the tables and columns its body reads exist, and before the indexes and views that call it
	jsonStatements.push(...jsonCreateFunctions);
	jsonStatements.push(...jsonReplaceFunctions);
	jsonStatements.push(...jsonCommentFunctions);

	jsonStatements.push(...jsonRecreateIndex);

	jsonStatements.push(...jsonRenamedUniqueConstraints);
	jsonStatements.push(...jsonAddedUniqueConstraints);
	jsonStatements.push(...jsonAlteredUniqueConstraints);
	jsonStatements.push(...jsonCreateIndexes); // above fks for uniqueness constraint to come first

	jsonStatements.push(...jsonCreateFKs);
	// A key in `fksOfRecreatedColumns` is already dropped and created with its new definition.
	jsonStatements.push(...jsonRecreateFKs.filter((it) => !fksOfRecreatedColumns.some((fk) => isSameFk(fk, it.fk))));

	jsonStatements.push(...jsonCreatedCheckConstraints);

	jsonStatements.push(...jsonAlterCheckConstraints);

	// Dependent views must be created after their dependencies, otherwise the migration breaks:
	// https://github.com/drizzle-team/drizzle-orm/issues/4520 and https://github.com/drizzle-team/drizzle-orm/issues/6176
	// A view is replaced after the tables and columns it selects from changed, and after a new view it now
	// selects from, so the replaces are sorted together with the creates.
	// The schema metadata gives the order when the new state comes from a drizzle schema. Without it (`push`
	// from a database state, `up`), the order comes from the view names in the definition text.
	const viewsToWrite = [...createViews, ...jsonReplaceViews];
	const sortedViews = $metadata
		? sortCreateViews(viewsToWrite, $metadata.viewDependencies)
		: sortViewsByDependency(viewsToWrite, (node, other) => existsInViewDef(other.view, node.view));
	jsonStatements.push(...sortedViews);

	// a privilege is granted once what it is granted on exists
	jsonStatements.push(...jsonGrantPrivileges);
	jsonStatements.push(...jsonAlterPrivileges);
	jsonStatements.push(...jsonRegrantRecreatedViews);

	// a trigger is created once its table and its function exist
	jsonStatements.push(...jsonCreateTriggers);

	jsonStatements.push(...jsonRenamePoliciesStatements);
	jsonStatements.push(...jsonCreatePoliciesStatements);
	jsonStatements.push(...jsonAlterOrRecreatePoliciesStatements);

	// `jsonDropRoles` runs after the policy statements, because Postgres refuses to drop a role that a policy
	// or a privilege still names.
	jsonStatements.push(...jsonDropRoles);

	jsonStatements.push(...jsonDropEnums);
	jsonStatements.push(...dropSequences);
	// an extension is dropped last, once nothing of the schema uses its types
	jsonStatements.push(...jsonDropExtensions);
	jsonStatements.push(...dropSchemas);

	// Puts on each statement that creates or changes a view, an index or a column the functions that its SQL calls.
	// The footprint of the statement reads their names, see `FunctionRef`.
	const functionsOfSchema = ddl2.functions.list();
	const columnTexts = (column: Column) => [column.default, column.generated?.as ?? null];
	const indexTexts = (index: Index) => [
		...index.columns.filter((column) => column.isExpression).map((column) => column.value),
		index.where,
	];
	for (const statement of jsonStatements) {
		let texts: (string | null)[];
		switch (statement.type) {
			case 'create_view':
			case 'replace_view':
				texts = [statement.view.definition];
				break;
			case 'create_index':
			case 'recreate_index':
				texts = indexTexts(statement.index);
				break;
			case 'create_table':
				texts = statement.table.columns.flatMap(columnTexts);
				break;
			case 'add_column':
				texts = columnTexts(statement.column);
				break;
			case 'alter_column':
				texts = columnTexts(statement.to);
				break;
			case 'recreate_column':
				texts = columnTexts(statement.diff.$right);
				break;
			default:
				continue;
		}
		const callees = functionsOfSchema
			.filter((fn) => texts.some((text) => callsFunction(fn, text)))
			.map(({ schema, name }) => ({ schema, name }));
		if (callees.length > 0) statement.callees = callees;
	}

	const { groupedStatements, sqlStatements } = fromJson(jsonStatements);

	return {
		statements: jsonStatements,
		sqlStatements,
		groupedStatements: groupedStatements,
		deltas,
	};
};

/**
 * The items in an order that puts each one after the items it depends on;
 * items that depend on nothing keep their order. Reversed, the order puts
 * each item before the ones that depend on it. A view depends on another
 * when the other's (schema-qualified) name appears in its definition, see
 * `existsInViewDef`. A cycle, which Postgres would not have accepted, is
 * broken where it is found.
 */
export const sortViewsByDependency = <T>(items: T[], dependsOn: (node: T, other: T) => boolean): T[] => {
	const sorted: T[] = [];
	const visited = new Set<T>();
	const onStack = new Set<T>();
	const visit = (node: T) => {
		if (visited.has(node) || onStack.has(node)) return;
		onStack.add(node);
		for (const other of items) {
			if (other !== node && dependsOn(node, other)) visit(other);
		}
		onStack.delete(node);
		visited.add(node);
		sorted.push(node);
	};
	for (const node of items) visit(node);
	return sorted;
};
