import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deliveriesSince } from "../src/clock.ts";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { listCreators } from "../src/list-creators.ts";
import { CAMPAIGN_ID, seed } from "../src/seed.ts";
import { originalListCreators } from "./reference.ts";

const pages = [
  { limit: 20, offset: 0 },
  { limit: 1, offset: 0 },
  { limit: 50, offset: 13 },
  { limit: 20, offset: 100_000 },
];

function database(creators: number, seedValue: number, baseline = false): DatabaseSync {
  const db = openDatabase();
  if (baseline) {
    db.exec(`
      DROP INDEX social_accounts_by_creator;
      DROP INDEX metrics_latest_by_account;
      DROP INDEX deliveries_by_creator_date;
    `);
  }
  seed(db, { creators, seed: seedValue });
  db.exec(`
    INSERT INTO campaigns VALUES
      ('cmp_dup', 'Duplicated niches', '["beleza","beleza"]'),
      ('cmp_types', 'JSON types', '["tech",1,true,null,{"a":1},[1]]'),
      ('cmp_empty', 'No matches', '["absent"]');
  `);
  return db;
}

async function expectSame(
  baseline: DatabaseSync,
  candidate: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<void> {
  resetQueryCount();
  const expected = await originalListCreators(baseline, input);
  if (expected === null) expect(getQueryCount()).toBe(1);
  else expect(getQueryCount()).toBeGreaterThanOrEqual(2);

  resetQueryCount();
  expect(await listCreators(candidate, input)).toEqual(expected);
  expect(getQueryCount()).toBe(expected === null ? 1 : 4);
}

describe("equivalência da listagem indexada com a implementação original", () => {
  it.each([
    [0, 7],
    [1, 7],
    [80, 7],
    [300, 1],
    [300, 42],
  ])("preserva respostas com %i criadores e seed %i", async (creators, seedValue) => {
    const db = database(creators, seedValue, true);
    const candidate = database(creators, seedValue);
    for (const campaignId of [CAMPAIGN_ID, "cmp_dup", "cmp_types", "cmp_empty", "cmp_missing"]) {
      for (const page of pages) {
        resetQueryCount();
        const expected = await originalListCreators(db, { campaignId, ...page });
        if (expected === null) expect(getQueryCount()).toBe(1);
        else expect(getQueryCount()).toBeGreaterThanOrEqual(2);
        resetQueryCount();
        expect(await listCreators(candidate, { campaignId, ...page })).toEqual(expected);
        expect(getQueryCount()).toBe(expected === null ? 1 : 4);
      }
    }
    db.close();
    candidate.close();
  });

  it("preserva ordenação, empates, corte de 90 dias, contas vazias e soma ordenada", async () => {
    const baseline = database(0, 7, true);
    const candidate = database(0, 7);
    const edgeData = `
      INSERT INTO campaigns VALUES ('cmp_edges', 'Edge cases', '["tech","tech"]');
      INSERT INTO creators VALUES
        ('crt_b', 'Lower id loses only on id tie', '["tech"]', ''),
        ('crt_a', 'Lower id wins tie', '["tech"]', ''),
        ('crt_large', 'Ordered sum', '["tech","tech"]', ''),
        ('crt_no_account', 'No account', '["tech"]', ''),
        ('crt_no_metric', 'No metric', '["tech"]', '');
      INSERT INTO social_accounts VALUES
        ('acc_b', 'crt_b', 'instagram'),
        ('acc_a', 'crt_a', 'instagram'),
        ('acc_z', 'crt_large', 'instagram'),
        ('acc_a2', 'crt_large', 'tiktok'),
        ('acc_m', 'crt_large', 'youtube'),
        ('acc_no_metric', 'crt_no_metric', 'instagram');
      INSERT INTO metrics VALUES
        ('met_b', 'acc_b', 10, '2026-05-30T00:00:00.000Z', ''),
        ('met_a', 'acc_a', 10, '2026-05-30T00:00:00.000Z', ''),
        ('met_z_old', 'acc_z', 7, '2026-04-01T00:00:00.000Z', ''),
        ('met_z_new', 'acc_z', 10, '2026-05-30T00:00:00.000Z', ''),
        ('met_z_tie', 'acc_z', 9007199254740991, '2026-05-30T00:00:00.000Z', ''),
        ('met_a2', 'acc_a2', 2, '2026-05-30T00:00:00.000Z', ''),
        ('met_m', 'acc_m', 1, '2026-05-30T00:00:00.000Z', '');
      INSERT INTO deliveries VALUES
        ('del_limit', 'crt_large', '${deliveriesSince()}'),
        ('del_before', 'crt_large', '2026-03-03T11:59:59.999Z');
    `;
    baseline.exec(edgeData);
    candidate.exec(edgeData);
    const unicodeCreatorIds = ["\uE000", "\u{10000}"];
    for (const db of [baseline, candidate]) {
      const insertCreator = db.prepare("INSERT INTO creators VALUES (?, ?, '[\"tech\"]', '')");
      for (const id of unicodeCreatorIds) insertCreator.run(id, `Unicode ${id}`);
    }

    await expectSame(baseline, candidate, { campaignId: "cmp_edges", limit: 50, offset: 0 });
    const result = await listCreators(candidate, { campaignId: "cmp_edges", limit: 50, offset: 0 });
    expect(result?.creators.map((creator) => creator.id)).toEqual([
      "crt_large",
      "crt_a",
      "crt_b",
      "crt_no_account",
      "crt_no_metric",
      "\u{10000}",
      "\uE000",
    ]);
    expect(result?.creators.find((creator) => creator.id === "crt_large")?.latest_reach).toBe(
      9007199254740992,
    );
    expect(result?.creators.find((creator) => creator.id === "crt_large")?.deliveries_90d).toBe(1);
    baseline.close();
    candidate.close();
  });

  it("preserva o erro do driver para uma métrica inteira fora da faixa segura", async () => {
    const baseline = database(0, 7, true);
    const candidate = database(0, 7);
    for (const db of [baseline, candidate]) {
      db.exec(`
        INSERT INTO campaigns VALUES ('cmp_unsafe', 'Unsafe metric', '["tech"]');
        INSERT INTO creators VALUES ('crt_unsafe', 'Unsafe metric', '["tech"]', '');
        INSERT INTO social_accounts VALUES ('acc_unsafe', 'crt_unsafe', 'instagram');
        INSERT INTO metrics VALUES ('met_unsafe', 'acc_unsafe', 9007199254740993, '2026-05-30T00:00:00.000Z', '');
      `);
    }
    const input = { campaignId: "cmp_unsafe", limit: 20, offset: 0 };
    await expect(originalListCreators(baseline, input)).rejects.toMatchObject({ code: "ERR_OUT_OF_RANGE" });
    await expect(listCreators(candidate, input)).rejects.toMatchObject({ code: "ERR_OUT_OF_RANGE" });
    baseline.close();
    candidate.close();
  });

  it("cria os índices ao abrir um banco preexistente com dados", async () => {
    const directory = mkdtempSync(join(tmpdir(), "conty-index-migration-"));
    const path = join(directory, "legacy.db");
    const legacy = openDatabase(path);
    legacy.exec(`
      DROP INDEX social_accounts_by_creator;
      DROP INDEX metrics_latest_by_account;
      DROP INDEX deliveries_by_creator_date;
    `);
    seed(legacy, { creators: 80, seed: 7 });
    legacy.close();

    const baseline = database(80, 7, true);
    const migrated = openDatabase(path);
    try {
      await expectSame(baseline, migrated, { campaignId: CAMPAIGN_ID, limit: 20, offset: 0 });
      expect(
        migrated
          .prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'index' AND name LIKE '%_by_%'")
          .get()?.n,
      ).toBe(3);
    } finally {
      baseline.close();
      migrated.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("continua igual após cada alteração, movimentação, substituição e exclusão", async () => {
    const baseline = database(120, 3, true);
    const indexed = database(120, 3);
    const mutations = [
      "UPDATE metrics SET views = views + 1000000 WHERE id = 'met_acc_crt_0010_0_0'",
      "UPDATE metrics SET captured_at = '2030-01-01T00:00:00.000Z' WHERE id = 'met_acc_crt_0011_0_0'",
      "DELETE FROM metrics WHERE account_id = 'acc_crt_0012_0'",
      "UPDATE metrics SET account_id = 'acc_crt_0014_0' WHERE account_id = 'acc_crt_0013_0'",
      "UPDATE social_accounts SET creator_id = 'crt_0016' WHERE creator_id = 'crt_0015'",
      "DELETE FROM social_accounts WHERE creator_id = 'crt_0017'",
      "UPDATE creators SET niches_json = '[\"beleza\",\"moda\",\"beleza\"]' WHERE id = 'crt_0018'",
      "DELETE FROM creators WHERE id = 'crt_0020'",
      "INSERT OR REPLACE INTO creators VALUES ('crt_0021','Replacement','[\"moda\"]','')",
      "UPDATE creators SET id = 'crt_9999' WHERE id = 'crt_0024'",
      "INSERT INTO social_accounts VALUES ('acc_new','crt_0025','tiktok')",
      "INSERT INTO metrics VALUES ('met_new','acc_new',5,'2030-01-01T00:00:00.000Z','')",
      "DELETE FROM deliveries WHERE creator_id = 'crt_0026'",
    ];

    for (const sql of mutations) {
      baseline.exec(sql);
      indexed.exec(sql);
      for (const page of pages) {
        await expectSame(baseline, indexed, { campaignId: CAMPAIGN_ID, ...page });
      }
    }
    baseline.close();
    indexed.close();
  });
});
