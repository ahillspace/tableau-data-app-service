import { sql } from "kysely";
import type { Database } from "../db/database.js";
import type { CredentialsService } from "./credentials.js";

export class CoreMaintenance {
  lastSuccess: Date | undefined;
  constructor(
    readonly db: Database,
    readonly credentials: CredentialsService,
    readonly batch: number,
  ) {
    if (!Number.isSafeInteger(batch) || batch < 1) throw new Error("Invalid maintenance batch");
  }
  async run(signal: AbortSignal): Promise<void> {
    const candidates = await this.db
      .selectFrom("credential_mutations")
      .selectAll()
      .where("phase", "not in", ["succeeded", "failed", "uncertain"])
      .where((eb) =>
        eb.or([
          eb("expires_at", "<=", sql<Date>`clock_timestamp()`),
          eb("lease_until", "<=", sql<Date>`clock_timestamp()`),
        ]),
      )
      .orderBy("expires_at")
      .limit(this.batch)
      .execute();
    for (const row of candidates) {
      signal.throwIfAborted();
      await this.credentials.recover(
        {
          id: row.id,
          kind: row.kind,
          connectionId: row.connection_id,
          setupId: row.setup_id,
          expiresAt: row.expires_at,
          expected: {
            authorityGeneration: row.expected_authority,
            credentialGeneration: row.expected_credential,
          },
        },
        false,
        {
          finalize: async (tx) => {
            await tx
              .updateTable("authorizations")
              .set({ state: "expired", protected_state: null, browser_verifier: null })
              .where("mutation_id", "=", row.id)
              .where("state", "in", ["pending", "exchanging"])
              .execute();
          },
        },
      );
    }
    // Delete inert correlation and expired access without loading encrypted bodies.
    await sql`delete from access_tokens where verifier in (select verifier from access_tokens where expires_at<=clock_timestamp() order by expires_at limit ${this.batch})`.execute(
      this.db,
    );
    await sql`delete from restoration_bindings where verifier in (select r.verifier from restoration_bindings r join sessions s on s.id=r.session_id where s.revoked or s.authentication_expires_at<=clock_timestamp() order by s.authentication_expires_at limit ${this.batch})`.execute(
      this.db,
    );
    await sql`delete from session_transactions where id in (select id from session_transactions where expires_at<=clock_timestamp() order by expires_at limit ${this.batch})`.execute(
      this.db,
    );
    await sql`delete from authorizations where id in (select a.id from authorizations a join credential_mutations m on m.id=a.mutation_id where a.expires_at<=clock_timestamp() and a.state not in ('pending','exchanging') and m.phase in ('succeeded','failed') order by a.expires_at limit ${this.batch})`.execute(
      this.db,
    );
    await sql`delete from credential_mutations where id in (select m.id from credential_mutations m where m.expires_at<=clock_timestamp() and m.phase in ('succeeded','failed') and not exists(select 1 from authorizations a where a.mutation_id=m.id) and not exists(select 1 from connections c where c.mutation_id=m.id) order by m.expires_at limit ${this.batch})`.execute(
      this.db,
    );
    await sql`delete from sessions where id in (select s.id from sessions s where s.authentication_expires_at<=clock_timestamp() and not exists(select 1 from credential_mutations m where m.access_session_id=s.id) and not exists(select 1 from authorizations a where a.session_id=s.id) and not exists(select 1 from session_transactions t where t.session_id=s.id) order by s.authentication_expires_at limit ${this.batch})`.execute(
      this.db,
    );
    this.lastSuccess = new Date();
  }
}
