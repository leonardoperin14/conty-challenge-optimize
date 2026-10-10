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
type LatestMetricRow = { creator_id: string; views: number | null };
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
    `SELECT a.creator_id,
       (
         SELECT latest.views
         FROM metrics AS latest
         WHERE latest.account_id = a.id
         ORDER BY latest.captured_at DESC, latest.id DESC
         LIMIT 1
       ) AS views
     FROM social_accounts AS a
     WHERE a.creator_id IN (SELECT value FROM json_each(?))
     -- For each creator, this retains the original account insertion order.
     ORDER BY a.creator_id, a.rowid`,
    eligibleCreatorIds,
  );
  for (const metric of latestMetrics) {
    const creator = scoredById.get(metric.creator_id);
    if (creator && metric.views !== null) creator.latest_reach += metric.views;
  }

  scored.sort(compareCreators);
  const page = scored.slice(input.offset, input.offset + input.limit);
  const pageCreatorIds = JSON.stringify(page.map((creator) => creator.id));
  const deliveryCounts = await all<DeliveryCountRow>(
    db,
    `SELECT creator_id, COUNT(*) AS n
     FROM deliveries
     WHERE delivered_at >= ?
       AND creator_id IN (SELECT value FROM json_each(?))
     GROUP BY creator_id`,
    since,
    pageCreatorIds,
  );
  for (const count of deliveryCounts) {
    const creator = scoredById.get(count.creator_id);
    if (creator) creator.deliveries_90d = Number(count.n);
  }

  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: page,
  };
}
