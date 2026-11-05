import assert from 'node:assert/strict';
import test from 'node:test';
import { GRANDFATHERED, lintMigrations, stripSql } from './check-migrations.mjs';

const old = new Set(['0001_a.sql', '0002_b.sql', '0002_c.sql']);
const file = (name, text = 'CREATE TABLE t (id TEXT);') => ({ name, text });
const lint = (files) => lintMigrations([file('0001_a.sql'), file('0002_b.sql'), file('0002_c.sql'), ...files], old);

test('existing migrations are grandfathered, duplicates and drops included', () => {
  assert.deepEqual(lintMigrations([file('0001_a.sql', 'DROP TABLE x;'), file('0002_b.sql'), file('0002_c.sql')], old), []);
});

test('a new migration with a higher number passes', () => {
  assert.deepEqual(lint([file('0003_d.sql')]), []);
});

test('a number that is not higher than the grandfathered ones fails', () => {
  assert.match(lint([file('0002_d.sql')]).join('\n'), /0002_d\.sql: the number 0002 is not higher/u);
  assert.match(lint([file('0001_d.sql')]).join('\n'), /not higher/u);
});

test('two new migrations may not share a number', () => {
  assert.match(lint([file('0003_d.sql'), file('0003_e.sql')]).join('\n'), /0003_e\.sql: the number 0003 is also used by 0003_d\.sql/u);
});

test('a name that is not NNNN_snake_case fails', () => {
  assert.match(lint([file('3_d.sql')]).join('\n'), /named NNNN_snake_case\.sql/u);
});

test('DROP TABLE, DROP COLUMN and a rebuild need a destructive header', () => {
  for (const sql of [
    'DROP TABLE old;',
    'ALTER TABLE t DROP COLUMN c;',
    'ALTER TABLE t RENAME TO t_old;\nCREATE TABLE t (id TEXT);',
    'drop   table if exists t;',
  ]) {
    assert.match(lint([file('0003_d.sql', sql)]).join('\n'), /first line must be a comment "-- destructive: <reason>"/u, sql);
  }
});

test('a destructive header with a reason passes; without one it does not', () => {
  assert.deepEqual(lint([file('0003_d.sql', '-- destructive: nothing reads old since 6.4.0\nDROP TABLE old;')]), []);
  assert.equal(lint([file('0003_d.sql', '-- destructive:\nDROP TABLE old;')]).length, 1);
  assert.equal(lint([file('0003_d.sql', '-- Drop the old table.\nDROP TABLE old;')]).length, 1);
});

test('words in comments and strings do not count', () => {
  assert.deepEqual(lint([file('0003_d.sql', "-- we never DROP TABLE here\n/* DROP COLUMN */\nINSERT INTO t VALUES ('DROP TABLE');")]), []);
  assert.equal(stripSql("a -- x\nb 'it''s' c").replace(/\s+/gu, ' '), "a b '' c");
});

test('the real list names real, numbered files', () => {
  for (const name of GRANDFATHERED) assert.match(name, /^\d{4}_[a-z0-9_]+\.sql$/u);
});
