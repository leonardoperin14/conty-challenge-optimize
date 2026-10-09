import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { CAMPAIGN_ID, FIXTURE_SEED, seed } from "../src/seed.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/page-1.json", import.meta.url), "utf8"),
) as unknown;

function setup() {
  const db = openDatabase(":memory:");
  seed(db, FIXTURE_SEED);
  resetQueryCount();
  return createApp(db);
}

describe("descoberta de criadores", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = setup();
  });

  it("devolve a primeira página combinada com a campanha", async () => {
    const res = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=0`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(fixture);
  });

  it("executa quatro consultas para a página de 20", async () => {
    resetQueryCount();
    const res = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=0`);
    expect(res.status).toBe(200);
    expect(getQueryCount()).toBe(4);
  });

  it("responde 404 quando a campanha não existe", async () => {
    resetQueryCount();
    const res = await app.request("/campaigns/cmp_missing/creators");
    expect(res.status).toBe(404);
    expect(getQueryCount()).toBe(1);
  });

  it("mantém o teto de queries com 600 criadores", async () => {
    const db = openDatabase(":memory:");
    seed(db, { creators: 600, seed: 7 });
    const big = createApp(db);
    resetQueryCount();
    const res = await big.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=0`);
    expect(res.status).toBe(200);
    expect(getQueryCount()).toBe(4);
  });
});

type Page = {
  total: number;
  creators: Array<{ id: string; niche_score: number; latest_reach: number; deliveries_90d: number }>;
};

describe("casos de borda da listagem", () => {
  function edgeApp() {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_edge', 'Borda', '["beleza","moda"]');
      INSERT INTO creators VALUES
        ('crt_a', 'Empate', '["beleza"]', ''),
        ('crt_b', 'Sem conta', '["beleza"]', ''),
        ('crt_c', 'Conta sem métrica', '["beleza"]', ''),
        ('crt_d', 'Entrega no limite', '["moda"]', ''),
        ('crt_e', 'Fora do nicho', '["games"]', '');
      INSERT INTO social_accounts VALUES
        ('acc_a', 'crt_a', 'instagram'),
        ('acc_c', 'crt_c', 'instagram'),
        ('acc_e', 'crt_e', 'instagram');
      INSERT INTO metrics VALUES
        ('met_a1', 'acc_a', 10, '2026-05-30T00:00:00.000Z', ''),
        ('met_a2', 'acc_a', 99, '2026-05-30T00:00:00.000Z', ''),
        ('met_a0', 'acc_a', 500, '2026-05-01T00:00:00.000Z', ''),
        ('met_e1', 'acc_e', 777, '2026-05-30T00:00:00.000Z', '');
      INSERT INTO deliveries VALUES
        ('del_d1', 'crt_d', '2026-03-03T12:00:00.000Z'),
        ('del_d2', 'crt_d', '2026-03-03T11:59:59.999Z');
    `);
    return createApp(db);
  }

  async function page(app: ReturnType<typeof createApp>, query = ""): Promise<Page> {
    const res = await app.request(`/campaigns/cmp_edge/creators${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Page;
  }

  it("desempata a métrica mais recente pelo id decrescente", async () => {
    const result = await page(edgeApp());
    expect(result.creators.find((creator) => creator.id === "crt_a")?.latest_reach).toBe(99);
  });

  it("lista quem não tem conta ou métrica com alcance zero e deixa de fora score zero", async () => {
    const result = await page(edgeApp());
    expect(result.creators.map((creator) => creator.id)).toEqual(["crt_a", "crt_b", "crt_c", "crt_d"]);
    expect(result.creators.find((creator) => creator.id === "crt_b")?.latest_reach).toBe(0);
    expect(result.creators.find((creator) => creator.id === "crt_c")?.latest_reach).toBe(0);
  });

  it("conta a entrega exatamente no limite dos 90 dias e não a de 1 ms antes", async () => {
    const result = await page(edgeApp());
    expect(result.creators.find((creator) => creator.id === "crt_d")?.deliveries_90d).toBe(1);
  });

  it("mantém o total quando o offset passa do fim", async () => {
    const result = await page(edgeApp(), "?limit=20&offset=50");
    expect(result.creators).toEqual([]);
    expect(result.total).toBe(4);
  });
});

describe("agrega dados sem alterar a classificação", () => {
  async function getPage(app: ReturnType<typeof createApp>, campaignId: string): Promise<Page> {
    const res = await app.request(`/campaigns/${campaignId}/creators`);
    expect(res.status).toBe(200);
    return (await res.json()) as Page;
  }

  it("conta cada par de nichos iguais, inclusive os repetidos", async () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_repeat', 'Repetidos', '["tech","tech"]');
      INSERT INTO creators VALUES ('crt_repeat', 'Repetidos', '["tech","tech"]', '');
    `);

    const result = await getPage(createApp(db), "cmp_repeat");
    expect(result.creators[0]?.niche_score).toBe(4);
  });

  it("soma o alcance de duas contas sem limitar o resultado a inteiro seguro", async () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_large', 'Alcance', '["tech"]');
      INSERT INTO creators VALUES ('crt_large', 'Alcance', '["tech"]', '');
      INSERT INTO social_accounts VALUES
        ('acc_large_1', 'crt_large', 'instagram'),
        ('acc_large_2', 'crt_large', 'tiktok');
      INSERT INTO metrics VALUES
        ('met_large_1', 'acc_large_1', 9000000000000000, '2026-05-30T00:00:00.000Z', ''),
        ('met_large_2', 'acc_large_2', 9000000000000000, '2026-05-30T00:00:00.000Z', '');
    `);

    const result = await getPage(createApp(db), "cmp_large");
    expect(result.creators[0]?.latest_reach).toBe(18000000000000000);
  });

  it("soma métricas pela ordem de inserção das contas e usa só a última de cada conta", async () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_order', 'Ordem', '["tech"]');
      INSERT INTO creators VALUES ('crt_order', 'Ordem', '["tech"]', '');
      INSERT INTO social_accounts VALUES
        ('acc_z', 'crt_order', 'instagram'),
        ('acc_a', 'crt_order', 'tiktok'),
        ('acc_m', 'crt_order', 'youtube');
      INSERT INTO metrics VALUES
        ('met_z_old', 'acc_z', 100, '2026-05-01T00:00:00.000Z', ''),
        ('met_z_new', 'acc_z', 9007199254740991, '2026-05-30T00:00:00.000Z', ''),
        ('met_a_old', 'acc_a', 200, '2026-05-01T00:00:00.000Z', ''),
        ('met_a_new', 'acc_a', 2, '2026-05-30T00:00:00.000Z', ''),
        ('met_m_old', 'acc_m', 300, '2026-05-01T00:00:00.000Z', ''),
        ('met_m_new', 'acc_m', 1, '2026-05-30T00:00:00.000Z', '');
    `);

    const result = await getPage(createApp(db), "cmp_order");
    expect(result.creators[0]?.latest_reach).toBe(9007199254740992);
  });

  it("não lê métricas de criadores fora dos nichos da campanha", async () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_eligible', 'Elegível', '["tech"]');
      INSERT INTO creators VALUES
        ('crt_eligible', 'Elegível', '["tech"]', ''),
        ('crt_ineligible', 'Inelegível', '["games"]', '');
      INSERT INTO social_accounts VALUES
        ('acc_eligible', 'crt_eligible', 'instagram'),
        ('acc_ineligible', 'crt_ineligible', 'instagram');
      INSERT INTO metrics VALUES
        ('met_eligible', 'acc_eligible', 7, '2026-05-30T00:00:00.000Z', ''),
        ('met_ineligible', 'acc_ineligible', 9007199254740993, '2026-05-30T00:00:00.000Z', '');
    `);

    const result = await getPage(createApp(db), "cmp_eligible");
    expect(result.creators.map((creator) => creator.id)).toEqual(["crt_eligible"]);
    expect(result.creators[0]?.latest_reach).toBe(7);
  });

  it("faz quatro consultas inclusive quando não há criadores compatíveis", async () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_empty', 'Sem matches', '["tech"]');
      INSERT INTO creators VALUES ('crt_unmatched', 'Sem match', '["games"]', '');
    `);
    const app = createApp(db);

    for (let call = 0; call < 2; call += 1) {
      resetQueryCount();
      const result = await getPage(app, "cmp_empty");
      expect(result).toEqual({ campaign_id: "cmp_empty", total: 0, creators: [] });
      expect(getQueryCount()).toBe(4);
    }
  });
});
