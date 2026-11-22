import assert from "node:assert/strict";
import { test } from "node:test";
import { storageConfiguration } from "../src/storage/config.ts";

const core = "postgresql://core-user:core-secret@DB.Example.com./app%20db";
const storage = (url: string) => storageConfiguration({ STORAGE_DATABASE_URL: url }, core);

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
