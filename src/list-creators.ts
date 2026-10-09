import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { niches_json: string };
type CreatorRow = { id: string; name: string; niches_json: string };
type LatestMetricRow = { creator_id: string; views: number };
type DeliveryCountRow = { creator_id: string; n: number };

function compareCreators(left: CreatorMatch, right: CreatorMatch): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(
    db,
    "SELECT niches_json FROM campaigns WHERE id = ?",
    input.campaignId,
  );
  if (!campaign) return null;

  const creators = await all<CreatorRow>(db, "SELECT id, name, niches_json FROM creators");
  const since = deliveriesSince();
  const scored: CreatorMatch[] = [];
  const campaignNiches = creators.length === 0 ? [] : (JSON.parse(campaign.niches_json) as string[]);

  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore === 0) continue;

    scored.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: 0,
      deliveries_90d: 0,
    });
  }

  const scoredById = new Map(scored.map((creator) => [creator.id, creator]));
  const eligibleCreatorIds = JSON.stringify(scored.map((creator) => creator.id));
  const latestMetrics = await all<LatestMetricRow>(
    db,
    `WITH ranked_metrics AS (
       SELECT
         a.creator_id,
         a.rowid AS account_order,
         m.views,
         ROW_NUMBER() OVER (
           PARTITION BY a.id
           ORDER BY m.captured_at DESC, m.id DESC
         ) AS rn
       FROM social_accounts a
       JOIN metrics m ON m.account_id = a.id
       WHERE a.creator_id IN (SELECT value FROM json_each(?))
     )
     SELECT creator_id, views
     FROM ranked_metrics
     WHERE rn = 1
     ORDER BY account_order`,
    eligibleCreatorIds,
  );
  for (const metric of latestMetrics) {
    const creator = scoredById.get(metric.creator_id);
    if (creator) creator.latest_reach += metric.views;
  }

  const deliveryCounts = await all<DeliveryCountRow>(
    db,
    `SELECT creator_id, COUNT(*) AS n
     FROM deliveries
     WHERE delivered_at >= ?
       AND creator_id IN (SELECT value FROM json_each(?))
     GROUP BY creator_id`,
    since,
    eligibleCreatorIds,
  );
  for (const count of deliveryCounts) {
    const creator = scoredById.get(count.creator_id);
    if (creator) creator.deliveries_90d = Number(count.n);
  }

  scored.sort(compareCreators);
  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: scored.slice(input.offset, input.offset + input.limit),
  };
}
