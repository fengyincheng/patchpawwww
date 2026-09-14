import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeControlPlaneDb, openControlPlaneDb } from '../src/control-plane/db.ts';

test('unsupported control-plane migration fails closed and a compatible restore recovers cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchpaw-p0-schema-recovery-'));
  const db = await openControlPlaneDb(root);
  const path = db.path;
  closeControlPlaneDb(db);

  const corruptMarker = createClient({ url: pathToFileURL(path).href });
  await corruptMarker.execute("UPDATE control_plane_meta SET value = '999' WHERE key = 'migration_version'");
  corruptMarker.close();
  await assert.rejects(openControlPlaneDb(root), /Unsupported control-plane migration version/);

  const restoreMarker = createClient({ url: pathToFileURL(path).href });
  await restoreMarker.execute("UPDATE control_plane_meta SET value = '2' WHERE key = 'migration_version'");
  restoreMarker.close();
  const recovered = await openControlPlaneDb(root);
  try {
    assert.equal(await recovered.getMeta('schema_version'), '2');
    assert.equal(await recovered.getMeta('migration_version'), '2');
    assert.equal((await recovered.execute('PRAGMA integrity_check')).rows[0]?.integrity_check, 'ok');
  } finally { closeControlPlaneDb(recovered); }
});
