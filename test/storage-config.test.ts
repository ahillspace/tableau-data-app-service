import assert from "node:assert/strict";
import { test } from "node:test";
import { storageConfiguration } from "../src/storage/config.ts";

const core = "postgresql://core-user:core-secret@DB.Example.com./app%20db";
const storage = (url: string, coreUrl = core) =>
  storageConfiguration({ STORAGE_DATABASE_URL: url }, coreUrl);

test("Storage database identity ignores credentials and normalizes host, port and name", () => {
  const same = storage("postgres://other-user:other-secret@db.example.com:5432/app%20db");
  assert.ok(same && "reason" in same);
  assert.match(same.reason, /dedicated Storage database/);

  const explicitPort = storage("postgresql://u:p@db.example.com:5432/app%20db");
  assert.ok(explicitPort && "reason" in explicitPort);
  assert.match(explicitPort.reason, /dedicated Storage database/);

  const encodedName = storage("postgresql://u:p@db.example.com/app%20db");
  assert.ok(encodedName && "reason" in encodedName);
  assert.match(encodedName.reason, /dedicated Storage database/);
});

test("Storage database identity permits distinct servers or ports with identical names", () => {
  const otherHost = storage("postgresql://u:p@storage.example.com/app%20db");
  assert.ok(otherHost && "url" in otherHost);

  const otherPort = storage("postgresql://u:p@db.example.com:5433/app%20db");
  assert.ok(otherPort && "url" in otherPort);

  const otherName = storage("postgresql://u:p@db.example.com/app%20db%20two");
  assert.ok(otherName && "url" in otherName);
});

test("Storage URL keeps its no-query contract", () => {
  const rejected = storage("postgresql://u:p@db.example.com:5432/app%20db?port=5433");
  assert.ok(rejected && "reason" in rejected);
  assert.match(rejected.reason, /dedicated PostgreSQL database/);
});

test("Storage database identity uses the core driver's effective query port and host", () => {
  const sameName = "postgresql://u:p@db.example.com:5432/app%20db";
  const base = "postgresql://core-user:core-secret@DB.Example.com.:5432/app%20db";

  const sameCorePort = storage(sameName, `${base}?port=5432`);
  assert.ok(sameCorePort && "reason" in sameCorePort);
  assert.match(sameCorePort.reason, /dedicated Storage database/);

  const distinctCorePort = storage(sameName, `${base}?port=5433`);
  assert.ok(distinctCorePort && "url" in distinctCorePort);

  const emptyCorePort = storage(sameName, `${base}?port=`);
  assert.ok(emptyCorePort && "reason" in emptyCorePort);
  assert.match(emptyCorePort.reason, /dedicated Storage database/);

  const sameCoreHost = storage(sameName, `${base}?host=DB.Example.com.`);
  assert.ok(sameCoreHost && "reason" in sameCoreHost);
  assert.match(sameCoreHost.reason, /dedicated Storage database/);

  const distinctCoreHost = storage(sameName, `${base}?host=storage.example.com`);
  assert.ok(distinctCoreHost && "url" in distinctCoreHost);
});
