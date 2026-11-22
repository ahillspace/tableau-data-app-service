import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type pg from "pg";
import { load, runApi } from "../src/main.ts";
import { Log } from "../src/platform/log.ts";
import { Sealer } from "../src/sealing/sealer.ts";
import { installStorage } from "../src/storage/install.ts";
import { identifier, storagePool } from "../src/storage/postgres.ts";
import { Registry } from "../src/storage/registry.ts";
import { ADMIN, WORKSPACES } from "../src/storage/service.ts";
import { caCert, freshDatabase, freshDatabaseUrl, sealingKeysEnv, testKeys } from "./support/db.ts";
import {
  appSignIn,
  DEPLOYMENT,
  identityHarness,
  operatorSignIn,
  SERVICE_ORIGIN,
  tableauSignIn,
} from "./support/identity.ts";
import { TableauStandIn } from "./support/tableau.ts";

const bootstrap = (podOrigin: string) => ({
  publicOrigin: SERVICE_ORIGIN,
  deployments: [{ id: DEPLOYMENT, kind: "tableau-cloud", podOrigin }],
  firstSite: { deploymentId: DEPLOYMENT, contentUrl: "alpha" },
  firstOperator: { deploymentId: DEPLOYMENT, siteContentUrl: "alpha", username: "op@example.com" },
});
const migrationSql = (editor: string, reader: string) => `-- UTF-8 boundary: approbación; coût
create table product (sku text primary key, price numeric(30,12) not null);
create table purchase (id uuid primary key, actor uuid not null default tdas.actor_id());
create table purchase_line (
  purchase_id uuid references purchase(id),
  line_no int not null,
  sku text not null references product(sku),
  qty int not null check (qty > 0),
  primary key (purchase_id,line_no)
);
create index on purchase_line(sku);
create view purchase_total with (security_invoker = true) as
  select l.purchase_id, sum(l.qty * p.price) as amount
  from purchase_line l join product p on p.sku=l.sku group by l.purchase_id;
create table saved_view (
  actor uuid not null default tdas.actor_id(),
  view_key text not null,
  state jsonb not null,
  primary key (actor,view_key)
);
alter table saved_view enable row level security;
create policy actor_only on saved_view using (actor=tdas.actor_id()) with check (actor=tdas.actor_id());
create function submit_purchase(purchase_id uuid, items jsonb) returns purchase
language plpgsql volatile security invoker as $$
declare result purchase;
begin
  insert into purchase(id) values (purchase_id) returning * into result;
  insert into purchase_line(purchase_id,line_no,sku,qty)
    select $1, ordinality, item->>'sku', (item->>'qty')::int
    from jsonb_array_elements(items) with ordinality t(item,ordinality);
  return result;
end $$;
create function save_view(key text, value jsonb) returns text
language sql volatile security invoker as $$
  insert into saved_view(view_key,state) values ($1,$2)
  on conflict(actor,view_key) do update set state=excluded.state returning view_key
$$;
create function current_actor() returns uuid language sql stable as $$ select tdas.actor_id() $$;
create function read_only() returns text language plpgsql stable as $$
begin
  if current_setting('transaction_read_only') <> 'on' then raise exception 'read-write transaction'; end if;
  return session_user;
end $$;
create function local_setting() returns uuid language plpgsql stable as $$
begin
  perform set_config('tdas.actor_id','00000000-0000-4000-8000-000000000099',false);
  return tdas.actor_id();
end $$;
grant execute on function submit_purchase(uuid,jsonb), save_view(text,jsonb) to ${editor};
grant execute on function current_actor() to ${editor}, ${reader};
grant execute on function local_setting(), read_only() to ${reader};
insert into product values ('pencil', '123456789012345678.125000000001');`;

