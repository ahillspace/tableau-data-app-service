import { parse } from "libpg-query";
import type pg from "pg";
import { ServiceError } from "../platform/errors.ts";

// PostgreSQL enforces all remaining SQL authority and the surrounding transaction. These
// statements would instead manage that transaction, the login, or the protocol itself.
const runnerStatements = new Set([
  "TransactionStmt",
  "VariableSetStmt",
  "DiscardStmt",
  "PrepareStmt",
  "ExecuteStmt",
  "DeallocateStmt",
  "DeclareCursorStmt",
  "FetchStmt",
  "ClosePortalStmt",
  "ListenStmt",
  "UnlistenStmt",
  "CopyStmt",
  "AlterRoleStmt",
  "AlterRoleSetStmt",
  "CreateRoleStmt",
  "DropRoleStmt",
  "GrantRoleStmt",
  "AlterSystemStmt",
]);

async function statements(sql: string) {
  try {
    return (await parse(sql)).stmts ?? [];
  } catch (error) {
    const position = (error as { cursorPosition?: unknown }).cursorPosition;
    throw new ServiceError(
      422,
      "storage-sql-syntax",
      "PostgreSQL could not parse the submitted SQL",
      {
        ...(typeof position === "number"
          ? { fields: [{ path: "sql", rule: `position:${position}` }] }
          : {}),
      },
    );
  }
}

export async function migrationStatements(source: string): Promise<string[]> {
  const sql = Buffer.from(source);
  const parsed = await statements(source);
  if (!parsed.length)
    throw new ServiceError(
      422,
      "storage-sql-empty",
      "A migration must contain at least one SQL statement",
    );
  return parsed.map((entry, i) => {
    const [kind = ""] = Object.keys(entry.stmt ?? {});
    if (runnerStatements.has(kind))
      throw new ServiceError(
        422,
        "storage-sql-not-atomic",
        `Statement ${i + 1} (${kind}) cannot run in a Storage migration`,
      );
    const start = entry.stmt_location ?? 0;
    const end = entry.stmt_len ? start + entry.stmt_len : undefined;
    return sql.subarray(start, end).toString("utf8");
  });
}

export async function explorationStatement(source: string): Promise<void> {
  const parsed = await statements(source);
  if (parsed.length !== 1 || !parsed[0]?.stmt || !("SelectStmt" in parsed[0].stmt))
    throw new ServiceError(
      422,
      "storage-query-select-required",
      "Workspace exploration accepts one read-only SELECT",
    );
}

export type DatabaseDiagnostic = {
  code?: string;
  constraint?: string;
  column?: string;
  position?: string;
};

export function safeDiagnostic(diagnostic: DatabaseDiagnostic) {
  const { code, constraint, column, position } = diagnostic;
  const safeName = (value: string | undefined) =>
    value && /^[\p{L}\p{N}_. -]{1,63}$/u.test(value) ? value : undefined;
  return {
    ...(code && /^[0-9A-Z]{5}$/.test(code) ? { sqlState: code } : {}),
    ...(safeName(constraint) ? { constraint } : {}),
    ...(safeName(column) ? { column } : {}),
    ...(position && /^\d+$/.test(position) ? { position: Number(position) } : {}),
  };
}

export function statementFailure(error: unknown, statement?: number): ServiceError {
  if (error instanceof ServiceError) return error;
  const diagnostic = safeDiagnostic((error || {}) as DatabaseDiagnostic);
  const { sqlState } = diagnostic;
  if (!sqlState || sqlState.startsWith("08")) throw error;
  const detail = Object.entries(diagnostic).map(([key, value]) => ({
    path: "sql",
    rule: `${key}:${value}`,
  }));
  if (statement !== undefined) detail.unshift({ path: "sql", rule: `statement:${statement}` });
  const conflict = sqlState === "TD002" || sqlState === "TD003";
  const stateChange = sqlState === "TD001";
  const timeout = ["55P03", "57014"].includes(sqlState);
  const message =
    sqlState === "TD002"
      ? "Migration ID has different input"
      : sqlState === "TD003"
        ? "Migration predecessor is stale"
        : stateChange
          ? "Workspace ownership or state changed. Reload the workspace."
          : sqlState === "25001"
            ? "The submitted operation cannot run in an atomic PostgreSQL transaction"
            : timeout
              ? "PostgreSQL could not complete the operation within the configured time"
              : "PostgreSQL rejected the workspace statement";
  return new ServiceError(
    conflict || stateChange ? 409 : timeout ? 503 : 422,
    conflict || stateChange
      ? "storage-conflict"
      : timeout
        ? "storage-sql-timeout"
        : "storage-sql-rejected",
    message,
    { fields: detail },
  );
}

export async function inspectModel(client: pg.PoolClient, namespace: string) {
  const query = async (text: string) => (await client.query(text, [namespace])).rows;
  // Catalog expressions are rendered through the actual model login, like owner exploration.
  const columns = await query(`select c.relname as "object", c.relkind as "objectKind",
    a.attname as column, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
    pg_get_expr(d.adbin, d.adrelid) as default
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where n.nspname=$1 and c.relkind in ('r','p','v','m') and a.attnum>0 and not a.attisdropped
    order by c.relname,a.attnum`);
  const constraints = await query(`select c.relname as "object", p.conname as name,
    p.contype as kind, pg_get_constraintdef(p.oid) as definition
    from pg_constraint p join pg_class c on c.oid=p.conrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=$1 order by c.relname,p.conname`);
  const indexes = await query(`select tablename as "object",indexname as name,indexdef as definition
    from pg_indexes where schemaname=$1 order by tablename,indexname`);
  const privileges = await query(`select table_name as "object",grantee,column_name as column,
    privilege_type as privilege from information_schema.column_privileges where table_schema=$1
    order by table_name,grantee,column_name,privilege_type`);
  const tablePrivileges = await query(`select table_name as "object",grantee,
    privilege_type as privilege from information_schema.table_privileges where table_schema=$1
    order by table_name,grantee,privilege_type`);
  const routines =
    await query(`select p.proname as name, pg_get_function_identity_arguments(p.oid) as arguments,
    p.prosecdef as "securityDefiner", p.proacl as privileges
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1
    order by p.proname,p.oid`);
  return { columns, constraints, indexes, tablePrivileges, privileges, routines };
}
