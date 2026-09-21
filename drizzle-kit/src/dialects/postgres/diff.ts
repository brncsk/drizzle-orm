import { prepareMigrationRenames, trimChar } from '../../utils';
import { mockResolver } from '../../utils/mocks';
import { deepStrictEqual } from '../../utils/node-assert/deep-strict-equal';
import { diffStringArrays } from '../../utils/sequence-matcher';
import { parse } from '../../utils/when-json-met-bigint';
import type { Resolver } from '../common';
import { diff } from '../dialect';
import { groupDiffs, preserveEntityNames } from '../utils';
import { fromJson } from './convertor';
import type {
	CheckConstraint,
	Column,
	DiffEntities,
	Enum,
	ForeignKey,
	Function,
	Index,
	IndexColumn,
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
	viewColumnsReplaceable,
} from './grammar';
import type { JsonAlterPrimaryKey, JsonRecreateIndex, JsonStatement } from './statements';
import { prepareStatement } from './statements';

export const ddlDiffDry = async (ddlFrom: PostgresDDL, ddlTo: PostgresDDL, mode: 'default' | 'push') => {
	const mocks = new Set<string>();
	return ddlDiff(
		ddlFrom,
		ddlTo,
		mockResolver(mocks),
		mockResolver(mocks),
		mockResolver(mocks),
		mockResolver(mocks),
		mockResolver(mocks),
		mockResolver(mocks),
		mockResolver(mocks),
		mockResolver(mocks),
		mockResolver(mocks),
		mockResolver(mocks),
		mockResolver(mocks),
		mockResolver(mocks),
		mockResolver(mocks),
		mockResolver(mocks),
		mode,
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
	privilegesResolver: Resolver<Privilege>,
	tablesResolver: Resolver<PostgresEntities['tables']>,
	columnsResolver: Resolver<Column>,
	viewsResolver: Resolver<View>,
	uniquesResolver: Resolver<UniqueConstraint>,
	indexesResolver: Resolver<Index>,
	checksResolver: Resolver<CheckConstraint>,
	pksResolver: Resolver<PrimaryKey>,
	fksResolver: Resolver<ForeignKey>,
	mode: 'default' | 'push',
): Promise<{
	statements: JsonStatement[];
	sqlStatements: string[];
	groupedStatements: { jsonStatement: JsonStatement; sqlStatements: string[] }[];
	renames: string[];
}> => {
	const ddl1Copy = createDDL();
	for (const entity of ddl1.entities.list()) {
		ddl1Copy.entities.push(entity);
	}

	const schemasDiff = diff(ddl1, ddl2, 'schemas');
	const {
		created: createdSchemas,
		deleted: deletedSchemas,
		renamedOrMoved: renamedSchemas,
	} = await schemasResolver({
		created: schemasDiff.filter((it) => it.$diffType === 'create'),
		deleted: schemasDiff.filter((it) => it.$diffType === 'drop'),
	});

	for (const rename of renamedSchemas) {
		ddl1.entities.update({
			set: {
				schema: rename.to.name,
			},
			where: {
				schema: rename.from.name,
			},
		});

		ddl1.fks.update({
			set: {
				schemaTo: rename.to.name,
			},
			where: {
				schemaTo: rename.from.name,
			},
		});
	}

	const enumsDiff = diff(ddl1, ddl2, 'enums');
	const {
		created: createdEnums,
		deleted: deletedEnums,
		renamedOrMoved: renamedOrMovedEnums,
	} = await enumsResolver({
		created: enumsDiff.filter((it) => it.$diffType === 'create'),
		deleted: enumsDiff.filter((it) => it.$diffType === 'drop'),
	});

	const renamedEnums = renamedOrMovedEnums.filter((it) => it.from.name !== it.to.name);
	const movedEnums = renamedOrMovedEnums.filter((it) => it.from.schema !== it.to.schema);

	for (const rename of renamedEnums) {
		ddl1.enums.update({
			set: {
				name: rename.to.name,
				schema: rename.to.schema,
			},
			where: {
				name: rename.from.name,
				schema: rename.from.schema,
			},
		});
		ddl1.columns.update({
			set: {
				type: rename.to.name,
				typeSchema: rename.to.schema,
			},
			where: {
				type: rename.from.name,
				typeSchema: rename.from.schema,
			},
		});
	}
	for (const move of movedEnums) {
		ddl1.enums.update({
			set: {
				schema: move.to.schema,
			},
			where: {
				name: move.from.name,
				schema: move.from.schema,
			},
		});
		ddl1.columns.update({
			set: {
				typeSchema: move.to.schema,
			},
			where: {
				type: move.from.name,
				typeSchema: move.from.schema,
			},
		});
	}

	const sequencesDiff = diff(ddl1, ddl2, 'sequences');
	const {
		created: createdSequences,
		deleted: deletedSequences,
		renamedOrMoved: renamedOrMovedSequences,
	} = await sequencesResolver({
		created: sequencesDiff.filter((it) => it.$diffType === 'create'),
		deleted: sequencesDiff.filter((it) => it.$diffType === 'drop'),
	});

	const renamedSequences = renamedOrMovedSequences.filter((it) => it.from.schema === it.to.schema);
	const movedSequences = renamedOrMovedSequences.filter((it) => it.from.schema !== it.to.schema);

	for (const rename of renamedSequences) {
		ddl1.sequences.update({
			set: {
				name: rename.to.name,
				schema: rename.to.schema,
			},
			where: {
				name: rename.from.name,
				schema: rename.from.schema,
			},
		});
	}

	for (const move of movedSequences) {
		ddl1.sequences.update({
			set: {
				schema: move.to.schema,
			},
			where: {
				name: move.from.name,
				schema: move.from.schema,
			},
		});
	}

	const rolesDiff = diff(ddl1, ddl2, 'roles');
	const {
		created: createdRoles,
		deleted: deletedRoles,
		renamedOrMoved: renamedRoles,
	} = await roleResolver({
		created: rolesDiff.filter((it) => it.$diffType === 'create'),
		deleted: rolesDiff.filter((it) => it.$diffType === 'drop'),
	});
	for (const rename of renamedRoles) {
		ddl1.roles.update({
			set: {
				name: rename.to.name,
			},
			where: {
				name: rename.from.name,
			},
		});
	}

	const privilegesDiff = diff(ddl1, ddl2, 'privileges');
	const {
		created: createdPrivileges,
		deleted: deletedPrivileges,
	} = await privilegesResolver({
		created: privilegesDiff.filter((it) => it.$diffType === 'create'),
		deleted: privilegesDiff.filter((it) => it.$diffType === 'drop'),
	});

	// a function, a trigger or an extension is never renamed: a new name is a drop and a create
	const functionsDiff = diff(ddl1, ddl2, 'functions');
	const createdFunctions = functionsDiff.filter((it) => it.$diffType === 'create');
	const deletedFunctions = functionsDiff.filter((it) => it.$diffType === 'drop');
	const triggersDiff = diff(ddl1, ddl2, 'triggers');
	const createdTriggers = triggersDiff.filter((it) => it.$diffType === 'create');
	const deletedTriggers = triggersDiff.filter((it) => it.$diffType === 'drop');
	const extensionsDiff = diff(ddl1, ddl2, 'extensions');
	const createdExtensions = extensionsDiff.filter((it) => it.$diffType === 'create');
	const deletedExtensions = extensionsDiff.filter((it) => it.$diffType === 'drop');

	const tablesDiff = diff(ddl1, ddl2, 'tables');
	const {
		created: createdTables,
		deleted: deletedTables,
		renamedOrMoved: renamedOrMovedTables,
	} = await tablesResolver({
		created: tablesDiff.filter((it) => it.$diffType === 'create'),
		deleted: tablesDiff.filter((it) => it.$diffType === 'drop'),
	});

	const renamedTables = renamedOrMovedTables.filter((it) => it.from.name !== it.to.name);
	const movedTables = renamedOrMovedTables.filter((it) => it.from.schema !== it.to.schema);

	for (const rename of renamedOrMovedTables) {
		ddl1.tables.update({
			set: {
				name: rename.to.name,
				schema: rename.to.schema,
			},
			where: {
				name: rename.from.name,
				schema: rename.from.schema,
			},
		});

		ddl1.fks.update({
			set: {
				schemaTo: rename.to.schema,
				tableTo: rename.to.name,
			},
			where: {
				schemaTo: rename.from.schema,
				tableTo: rename.from.name,
			},
		});
		ddl2.fks.update({
			set: {
				schemaTo: rename.to.schema,
				tableTo: rename.to.name,
			},
			where: {
				schemaTo: rename.from.schema,
				tableTo: rename.from.name,
			},
		});

		ddl1.fks.update({
			set: {
				schema: rename.to.schema,
				table: rename.to.name,
			},
			where: {
				schema: rename.from.schema,
				table: rename.from.name,
			},
		});

		ddl1.entities.update({
			set: {
				table: rename.to.name,
				schema: rename.to.schema,
			},
			where: {
				table: rename.from.name,
				schema: rename.from.schema,
			},
		});

		ddl2.entities.update({
			set: {
				table: rename.to.name,
				schema: rename.to.schema,
			},
			where: {
				table: rename.from.name,
				schema: rename.from.schema,
			},
		});
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
		ddl1.columns.update({
			set: {
				name: rename.to.name,
				schema: rename.to.schema,
			},
			where: {
				name: rename.from.name,
				schema: rename.from.schema,
			},
		});

		// DDL2 updates are needed for Drizzle Studio
		const update1 = {
			set: {
				columns: (it: IndexColumn) => {
					if (!it.isExpression && it.value === rename.from.name) {
						return { ...it, value: rename.to.name };
					}
					return it;
				},
			},
			where: {
				schema: rename.from.schema,
				table: rename.from.table,
			},
		} as const;
		ddl1.indexes.update(update1);
		ddl2.indexes.update(update1);

		const update2 = {
			set: {
				columns: (it: string) => {
					return it === rename.from.name ? rename.to.name : it;
				},
			},
			where: {
				schema: rename.from.schema,
				table: rename.from.table,
			},
		} as const;
		ddl1.pks.update(update2);
		ddl2.pks.update(update2);

		const update3 = {
			set: {
				columns: (it: string) => {
					return it === rename.from.name ? rename.to.name : it;
				},
			},
			where: {
				schema: rename.from.schema,
				table: rename.from.table,
			},
		} as const;
		ddl1.fks.update(update3);
		ddl2.fks.update(update3);

		const update4 = {
			set: {
				columnsTo: (it: string) => {
					return it === rename.from.name ? rename.to.name : it;
				},
			},
			where: {
				schemaTo: rename.from.schema,
				tableTo: rename.from.table,
			},
		} as const;
		ddl1.fks.update(update4);
		ddl2.fks.update(update4);

		const update5 = {
			set: {
				columns: (it: string) => {
					return it === rename.from.name ? rename.to.name : it;
				},
			},
			where: {
				schema: rename.from.schema,
				table: rename.from.table,
			},
		} as const;
		ddl1.uniques.update(update5);
		ddl2.uniques.update(update5);

		const update6 = {
			set: {
				value: rename.to.name,
			},
			where: {
				schema: rename.from.schema,
				table: rename.from.table,
				value: rename.from.name,
			},
		} as const;
		ddl1.checks.update(update6);
		ddl2.checks.update(update6);
	}

	preserveEntityNames(ddl1.uniques, ddl2.uniques, mode);
	preserveEntityNames(ddl1.fks, ddl2.fks, mode);
	preserveEntityNames(ddl1.pks, ddl2.pks, mode);
	preserveEntityNames(ddl1.indexes, ddl2.indexes, mode);

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
		ddl1.uniques.update({
			set: {
				name: rename.to.name,
				schema: rename.to.schema,
			},
			where: {
				name: rename.from.name,
				schema: rename.from.schema,
			},
		});
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
		ddl1.checks.update({
			set: {
				name: rename.to.name,
				schema: rename.to.schema,
			},
			where: {
				name: rename.from.name,
				schema: rename.from.schema,
			},
		});
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

	for (const rename of indexesRenames) {
		ddl1.indexes.update({
			set: {
				name: rename.to.name,
				schema: rename.to.schema,
			},
			where: {
				name: rename.from.name,
				schema: rename.from.schema,
			},
		});
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
		ddl1.pks.update({
			set: {
				name: rename.to.name,
				schema: rename.to.schema,
			},
			where: {
				name: rename.from.name,
				schema: rename.from.schema,
			},
		});
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
		ddl1.fks.update({
			set: {
				name: rename.to.name,
				schema: rename.to.schema,
			},
			where: {
				name: rename.from.name,
				schema: rename.from.schema,
			},
		});
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
		ddl1.policies.update({
			set: {
				name: rename.to.name,
				schema: rename.to.schema,
			},
			where: {
				name: rename.from.name,
				schema: rename.from.schema,
			},
		});
	}

	const viewsDiff = diff(ddl1, ddl2, 'views');

	const { created: createdViews, deleted: deletedViews, renamedOrMoved: renamedOrMovedViews } = await viewsResolver({
		created: viewsDiff.filter((it) => it.$diffType === 'create'),
		deleted: viewsDiff.filter((it) => it.$diffType === 'drop'),
	});

	const renamedViews = renamedOrMovedViews.filter((it) => it.from.schema === it.to.schema);
	const movedViews = renamedOrMovedViews.filter((it) => it.from.schema !== it.to.schema);

	for (const rename of renamedViews) {
		ddl1.views.update({
			set: {
				name: rename.to.name,
				schema: rename.to.schema,
			},
			where: {
				name: rename.from.name,
				schema: rename.from.schema,
			},
		});
	}
	for (const move of movedViews) {
		ddl1.views.update({
			set: {
				schema: move.to.schema,
			},
			where: {
				name: move.from.name,
				schema: move.from.schema,
			},
		});
	}

	const alters = diff.alters(ddl1, ddl2);

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
		return prepareStatement('rename_index', { schema: r.to.schema, from: r.from.name, to: r.to.name });
	});

	const indexesAlters = alters.filter((it): it is DiffEntities['indexes'] => {
		if (it.entityType !== 'indexes') return false;

		delete it.concurrently;

		return ddl2.indexes.hasDiff(it);
	});

	const jsonRecreateIndex: JsonRecreateIndex[] = [];
	for (const idx of indexesAlters) {
		const forWhere = !!idx.where && (idx.where.from !== null && idx.where.to !== null ? mode !== 'push' : true);
		const forColumns = !!idx.columns && (idx.columns.from.length === idx.columns.to.length ? mode !== 'push' : true);

		if (idx.isUnique || idx.concurrently || idx.method || idx.with || forColumns || forWhere) {
			const index = ddl2.indexes.one({ schema: idx.schema, table: idx.table, name: idx.name })!;

			// when a column used by the index is being dropped, the index is dropped with it (cascade),
			// so the recreate must skip the explicit DROP INDEX
			const prevIndex = ddl1.indexes.one({ schema: idx.schema, table: idx.table, name: idx.name });
			const shouldDrop = !!prevIndex
				&& !columnsToDelete.some((col) =>
					col.schema === idx.schema
					&& col.table === idx.table
					&& prevIndex.columns.some((idxCol) => idxCol.value === col.name)
				);
			jsonRecreateIndex.push(prepareStatement('recreate_index', { index, diff: idx, shouldDrop }));
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
			schema: it.to.schema,
			table: it.to.table,
			from: it.from.name,
			to: it.to.name,
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
			schema: it.to.schema,
			table: it.to.table,
			from: it.from.name,
			to: it.to.name,
		});
	});

	const jsonSetTableSchemas = movedTables.map((it) =>
		prepareStatement('move_table', {
			name: it.to.name, // rename of table comes first
			from: it.from.schema,
			to: it.to.schema,
		})
	);

	const jsonCreatedCheckConstraints = checkCreates.filter(tablesFilter('created')).map((it) =>
		prepareStatement('add_check', { check: it })
	);
	const jsonDropCheckConstraints = checkDeletes.filter(tablesFilter('deleted')).map((it) =>
		prepareStatement('drop_check', { check: it })
	);
	const jsonRenamedCheckConstraints = checkRenames.map((it) =>
		prepareStatement('rename_constraint', {
			schema: it.to.schema,
			table: it.to.table,
			from: it.from.name,
			to: it.to.name,
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

	const jsonRenameReferences = fksRenames.map((it) =>
		prepareStatement('rename_constraint', {
			schema: it.to.schema,
			table: it.to.table,
			from: it.from.name,
			to: it.to.name,
		})
	);

	const jsonAlterCheckConstraints = alteredChecks.filter((it) => it.value && mode !== 'push').map((it) =>
		prepareStatement('alter_check', { diff: it })
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
			const columns = ddl1.columns.list({ typeSchema: alter.schema, type: alter.name })
				.map((it) => {
					const c2 = ddl2.columns.one({ schema: it.schema, table: it.table, name: it.name });
					if (c2 === null) return null;

					const def = {
						right: c2.default,
						left: it.default,
					};
					return { ...it, default: def };
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
			const wasEnum =
				(it.type && ddl1.enums.one({ schema: column.typeSchema ?? 'public', name: it.type.from }) !== null)
					?? false;

			return prepareStatement('alter_column', {
				diff: it,
				to: column,
				isEnum,
				wasEnum,
				wasSerial,
				toSerial,
			});
		});

	const createSequences = createdSequences.map((it) => prepareStatement('create_sequence', { sequence: it }));
	const dropSequences = deletedSequences.map((it) => prepareStatement('drop_sequence', { sequence: it }));
	const moveSequences = movedSequences.map((it) => prepareStatement('move_sequence', it));
	const renameSequences = renamedSequences.map((it) => prepareStatement('rename_sequence', it));
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
		goneFunctions.has(it.function) && !deletedTriggers.some((d) => sameTrigger(d, it))
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

	const extensionAlters = alters.filter((it): it is DiffEntities['extensions'] => it.entityType === 'extensions');
	const jsonCreateExtensions = [
		...createdExtensions.map((it) => prepareStatement('create_extension', { extension: it })),
		...extensionAlters.map((it) => prepareStatement('create_extension', { extension: it.$right })),
	];
	const jsonDropExtensions = [
		...deletedExtensions.map((it) => prepareStatement('drop_extension', { extension: it })),
		...extensionAlters.map((it) => prepareStatement('drop_extension', { extension: it.$left })),
	];

	const createSchemas = createdSchemas.map((it) => prepareStatement('create_schema', it));
	const dropSchemas = deletedSchemas.map((it) => prepareStatement('drop_schema', it));
	const renameSchemas = renamedSchemas.map((it) => prepareStatement('rename_schema', it));

	const createTables = createdTables.map((it) => prepareStatement('create_table', { table: tableFromDDL(it, ddl2) }));

	const createViews = createdViews.map((it) => prepareStatement('create_view', { view: it }));

	const jsonDropViews = deletedViews.map((it) => prepareStatement('drop_view', { view: it, cause: null }));

	const jsonReplaceViews: JsonStatement[] = [];

	const jsonRenameViews = renamedViews.map((it) => prepareStatement('rename_view', it));

	const jsonMoveViews = movedViews.map((it) =>
		prepareStatement('move_view', { fromSchema: it.from.schema, toSchema: it.to.schema, view: it.to })
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

	const originalView = (it: View): View => {
		const schemaRename = renamedSchemas.find((r) => r.to.name === it.schema);
		const schema = schemaRename ? schemaRename.from.name : it.schema;
		const viewRename = renamedViews.find((r) => r.to.schema === it.schema && r.to.name === it.name);
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
		const st = jsonReplaceViews[i]!;
		if (st.type === 'replace_view' && recreated(st.view)) jsonReplaceViews.splice(i, 1);
	}
	jsonAlterViews = jsonAlterViews.filter((st) => !recreated(st.view));

	// dropped in the reverse of the order they are created in: what the views
	// select from now decides the order among views that were independent, and
	// what they selected from before, which is what the database still holds
	// when they are dropped, decides it where the two differ
	const byNewDefinition = sortViewsByDependency(viewsToRecreate, (node, other) => existsInViewDef(other.to, node.to));
	const jsonRecreateDropViews = sortViewsByDependency(
		byNewDefinition,
		(node, other) => existsInViewDef(other.from, node.from),
	)
		.reverse()
		.map(({ from, to }) => {
			const left = viewsAlters.find((a) => a.view === to)?.diff.$left ?? from;
			return prepareStatement('drop_view', { view: left, cause: from });
		});
	createViews.push(...viewsToRecreate.map((r) => prepareStatement('create_view', { view: r.to })));

	// DROP VIEW took the privileges on the view with it
	const jsonRegrantRecreatedViews = viewsToRecreate.flatMap((r) =>
		ddl2.privileges.list({ schema: r.to.schema, table: r.to.name }).map((privilege) =>
			prepareStatement('grant_privilege', { privilege })
		)
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

	const jsonRecreateColumns = columnsToRecreate.map((it) => {
		const indexes = ddl2.indexes.list({ table: it.table, schema: it.schema }).filter((index) =>
			index.columns.some((column) => trimChar(column.value, '`') === it.name)
		);
		for (const index of indexes) {
			jsonCreateIndexes.push({ type: 'create_index', index });
		}

		const uniques = ddl2.uniques.list({ table: it.table, schema: it.schema, columns: { CONTAINS: it.name } });
		for (const unique of uniques) {
			jsonAddedUniqueConstraints.push({ type: 'add_unique', unique });
		}

		// Not sure if anyone tries to add fk on generated column or from it, but still...
		const fksFrom = ddl2.fks.list({ table: it.table, schema: it.schema, columns: { CONTAINS: it.name } });
		const fksTo = ddl2.fks.list({ tableTo: it.table, schemaTo: it.schema, columnsTo: { CONTAINS: it.name } });
		for (const fkFrom of fksFrom) {
			jsonDropFKs.push({ type: 'drop_fk', fk: fkFrom });
		}
		for (const fkTo of fksTo) {
			jsonDropFKs.push({ type: 'drop_fk', fk: fkTo });
			jsonCreateFKs.push({ type: 'create_fk', fk: fkTo });
		}

		return prepareStatement('recreate_column', {
			diff: it,
			isPK: ddl2.pks.one({ schema: it.schema, table: it.table, columns: [it.name] }) !== null,
		});
	});

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
	jsonStatements.push(...jsonDropRoles);
	jsonStatements.push(...jsonCreateRoles);
	jsonStatements.push(...jsonAlterRoles);

	jsonStatements.push(...jsonRevokePrivileges);

	jsonStatements.push(...createTables);

	jsonStatements.push(...jsonDropViews);
	jsonStatements.push(...jsonRecreateDropViews);
	// a trigger is dropped before the function it calls, and before its table is renamed or dropped
	jsonStatements.push(...jsonDropTriggers);
	jsonStatements.push(...jsonRenameViews);
	jsonStatements.push(...jsonMoveViews);
	jsonStatements.push(...jsonAlterViews);

	jsonStatements.push(...jsonRenameTables);
	jsonStatements.push(...jsonDropPoliciesStatements); // before drop tables
	jsonStatements.push(...jsonDropFKs);

	jsonStatements.push(...jsonDropTables);
	jsonStatements.push(...jsonAlterRlsStatements);
	jsonStatements.push(...jsonSetTableSchemas);
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
	jsonStatements.push(...jsonRecreateFKs);

	jsonStatements.push(...jsonCreatedCheckConstraints);

	jsonStatements.push(...jsonAlterCheckConstraints);

	// a view is replaced after the tables and columns it selects from changed
	jsonStatements.push(...jsonReplaceViews);

	// Dependent views must be created after their dependencies, otherwise the migration breaks:
	// https://github.com/drizzle-team/drizzle-orm/issues/4520 and https://github.com/drizzle-team/drizzle-orm/issues/6176
	const sortedCreateViews = sortViewsByDependency(createViews, (node, other) => existsInViewDef(other.view, node.view));

	jsonStatements.push(...sortedCreateViews);

	// a privilege is granted once what it is granted on exists
	jsonStatements.push(...jsonGrantPrivileges);
	jsonStatements.push(...jsonAlterPrivileges);
	jsonStatements.push(...jsonRegrantRecreatedViews);

	// a trigger is created once its table and its function exist
	jsonStatements.push(...jsonCreateTriggers);

	jsonStatements.push(...jsonRenamePoliciesStatements);
	jsonStatements.push(...jsonCreatePoliciesStatements);
	jsonStatements.push(...jsonAlterOrRecreatePoliciesStatements);

	jsonStatements.push(...jsonDropEnums);
	jsonStatements.push(...dropSequences);
	// an extension is dropped last, once nothing of the schema uses its types
	jsonStatements.push(...jsonDropExtensions);
	jsonStatements.push(...dropSchemas);

	const { groupedStatements, sqlStatements } = fromJson(jsonStatements);

	const renames = prepareMigrationRenames([
		...renameSchemas,
		...renamedEnums,
		...renamedOrMovedTables,
		...columnRenames,
		...uniqueRenames,
		...checkRenames,
		...indexesRenames,
		...pksRenames,
		...fksRenames,
		...policyRenames,
		...renamedOrMovedViews,
		...renamedRoles,
		...renamedOrMovedSequences,
	]);

	return {
		statements: jsonStatements,
		sqlStatements,
		groupedStatements: groupedStatements,
		renames: renames,
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
