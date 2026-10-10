import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { all, getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { CAMPAIGN_ID, seed } from "../src/seed.ts";
import { listCreators } from "../src/list-creators.ts";
import { baselineListCreators } from "../test/baseline.ts";
import type { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";

type Options = {
  creators: number;
  limit: number;
  offset: number;
  blocks: number;
  samples: number;
  warmups: number;
  accounts: number;
  metrics: number;
  deliveries: number;
  niches: number;
};

function option(name: string, fallback: number): number {
  const argument = process.argv.find((value) => value.startsWith(`--${name}=`));
  const result = argument ? Number(argument.slice(name.length + 3)) : fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid --${name}`);
  return result;
}

const options: Options = {
  creators: option("creators", 2_000),
  limit: option("limit", 20),
  offset: option("offset", 0),
  blocks: option("blocks", 5),
  samples: option("samples", 100),
  warmups: option("warmups", 20),
  accounts: option("accounts", 0),
  metrics: option("metrics", 0),
  deliveries: option("deliveries", 0),
  niches: option("niches", 0),
};
if (options.creators < 1 || options.blocks < 1 || options.samples < 1 || options.limit < 1 || options.limit > 50) {
  throw new Error("creators, blocks and samples must be positive; limit must be between 1 and 50");
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function report(samples: number[]): { p50_ms: number; p95_ms: number } {
  return {
    p50_ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95_ms: Number(percentile(samples, 0.95).toFixed(3)),
  };
}

function bootstrapBlockInterval(values: number[]): [number, number] {
  let state = 9;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const medians: number[] = [];
  for (let sample = 0; sample < 10_000; sample += 1) {
    const resampled = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)] ?? 0);
    medians.push(percentile(resampled, 0.5));
  }
  return [Number(percentile(medians, 0.025).toFixed(3)), Number(percentile(medians, 0.975).toFixed(3))];
}

function database(withIndexes: boolean): DatabaseSync {
  const db = openDatabase();
  if (!withIndexes) {
    db.exec(`
      DROP INDEX social_accounts_by_creator;
      DROP INDEX metrics_latest_by_account;
      DROP INDEX deliveries_by_creator_date;
    `);
  }
  return db;
}

function addStressData(db: DatabaseSync): number {
  const started = performance.now();
  const creatorRows = db.prepare("SELECT id FROM creators ORDER BY id").all() as Array<{ id: string }>;
  const accountsByCreator = new Map<string, string[]>();
  const existingAccounts = db.prepare("SELECT id, creator_id FROM social_accounts ORDER BY rowid").all() as Array<{
    id: string;
    creator_id: string;
  }>;
  for (const account of existingAccounts) {
    const accounts = accountsByCreator.get(account.creator_id) ?? [];
    accounts.push(account.id);
    accountsByCreator.set(account.creator_id, accounts);
  }

  if (options.niches > 0) {
    const niches = JSON.stringify(Array.from({ length: options.niches }, (_, i) => `stress_niche_${i}`));
    db.prepare("UPDATE campaigns SET niches_json = ? WHERE id = ?").run(niches, CAMPAIGN_ID);
    db.prepare("UPDATE creators SET niches_json = ?").run(niches);
  }

  const insertAccount = db.prepare("INSERT INTO social_accounts (id, creator_id, platform) VALUES (?, ?, ?)");
  const insertMetric = db.prepare(
    "INSERT INTO metrics (id, account_id, views, captured_at, raw_payload) VALUES (?, ?, ?, ?, '')",
  );
  const insertDelivery = db.prepare(
    "INSERT INTO deliveries (id, creator_id, delivered_at) VALUES (?, ?, ?)",
  );
  const metricCounts = db.prepare("SELECT account_id, COUNT(*) AS n FROM metrics GROUP BY account_id").all() as Array<{
    account_id: string;
    n: number;
  }>;
  const metricsByAccount = new Map(metricCounts.map((row) => [row.account_id, Number(row.n)]));
  const deliveryCounts = db.prepare("SELECT creator_id, COUNT(*) AS n FROM deliveries GROUP BY creator_id").all() as Array<{
    creator_id: string;
    n: number;
  }>;
  const deliveriesByCreator = new Map(deliveryCounts.map((row) => [row.creator_id, Number(row.n)]));
  const asOf = Date.parse("2026-06-01T12:00:00.000Z");

  db.exec("BEGIN");
  try {
    for (const creator of creatorRows) {
      const accounts = accountsByCreator.get(creator.id) ?? [];
      for (let i = accounts.length; i < options.accounts; i += 1) {
        const accountId = `bench_acc_${creator.id}_${i}`;
        insertAccount.run(accountId, creator.id, "stress");
        accounts.push(accountId);
      }
      accountsByCreator.set(creator.id, accounts);

      for (const accountId of accounts) {
        const existing = metricsByAccount.get(accountId) ?? 0;
        for (let i = existing; i < options.metrics; i += 1) {
          const capturedAt = new Date(Date.UTC(2000, 0, 1) + i * 86_400_000).toISOString();
          insertMetric.run(`bench_met_${accountId}_${i}`, accountId, i + 1, capturedAt);
        }
      }

      const existingDeliveries = deliveriesByCreator.get(creator.id) ?? 0;
      for (let i = existingDeliveries; i < options.deliveries; i += 1) {
        const deliveredAt = new Date(asOf - (i % 89) * 86_400_000 - i).toISOString();
        insertDelivery.run(`bench_del_${creator.id}_${i}`, creator.id, deliveredAt);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return performance.now() - started;
}

function createVariant(withIndexes: boolean): { db: DatabaseSync; openMs: number; seedMs: number; stressMs: number } {
  const openStarted = performance.now();
  const db = database(withIndexes);
  const openMs = performance.now() - openStarted;
  const started = performance.now();
  seed(db, { creators: options.creators, seed: 7 });
  const seedMs = performance.now() - started;
  const stressMs = addStressData(db);
  return { db, openMs, seedMs, stressMs };
}

async function timed(
  db: DatabaseSync,
  list: typeof listCreators,
): Promise<{ ms: number; queries: number; responseBytes: number; page: Awaited<ReturnType<typeof listCreators>> }> {
  resetQueryCount();
  const started = performance.now();
  const page = await list(db, { campaignId: CAMPAIGN_ID, limit: options.limit, offset: options.offset });
  const ms = performance.now() - started;
  const queries = getQueryCount();
  if (queries !== 4) throw new Error(`Expected four instrumented queries, got ${queries}`);
  return { ms, queries, responseBytes: Buffer.byteLength(JSON.stringify(page)), page };
}

function profileResultMaterialization(db: DatabaseSync, list: typeof listCreators): Promise<Array<{
  query: string;
  rows: number;
  serialized_bytes: number;
}>> {
  const instrumentable = db as unknown as { prepare: (sql: string) => StatementSync };
  const originalPrepare = instrumentable.prepare.bind(db);
  const measured: Array<{ query: string; rows: number; serialized_bytes: number }> = [];
  instrumentable.prepare = (sql: string): StatementSync => {
    const statement = originalPrepare(sql);
    return new Proxy(statement, {
      get(target, property) {
        const member = Reflect.get(target, property, target) as unknown;
        if ((property === "all" || property === "get") && typeof member === "function") {
          return (...params: unknown[]) => {
            const result = Reflect.apply(member, target, params) as unknown;
            const rows = Array.isArray(result) ? result : result == null ? [] : [result];
            measured.push({
              query: sql.replace(/\s+/g, " ").trim().slice(0, 72),
              rows: rows.length,
              serialized_bytes: Buffer.byteLength(JSON.stringify(rows)),
            });
            return result;
          };
        }
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  };
  return list(db, { campaignId: CAMPAIGN_ID, limit: options.limit, offset: options.offset }).then(() => {
    instrumentable.prepare = originalPrepare;
    return measured;
  }, (error: unknown) => {
    instrumentable.prepare = originalPrepare;
    throw error;
  });
}

type ReadSample = { baseline: number[]; indexed: number[]; baselineQueries: number; indexedQueries: number; responseBytes: number };
const blocks: ReadSample[] = [];
const seedCosts: Array<{ baselineOpen: number; indexedOpen: number; baseline: number; indexed: number; stressBaseline: number; stressIndexed: number }> = [];
const writeSamples = {
  baseline: { insert: [] as number[], update: [] as number[], delete: [] as number[] },
  indexed: { insert: [] as number[], update: [] as number[], delete: [] as number[] },
};
let materializedRows: { baseline: Array<{ query: string; rows: number; serialized_bytes: number }>; indexed: Array<{ query: string; rows: number; serialized_bytes: number }> } | undefined;

const metadataDb = openDatabase();
console.log(JSON.stringify({ event: "start", node: process.version, sqlite: await all(metadataDb, "SELECT sqlite_version() AS version"), options }));
metadataDb.close();

for (let block = 0; block < options.blocks; block += 1) {
  const baseline = createVariant(false);
  const indexed = createVariant(true);
  seedCosts.push({
    baselineOpen: baseline.openMs,
    indexedOpen: indexed.openMs,
    baseline: baseline.seedMs,
    indexed: indexed.seedMs,
    stressBaseline: baseline.stressMs,
    stressIndexed: indexed.stressMs,
  });

  const baselineSamples: number[] = [];
  const indexedSamples: number[] = [];
  let baselineQueries = 0;
  let indexedQueries = 0;
  let responseBytes = 0;
  const calls = options.warmups + options.samples;
  for (let i = 0; i < calls; i += 1) {
    const baselineFirst = (i + block) % 2 === 0;
    const first = baselineFirst
      ? await timed(baseline.db, baselineListCreators)
      : await timed(indexed.db, listCreators);
    const second = baselineFirst
      ? await timed(indexed.db, listCreators)
      : await timed(baseline.db, baselineListCreators);
    const a = baselineFirst ? first : second;
    const b = baselineFirst ? second : first;
    assert.deepEqual(b.page, a.page, `response mismatch in block ${block}, sample ${i}`);
    assert.equal(b.responseBytes, a.responseBytes, `response size mismatch in block ${block}, sample ${i}`);
    baselineQueries = a.queries;
    indexedQueries = b.queries;
    responseBytes = a.responseBytes;
    if (i >= options.warmups) {
      baselineSamples.push(a.ms);
      indexedSamples.push(b.ms);
    }
  }

  blocks.push({ baseline: baselineSamples, indexed: indexedSamples, baselineQueries, indexedQueries, responseBytes });
  console.log(JSON.stringify({
    event: "read_block",
    block: block + 1,
    samples: options.samples,
    baseline: report(baselineSamples),
    indexed: report(indexedSamples),
    p50_ratio: Number((percentile(indexedSamples, 0.5) / percentile(baselineSamples, 0.5)).toFixed(3)),
    p95_ratio: Number((percentile(indexedSamples, 0.95) / percentile(baselineSamples, 0.95)).toFixed(3)),
    queries: { baseline: baselineQueries, indexed: indexedQueries },
    response_bytes: responseBytes,
    seed_ms: { baseline: Number(baseline.seedMs.toFixed(2)), indexed: Number(indexed.seedMs.toFixed(2)) },
    stress_setup_ms: { baseline: Number(baseline.stressMs.toFixed(2)), indexed: Number(indexed.stressMs.toFixed(2)) },
  }));

  const writeRounds = Math.min(options.samples, 100);
  const writeStatements = new Map([
    ["baseline", { db: baseline.db, accountId: "", insert: null as ReturnType<DatabaseSync["prepare"]> | null, update: null as ReturnType<DatabaseSync["prepare"]> | null, remove: null as ReturnType<DatabaseSync["prepare"]> | null }],
    ["indexed", { db: indexed.db, accountId: "", insert: null as ReturnType<DatabaseSync["prepare"]> | null, update: null as ReturnType<DatabaseSync["prepare"]> | null, remove: null as ReturnType<DatabaseSync["prepare"]> | null }],
  ]);
  for (const [variant, statements] of writeStatements) {
    statements.accountId = String(statements.db.prepare("SELECT id FROM social_accounts ORDER BY rowid LIMIT 1").get()?.id ?? "");
    statements.insert = statements.db.prepare("INSERT INTO metrics (id, account_id, views, captured_at, raw_payload) VALUES (?, ?, ?, ?, '')");
    statements.update = statements.db.prepare("UPDATE metrics SET views = views + 1, captured_at = ? WHERE id = ?");
    statements.remove = statements.db.prepare("DELETE FROM metrics WHERE id = ?");
  }
  for (let i = 0; i < writeRounds; i += 1) {
    const ordered = (i + block) % 2 === 0 ? ["baseline", "indexed"] as const : ["indexed", "baseline"] as const;
    for (const variant of ordered) {
      const statements = writeStatements.get(variant);
      if (!statements?.accountId || !statements.insert || !statements.update || !statements.remove) continue;
      const id = `bench_write_${block}_${i}`;
      const capturedAt = new Date(Date.UTC(2030, 0, 1) + block * 100_000 + i * 1000).toISOString();
      let started = performance.now();
      statements.db.exec("BEGIN"); statements.insert.run(id, statements.accountId, 1, capturedAt); statements.db.exec("COMMIT");
      writeSamples[variant].insert.push(performance.now() - started);
      started = performance.now();
      statements.db.exec("BEGIN"); statements.update.run(new Date(Date.UTC(2031, 0, 1) + i * 1000).toISOString(), id); statements.db.exec("COMMIT");
      writeSamples[variant].update.push(performance.now() - started);
      started = performance.now();
      statements.db.exec("BEGIN"); statements.remove.run(id); statements.db.exec("COMMIT");
      writeSamples[variant].delete.push(performance.now() - started);
    }
  }
  if (block === 0) {
    materializedRows = {
      baseline: await profileResultMaterialization(baseline.db, baselineListCreators),
      indexed: await profileResultMaterialization(indexed.db, listCreators),
    };
    assert.deepEqual(
      await baselineListCreators(baseline.db, { campaignId: CAMPAIGN_ID, limit: options.limit, offset: options.offset }),
      await listCreators(indexed.db, { campaignId: CAMPAIGN_ID, limit: options.limit, offset: options.offset }),
    );
  }
  console.log(JSON.stringify({ event: "metric_write_block", block: block + 1, operations_per_type: writeRounds,
    baseline: { insert: report(writeSamples.baseline.insert.slice(-writeRounds)), update: report(writeSamples.baseline.update.slice(-writeRounds)), delete: report(writeSamples.baseline.delete.slice(-writeRounds)) },
    indexed: { insert: report(writeSamples.indexed.insert.slice(-writeRounds)), update: report(writeSamples.indexed.update.slice(-writeRounds)), delete: report(writeSamples.indexed.delete.slice(-writeRounds)) },
  }));

  baseline.db.close();
  indexed.db.close();
}

const allBaseline = blocks.flatMap((block) => block.baseline);
const allIndexed = blocks.flatMap((block) => block.indexed);
const blockP50Ratios = blocks.map((block) => percentile(block.indexed, 0.5) / percentile(block.baseline, 0.5));
const blockP95Ratios = blocks.map((block) => percentile(block.indexed, 0.95) / percentile(block.baseline, 0.95));
const startupRatios = seedCosts.map((cost) => (cost.indexedOpen + cost.indexed) / (cost.baselineOpen + cost.baseline));
console.log(JSON.stringify({
  event: "read_summary",
  blocks: options.blocks,
  samples_per_block: options.samples,
  baseline: report(allBaseline),
  indexed: report(allIndexed),
  median_block_p50_ratio: Number(percentile(blockP50Ratios, 0.5).toFixed(3)),
  median_block_p95_ratio: Number(percentile(blockP95Ratios, 0.5).toFixed(3)),
  block_bootstrap_95_ci: { p50_ratio: bootstrapBlockInterval(blockP50Ratios), p95_ratio: bootstrapBlockInterval(blockP95Ratios) },
  seed_costs_ms: seedCosts.map((cost) => ({ baseline_open: Number(cost.baselineOpen.toFixed(2)), indexed_open: Number(cost.indexedOpen.toFixed(2)), baseline_seed: Number(cost.baseline.toFixed(2)), indexed_seed: Number(cost.indexed.toFixed(2)) })),
  metric_writes_ms: {
    baseline: { insert: report(writeSamples.baseline.insert), update: report(writeSamples.baseline.update), delete: report(writeSamples.baseline.delete) },
    indexed: { insert: report(writeSamples.indexed.insert), update: report(writeSamples.indexed.update), delete: report(writeSamples.indexed.delete) },
  },
  database_open_plus_seed_ms: {
    baseline_median: Number(percentile(seedCosts.map((cost) => cost.baselineOpen + cost.baseline), 0.5).toFixed(2)),
    indexed_median: Number(percentile(seedCosts.map((cost) => cost.indexedOpen + cost.indexed), 0.5).toFixed(2)),
    median_paired_ratio: Number(percentile(startupRatios, 0.5).toFixed(3)),
    paired_ratio_95_ci: bootstrapBlockInterval(startupRatios),
  },
  materialized_results: materializedRows,
  response_bytes: blocks[0]?.responseBytes,
  rss_mib: Number((process.memoryUsage().rss / 1_048_576).toFixed(1)),
}));
