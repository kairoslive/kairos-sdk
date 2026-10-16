import { test } from "node:test";
import assert from "node:assert/strict";

import { createKairos } from "../src/index.ts";

const closed = (id: string) => ({ market_id: id, token_id: `t${id}`, outcome: "Yes", size: "0", realized_pnl: "-0.5", status: "CLOSED" });

test("positions maps options to the API's query names", async () => {
  const urls: string[] = [];
  const kairos = createKairos({
    dataUrl: "https://data.test/",
    fetch: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ open_positions: [], closed_positions: [], has_more: false }));
    },
  });
  await kairos.traders.positions("0xabc", { status: "closed", includeRedeemable: true, limit: 5 });
  assert.equal(urls[0], "https://data.test/trader-stats/positions/0xabc?status=closed&include_redeemable=true&limit=5");
});

test("closedPositions pages until has_more is false", async () => {
  const urls: string[] = [];
  const kairos = createKairos({
    fetch: async (url) => {
      urls.push(url);
      const first = url.includes("offset=0");
      return new Response(
        JSON.stringify({ open_positions: [], closed_positions: first ? [closed("1"), closed("2")] : [closed("3")], has_more: first }),
      );
    },
  });
  const ids: string[] = [];
  for await (const p of kairos.traders.closedPositions("0xabc", { pageSize: 2 })) ids.push(p.market_id);
  assert.deepEqual(ids, ["1", "2", "3"]);
  assert.equal(urls[0], "https://data.kairos.trade/trader-stats/positions/0xabc?status=closed&limit=2&offset=0");
  assert.equal(urls.length, 2);
});
