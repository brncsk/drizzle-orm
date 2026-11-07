import { entityKind, is } from '~/entity.ts';
import { TableName } from '~/table.utils.ts';
import type { AnyPgColumn, PgColumn } from './columns/index.ts';
import type { PgTable } from './table.ts';

export type UpdateDeleteAction = 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default';

/**
 * When Postgres checks a foreign key. Without it the key is `NOT DEFERRABLE`
 * and is checked at the end of each statement.
 */
export interface ForeignKeyDeferral {
	/** The check can wait until the end of the transaction (`DEFERRABLE`), when `SET CONSTRAINTS` asks for it. */
	deferrable?: boolean;
	/** The check waits until the end of the transaction unless `SET CONSTRAINTS` says otherwise (`INITIALLY DEFERRED`). It needs `deferrable`. `INITIALLY IMMEDIATE` when left out. */
	initiallyDeferred?: boolean;
}

export type Reference = () => {
	readonly name?: string;
	readonly columns: PgColumn[];
	readonly foreignTable: PgTable;
	readonly foreignColumns: PgColumn[];
};

export class ForeignKeyBuilder {
	static readonly [entityKind]: string = 'PgForeignKeyBuilder';
	static [Symbol.hasInstance](value: unknown): boolean {
		return is(value, this);
	}

	/** @internal */
	reference: Reference;

	/** @internal */
	_onUpdate: UpdateDeleteAction | undefined = 'no action';

	/** @internal */
	_onDelete: UpdateDeleteAction | undefined = 'no action';

	/** @internal */
	_deferrable = false;

	/** @internal */
	_initiallyDeferred = false;

	constructor(
		config: () => {
			name?: string;
			columns: PgColumn[];
			foreignColumns: PgColumn[];
		},
		actions?:
			| {
				onUpdate?: UpdateDeleteAction;
				onDelete?: UpdateDeleteAction;
			} & ForeignKeyDeferral
			| undefined,
	) {
		this.reference = () => {
			const { name, columns, foreignColumns } = config();
			return { name, columns, foreignTable: foreignColumns[0]!.table as PgTable, foreignColumns };
		};
		if (actions) {
			this._onUpdate = actions.onUpdate;
			this._onDelete = actions.onDelete;
			this.deferrable(actions);
		}
	}

	onUpdate(action: UpdateDeleteAction): this {
		this._onUpdate = action === undefined ? 'no action' : action;
		return this;
	}

	onDelete(action: UpdateDeleteAction): this {
		this._onDelete = action === undefined ? 'no action' : action;
		return this;
	}

	/**
	 * Sets when Postgres checks the key ({@link ForeignKeyDeferral}). With no
	 * argument the key becomes `DEFERRABLE INITIALLY IMMEDIATE`: it is checked
	 * per statement until `SET CONSTRAINTS ... DEFERRED` moves the check to the
	 * commit.
	 */
	deferrable(deferral: ForeignKeyDeferral = { deferrable: true }): this {
		if (deferral.initiallyDeferred && !deferral.deferrable) {
			throw new Error('A foreign key that is initially deferred must be deferrable');
		}
		this._deferrable = deferral.deferrable ?? false;
		this._initiallyDeferred = deferral.initiallyDeferred ?? false;
		return this;
	}

	/** @internal */
	build(table: PgTable): ForeignKey {
		return new ForeignKey(table, this);
	}
}

export type AnyForeignKeyBuilder = ForeignKeyBuilder;

export class ForeignKey {
	static readonly [entityKind]: string = 'PgForeignKey';
	static [Symbol.hasInstance](value: unknown): boolean {
		return is(value, this);
	}

	readonly reference: Reference;
	readonly onUpdate: UpdateDeleteAction | undefined;
	readonly onDelete: UpdateDeleteAction | undefined;
	/** The check can wait until the end of the transaction (`DEFERRABLE`). */
	readonly deferrable: boolean;
	/** The check waits until the end of the transaction unless `SET CONSTRAINTS` says otherwise (`INITIALLY DEFERRED`). */
	readonly initiallyDeferred: boolean;
	readonly name?: string;

	constructor(readonly table: PgTable, builder: ForeignKeyBuilder) {
		this.reference = builder.reference;
		this.onUpdate = builder._onUpdate;
		this.onDelete = builder._onDelete;
		this.deferrable = builder._deferrable;
		this.initiallyDeferred = builder._initiallyDeferred;
	}

	getName(): string {
		const { name, columns, foreignColumns } = this.reference();
		const columnNames = columns.map((column) => column.name);
		const foreignColumnNames = foreignColumns.map((column) => column.name);
		const chunks = [
			this.table[TableName],
			...columnNames,
			foreignColumns[0]!.table[TableName],
			...foreignColumnNames,
		];
		return name ?? `${chunks.join('_')}_fk`;
	}

	isNameExplicit(): boolean {
		return !!this.reference().name;
	}
}

type ColumnsWithTable<
	TTableName extends string,
	TColumns extends PgColumn[],
> = { [Key in keyof TColumns]: AnyPgColumn<{ tableName: TTableName }> };

export function foreignKey<
	TTableName extends string,
	TForeignTableName extends string,
	TColumns extends [AnyPgColumn<{ tableName: TTableName }>, ...AnyPgColumn<{ tableName: TTableName }>[]],
>(
	config: {
		name?: string;
		columns: TColumns;
		foreignColumns: ColumnsWithTable<TForeignTableName, TColumns>;
	},
): ForeignKeyBuilder {
	function mappedConfig() {
		const { name, columns, foreignColumns } = config;
		return {
			name,
			columns,
			foreignColumns,
		};
	}

	return new ForeignKeyBuilder(mappedConfig);
}