test("opt-in relational Storage serves two Tableau identities and workspace role sets over actual HTTP and PostgreSQL", {
  timeout: 65000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tdas-storage-http-"));
  const core = await freshDatabase();
  const tableau = await new TableauStandIn().start();
  const identity = await identityHarness(core.db, tableau);
  const peers: pg.Pool[] = [];
  const runners: Awaited<ReturnType<typeof runApi>>[] = [];
  t.after(async () => {
    await Promise.all(runners.map((runner) => runner.stop()));
    await Promise.all(peers.map((pool) => pool.end()));
    await identity.close();
    await tableau.close();
    await core.close();
    await rm(root, { recursive: true, force: true });
  });
  const pool = (url: string) => {
    const value = storagePool(url, caCert(), 1);
    peers.push(value);
    return value;
  };
  const database = new URL(await freshDatabaseUrl());
  const observerUrl = database.href;
  const databaseAdmin = pool(observerUrl);
  const databaseName = identifier(decodeURIComponent(database.pathname.slice(1)));
  const provisioner = `s_${randomBytes(8).toString("hex")}`;
  await databaseAdmin.query(
    `create role ${provisioner} login createrole; alter database ${databaseName} owner to ${provisioner}`,
  );
  await databaseAdmin.query(
    `revoke connect on database ${identifier(new URL(core.url).pathname.slice(1))} from public`,
  );
  database.username = provisioner;
  database.password = "synthetic-storage-provisioner";
  const control = pool(database.href);
  const keys = testKeys();
  const reg = new Registry(control, database, new Sealer(keys));
  const bootstrapPath = join(root, "bootstrap.json");
  await writeFile(bootstrapPath, JSON.stringify(bootstrap(tableau.origin)));
  const start = async (storage: string | undefined) => {
    const runner = await runApi(
      load(
        {
          BOOTSTRAP: bootstrapPath,
          DATABASE_URL: core.url,
          DATABASE_CA_CERT: caCert(),
          SEALING_KEYS: sealingKeysEnv(keys),
          PORT: "0",
          STORAGE_DATABASE_URL: storage,
          ...(storage
            ? { STORAGE_DATABASE_CA_CERT: caCert(), STORAGE_WORKSPACE_CONNECTIONS: "2" }
            : {}),
        },
        new Log(() => {}),
      ),
    );
    runners.push(runner);
    return `http://127.0.0.1:${runner.port}`;
  };
  const signIn = async (userName: string) =>
    tableauSignIn(identity, tableau, {
      userName,
      userId: userName,
      siteContentUrl: "alpha",
      siteId: "site-a",
    });
  const ownerSignIn = await signIn("op@example.com");
  const op = await operatorSignIn(identity, ownerSignIn.cookie);
  const author = await appSignIn(identity, ownerSignIn.cookie, "same-app-id");
  const second = await appSignIn(
    identity,
    (await signIn("editor@example.com")).cookie,
    "same-app-id",
  );
  const reader = await appSignIn(
    identity,
    (await signIn("reader@example.com")).cookie,
    "reader-app",
  );
  const site = await core.db.selectFrom("trusted_sites").select("id").executeTakeFirstOrThrow();
  const request = async (
    origin: string,
    href: string,
    bearer?: string,
    method = "GET",
    body?: unknown,
    status = 200,
  ) => {
    const response = await fetch(`${origin}${href}`, {
      method,
      headers: {
        ...(bearer ? { "tableau-service-authorization": `Bearer ${bearer}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result).slice(0, 1000));
    return result;
  };
  const off = await start(undefined);
  const broken = await start(core.url);
  const first = await start(database.href);
  const app = (
    href: string,
    bearer = author.bearer,
    method = "GET",
    body?: unknown,
    status = 200,
  ) => request(first, href, bearer, method, body, status);
  await request(off, WORKSPACES, author.bearer, "GET", undefined, 404);
  await request(broken, WORKSPACES, author.bearer, "GET", undefined, 503);
  assert.equal((await request(broken, ADMIN, op.bearer)).state, "unavailable");
  assert.equal((await app(ADMIN, op.bearer)).state, "unavailable");
  await installStorage(control);
  await installStorage(control);
  const replica = await start(database.href);
  assert.equal((await app(ADMIN, op.bearer)).state, "available");
  assert.notEqual((await request(off, "/v1/definitions", author.bearer)).definitions, undefined);
  assert.notEqual((await request(broken, "/v1/definitions", author.bearer)).definitions, undefined);
  const discovery = await app("/v1/discovery");
  assert.equal(
    discovery.services.find(({ id }: { id: string }) => id === "storage").canCreate,
    false,
  );
  await app(`${ADMIN}/sites/${site.id}`, author.bearer, "PUT", { enabled: true }, 403);
  const offer = { label: "Purchasing", creationKey: "purchase" };
  await app(WORKSPACES, author.bearer, "POST", offer, 403);
  await app(`${ADMIN}/sites/${site.id}`, op.bearer, "PUT", { enabled: true });
  const creates = await Promise.all([
    app(WORKSPACES, author.bearer, "POST", offer),
    request(replica, WORKSPACES, author.bearer, "POST", offer),
  ]);
  const one = creates[0].workspace;
  const w = `${WORKSPACES}/${one.id}`;
  assert.equal(creates[1].workspace.id, one.id);
  await app(WORKSPACES, author.bearer, "POST", { ...offer, label: "Different" }, 409);
  assert.deepEqual((await app(WORKSPACES, second.bearer)).workspaces, []);
  await app(w, second.bearer, "GET", undefined, 404);
  const two = (
    await app(WORKSPACES, second.bearer, "POST", { label: "Inventory", creationKey: "inventory" })
  ).workspace;
  const peerHref = `${WORKSPACES}/${two.id}`;
  const sql = {
    id: "001",
    predecessor: 0,
    sql: `${migrationSql(one.roles.editor, one.roles.reader)}
    create function peer_probe() returns int language plpgsql stable as $$begin
      return (select count(*)::int from ${identifier(two.namespace)}.product); end$$;
    grant execute on function peer_probe() to ${one.roles.editor};`,
  };
  const migrated = await Promise.all([
    app(`${w}/migrations`, author.bearer, "POST", sql),
    request(replica, `${w}/migrations`, author.bearer, "POST", sql),
  ]);
  assert.deepEqual(
    migrated.map((result) => result.revision),
    [1, 1],
  );
  assert.equal(migrated.filter((result) => result.replayed).length, 1);
  await app(`${w}/migrations`, author.bearer, "POST", { ...sql, sql: `${sql.sql}\n-- other` }, 409);
  await app(
    `${w}/migrations`,
    author.bearer,
    "POST",
    { id: "bad", predecessor: 1, sql: "create table rolled_back (id int); commit;" },
    422,
  );
  await app(
    `${w}/migrations`,
    author.bearer,
    "POST",
    {
      id: "bad",
      predecessor: 1,
      sql: "create table rolled_back (id int); select * from nonexistent",
    },
    422,
  );
  const explored = await app(`${w}/query`, author.bearer, "POST", {
    sql: "select price from product where sku = $1",
    values: ["pencil"],
  });
  assert.deepEqual(explored.rows, [{ price: "123456789012345678.125000000001" }]);
  assert.equal(explored.visibility, "model-owner");
  await app(`${w}/query`, author.bearer, "POST", { sql: "select 1; select 2" }, 422);
  await app(
    `${w}/query`,
    author.bearer,
    "POST",
    { sql: "with x as (delete from product returning sku) select * from x" },
    422,
  );
  await app(`${peerHref}/migrations`, second.bearer, "POST", {
    id: "001",
    predecessor: 0,
    sql: "create table product(sku text primary key); insert into product values ('marker');",
  });
  const peer = await reg.find(second.principal, two.id);
  const main = await reg.find(author.principal, one.id);
  for (const role of ["model", "reader", "editor"] as const) {
    const real = pool(reg.roleUrl(main, role));
    assert.equal((await real.query("select session_user")).rows[0]?.session_user, main[role]);
    await assert.rejects(real.query(`select * from ${identifier(peer.namespace)}.product`), {
      code: "42501",
    });
    await assert.rejects(real.query("select * from storage_control.workspaces"), { code: "42501" });
    await assert.rejects(real.query(`set role ${identifier(peer[role])}`), { code: "42501" });
    const coreRole = new URL(reg.roleUrl(main, role));
    coreRole.pathname = new URL(core.url).pathname;
    await assert.rejects(pool(coreRole.href).query("select * from identities"), { code: "42501" });
  }
  const contract = await app(`${w}/schema`);
  assert.match(contract.sdl, /submitPurchase/);
  assert.ok(
    contract.model.columns.some(
      ({ object, column }: { object: string; column: string }) =>
        object === "product" && column === "price",
    ),
  );
  const recheck = async (
    query: string,
    variables?: Record<string, unknown>,
    bearer = author.bearer,
    path = w,
    origin = first,
  ) => request(origin, `${path}/graphql`, bearer, "POST", { query, variables });
  const peerProbe = await recheck("{ peerProbe }");
  assert.equal(peerProbe.errors?.[0]?.extensions?.sqlState, "42501");
  const product = await recheck(
    `{ allProducts(first:1) { nodes { sku price } pageInfo { endCursor } } }`,
  );
  assert.equal(product.data.allProducts.nodes[0].price, "123456789012345678.125000000001");
  assert.ok(product.data.allProducts.pageInfo.endCursor);
  assert.equal(
    (
      await recheck(
        `{ allProducts(first:1) { nodes { sku } } }`,
        undefined,
        second.bearer,
        peerHref,
      )
    ).data.allProducts.nodes[0].sku,
    "marker",
  );
  const createOne = await recheck(
    `mutation New($p:ProductInput!){createProduct(input:{product:$p}){product{sku price}}}`,
    { p: { sku: "pen", price: "3.21" } },
  );
  assert.equal(createOne.data.createProduct.product.sku, "pen");
  const updated = await recheck(
    `mutation Edit {updateProductBySku(input:{sku:"pen",productPatch:{price:"3.45"}}){product{price}}}`,
  );
  assert.equal(Number(updated.data.updateProductBySku.product.price), 3.45);
  const deleted = await recheck(
    `mutation Remove {deleteProductBySku(input:{sku:"pen"}){product{sku}}}`,
  );
  assert.equal(deleted.data.deleteProductBySku.product.sku, "pen");
  const submit = `mutation Submit($id:UUID!,$items:JSON!){submitPurchase(input:{purchaseId:$id,items:$items}){result{actor purchaseLinesByPurchaseId{nodes{lineNo productBySku{sku}}}}}}`;
  const purchase = randomUUID();
  const ending = await recheck(submit, {
    id: purchase,
    items: [
      { sku: "pencil", qty: 1 },
      { sku: "private-missing-key", qty: 1 },
    ],
  });
  assert.ok(ending.errors?.length, JSON.stringify(ending));
  assert.equal(JSON.stringify(ending).includes("private-missing-key"), false);
  assert.deepEqual(
    (await recheck("{ allPurchases { nodes { rowId } } }")).data.allPurchases.nodes,
    [],
  );
  const submitted = await recheck(submit, { id: purchase, items: [{ sku: "pencil", qty: 1 }] });
  assert.equal(submitted.data.submitPurchase.result.actor, author.principal.identityId);
  assert.equal(
    submitted.data.submitPurchase.result.purchaseLinesByPurchaseId.nodes[0].productBySku.sku,
    "pencil",
  );
  const targets = (await app(`${w}/identities?username=editor%40example.com`)).identities;
  assert.deepEqual(targets, [
    { identityId: second.principal.identityId, username: "editor@example.com" },
  ]);
  const grants = [{ identityId: second.principal.identityId, access: "edit" }];
  await app(`${w}/access`, author.bearer, "PUT", { version: 0, site: "read", grants });
  await app(`${w}/access`, author.bearer, "PUT", { version: 0, site: null, grants }, 409);
  assert.equal((await app(w, second.bearer)).workspace.access, "edit");
  assert.equal((await app(w, reader.bearer)).workspace.access, "read");
  const readerContract = await app(`${w}/schema`, reader.bearer);
  assert.equal(readerContract.model, undefined);
  assert.doesNotMatch(readerContract.sdl, /submitPurchase|createProduct/);
  assert.equal(
    (await recheck("{ readOnly }", undefined, reader.bearer)).data.readOnly,
    main.reader,
  );
  assert.ok(
    (await recheck(submit, { id: randomUUID(), items: [{ sku: "pencil", qty: 1 }] }, reader.bearer))
      .errors?.length,
  );
  assert.equal(
    (await recheck("{ localSetting }", undefined, reader.bearer)).data.localSetting,
    "00000000-0000-4000-8000-000000000099",
  );
  assert.equal(
    (await recheck("{ currentActor }", undefined, reader.bearer)).data.currentActor,
    reader.principal.identityId,
  );
  const save = `mutation Save($state:JSON!){saveView(input:{key:"main",value:$state}){result}}`;
  await recheck(save, { state: { number: "12345678901234567890.1" } });
  await recheck(save, { state: { number: 1.123 } }, second.bearer);
  const saved = "{ allSavedViews { nodes { state } } }";
  assert.deepEqual((await recheck(saved)).data.allSavedViews.nodes, [
    { state: { number: "12345678901234567890.1" } },
  ]);
  assert.deepEqual((await recheck(saved, undefined, second.bearer)).data.allSavedViews.nodes, [
    { state: { number: 1.123 } },
  ]);
  assert.deepEqual((await recheck(saved, undefined, reader.bearer)).data.allSavedViews.nodes, []);
  await app(
    `${w}/migrations`,
    second.bearer,
    "POST",
    { id: "002", predecessor: 1, sql: "select 1" },
    403,
  );
  const changed = {
    id: "002",
    predecessor: 1,
    sql:
      "alter table product add column description text; revoke select on product from " +
      one.roles.reader,
  };
  await app(`${w}/migrations`, author.bearer, "POST", changed);
  const newReader = await request(replica, `${w}/schema`, reader.bearer);
  assert.equal(newReader.revision, 2);
  assert.doesNotMatch(newReader.sdl, /allProducts/);
  await app(`${w}/access`, author.bearer, "PUT", { version: 1, site: null, grants: [] });
  await request(replica, w, reader.bearer, "GET", undefined, 404);
  await request(replica, w, second.bearer, "GET", undefined, 404);
  await app(`${ADMIN}/workspaces/${one.id}`, op.bearer, "PATCH", { state: "suspended" });
  await app(`${w}/schema`, author.bearer, "GET", undefined, 409);
  await app(`${ADMIN}/workspaces/${one.id}`, op.bearer, "PATCH", {
    state: "active",
    ownerId: second.principal.identityId,
  });
  await app(w, author.bearer, "GET", undefined, 404);
  assert.equal((await app(w, second.bearer)).workspace.access, "owner");
  await app(`${ADMIN}/sites/${site.id}`, op.bearer, "PUT", { enabled: false });
  await app(WORKSPACES, second.bearer, "POST", { label: "No", creationKey: "new" }, 403);
  assert.equal((await app(w, second.bearer)).workspace.revision, 2);

  const formerlyCached = await recheck(
    "{ allProducts { nodes { description } } }",
    undefined,
    second.bearer,
  );
  assert.ok(formerlyCached.data);
  const badModel = await app(`${w}/migrations`, second.bearer, "POST", {
    id: "003",
    predecessor: 2,
    sql: "comment on table purchase is '@name product'",
  });
  assert.equal(badModel.revision, 3);
  await request(replica, `${w}/schema`, second.bearer, "GET", undefined, 503);
  const physical = await request(replica, `${w}/schema?view=model`, second.bearer);
  assert.equal(physical.revision, 3);
  assert.ok(physical.model.columns.some(({ object }: { object: string }) => object === "purchase"));

  assert.deepEqual(
    (await app(`${w}/query`, second.bearer, "POST", { sql: "select sku from product" })).rows,
    [{ sku: "pencil" }],
  );
  const repair = await app(`${w}/migrations`, second.bearer, "POST", {
    id: "004",
    predecessor: 3,
    sql: `comment on table purchase is null; alter table product rename column description to note;
      create function purge_barrier() returns text language plpgsql stable as $$begin
        perform pg_advisory_xact_lock(28913071425::bigint); return current_user; end$$;
      grant execute on function purge_barrier() to ${one.roles.editor};`,
  });
  assert.equal(repair.revision, 4);
  assert.match((await request(replica, `${w}/schema`, second.bearer)).sdl, /note: String/);
  assert.ok(
    (await recheck("{ allProducts { nodes { description } } }", undefined, second.bearer)).errors
      ?.length,
  );

  const operatorWorkspace = `${ADMIN}/workspaces/${one.id}`;
  await app(operatorWorkspace, op.bearer, "DELETE", { confirm: one.id }, 409);
  await databaseAdmin.query(
    `create view storage_control.unexpected_dependency as select sku from ${identifier(main.namespace)}.product`,
  );
  const barrier = await databaseAdmin.connect();
  const observer = pool(observerUrl);
  try {
    await barrier.query("select pg_advisory_lock(28913071425::bigint)");
    const heldRead = recheck("{ purgeBarrier }", undefined, second.bearer, w, replica);
    void heldRead.catch(() => {});
    const until = async (query: string, values: string[]) => {
      const deadline = Date.now() + 2000;
      while (!(await observer.query<{ waiting: boolean }>(query, values)).rows[0]?.waiting) {
        if (Date.now() > deadline)
          assert.fail("Expected PostgreSQL advisory wait was not observed");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await until(
      "select exists(select from pg_stat_activity where usename=$1 and wait_event='advisory') as waiting",
      [main.editor],
    );
    await app(operatorWorkspace, op.bearer, "PATCH", { state: "retired" });
    await request(replica, `${w}/schema`, second.bearer, "GET", undefined, 404);
    const blockedPurge = app(operatorWorkspace, op.bearer, "DELETE", { confirm: one.id }, 409);
    void blockedPurge.catch(() => {});
    await until(
      "select exists(select from pg_stat_activity where usename=$1 and wait_event='advisory' and query like '%workspace_lock_key%') as waiting",
      [provisioner],
    );
    await barrier.query("select pg_advisory_unlock(28913071425::bigint)");
    assert.equal((await heldRead).data.purgeBarrier, main.editor);
    assert.equal((await blockedPurge).error.code, "storage-conflict");
  } finally {
    await barrier.query("select pg_advisory_unlock_all()");
    barrier.release();
  }
  assert.equal(
    (await databaseAdmin.query("select * from storage_control.unexpected_dependency")).rows[0]?.sku,
    "pencil",
  );
  await databaseAdmin.query("drop view storage_control.unexpected_dependency");
  const purged = (await app(operatorWorkspace, op.bearer, "DELETE", { confirm: one.id })).workspace;
  assert.ok(purged.purgedAt);
  assert.deepEqual(
    (await request(replica, operatorWorkspace, op.bearer, "DELETE", { confirm: one.id })).workspace,
    purged,
  );
  const {
    rows: [gone],
  } = await databaseAdmin.query(
    `select to_regnamespace($1) as namespace,
    (select count(*) from pg_roles where rolname=any($2::name[])) as roles`,
    [main.namespace, [main.model, main.reader, main.editor]],
  );
  assert.deepEqual(gone, { namespace: null, roles: "0" });
  assert.equal(
    (
      await recheck(
        `{ allProducts(first:1) { nodes { sku } } }`,
        undefined,
        second.bearer,
        peerHref,
      )
    ).data.allProducts.nodes[0].sku,
    "marker",
  );
});
