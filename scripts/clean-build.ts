import { rm } from "node:fs/promises";

// Removed source modules must not survive an incremental release build.
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
