// Runs supabase/*.sql in PGlite (real Postgres in-process) with a stand-in
// for Supabase's auth schema, then checks who can see and change what.
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
let db: PGlite;

/** Run as a signed-in user (or anon), the way PostgREST does. */
async function as<T>(user: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user ?? ""]);
  await db.exec(user ? "set role authenticated" : "set role anon");
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    insert into auth.users values ('${A}', 'a@x'), ('${B}', 'b@x');
  `);
  const files = readdirSync("supabase").filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    const sql = readFileSync(`supabase/${f}`, "utf8");
    await db.exec(sql);
    await db.exec(sql); // must be safe to run twice
  }
});

describe("fretline tables", () => {
  it("you can save and read your own lesson, fixes and settings", async () => {
    await as(A, `insert into fretline_lessons (video_id, title, position_sec) values ('ZeeuvgrDUeQ', 'Neon', 61.5)`);
    await as(A, `insert into fretline_tab_fixes (video_id, fixes) values ('ZeeuvgrDUeQ', '{"edits":{}}')`);
    await as(A, `insert into fretline_settings (data) values ('{"custom":[]}')`);
    const rows = await as<{ title: string; user_id: string }>(A, `select title, user_id from fretline_lessons`);
    expect(rows).toEqual([{ title: "Neon", user_id: A }]);
    await as(A, `update fretline_lessons set position_sec = 90 where video_id = 'ZeeuvgrDUeQ'`);
    expect((await as<{ position_sec: number }>(A, `select position_sec from fretline_lessons`))[0].position_sec).toBe(90);
  });

  it("someone else sees and changes nothing of yours", async () => {
    expect(await as(B, `select * from fretline_lessons`)).toEqual([]);
    expect(await as(B, `select * from fretline_tab_fixes`)).toEqual([]);
    expect(await as(B, `select * from fretline_settings`)).toEqual([]);
    await as(B, `update fretline_lessons set title = 'hacked'`);
    await as(B, `delete from fretline_tab_fixes`);
    expect((await as<{ title: string }>(A, `select title from fretline_lessons`))[0].title).toBe("Neon");
    expect((await as(A, `select * from fretline_tab_fixes`)).length).toBe(1);
  });

  it("you can't write rows as someone else", async () => {
    await expect(as(B, `insert into fretline_lessons (user_id, video_id) values ('${A}', 'x1')`)).rejects.toThrow(/row-level security/);
    await expect(as(B, `update fretline_settings set user_id = '${A}'`)).resolves.toEqual([]);
  });

  it("signed-out visitors get nothing", async () => {
    await expect(as(null, `select * from fretline_lessons`)).rejects.toThrow(/permission denied/);
    await expect(as(null, `insert into fretline_settings (user_id) values ('${A}')`)).rejects.toThrow(/permission denied/);
  });

  it("upsert works (how the app saves)", async () => {
    await as(B, `insert into fretline_lessons (video_id, title) values ('v2', 'One')`);
    await as(
      B,
      `insert into fretline_lessons (video_id, title) values ('v2', 'Two')
       on conflict (user_id, video_id) do update set title = excluded.title`,
    );
    expect(await as(B, `select title from fretline_lessons`)).toEqual([{ title: "Two" }]);
  });
});
