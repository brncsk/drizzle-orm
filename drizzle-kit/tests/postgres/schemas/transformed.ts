import { integer, pgTable } from 'drizzle-orm/pg-core';

/** A schema file a transform adds to: `users` is declared here, `audit` is what the transform derives. */
export const users = pgTable('users', { id: integer('id').primaryKey() });

/** Not a schema object: a transform reads it and derives a table from it. */
export const derived = { name: 'audit' };
