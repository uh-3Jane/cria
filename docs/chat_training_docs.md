# DefiLlama Docs — Training Notes (for Chatbot)

Source snapshots used:
- https://docs.llama.fi/faqs/frequently-asked-questions
- https://docs.llama.fi/pricing

## Core FAQ Facts (From Docs)

- DefiLlama is an open-source DeFi TVL aggregator maintained by contributors.
- TVL is the value of assets deposited into protocols to earn rewards or interest.
- TVL data comes from open-source adapters, using on-chain calls or subgraphs/APIs.
- Update cadence:
  - TVL, total borrows, treasury, stablecoin supply, CEX assets, oracle TVS: hourly.
  - DEX volume, fees, revenue, earnings: mostly hourly, some daily at 00:00 UTC.
  - Yields data: hourly.
  - Bridge data: hourly.
- If API and website disagree, caching is a common cause; the website can lag up to about an hour.
- Pool2 TVL: farms requiring exposure to a protocol’s own token for incentives/liquidity.
- Staking TVL: governance-token staking contracts separated from core protocol TVL.
- Chain staking is excluded from chain TVL; liquid staking protocols are tracked but not counted by default.
- Doublecount toggle controls whether receipt/LP tokens deposited elsewhere are also counted.
- Borrows metric is for lending protocols (amount borrowed through the platform).
- Treasury TVL excludes the protocol’s own token.
- CEX assets exclude external custodians to avoid misleading trust implications.
- Options volumes are ranked by premium (notional can be inflated by wash trading).
- CSV downloads are available on protocol/chain/overview pages.

## Pricing / Plan Basics (From Docs)

- Open (Free): general API data; community support via email + Discord.
- Pro: LlamaAI, dashboards, CSV downloads, custom columns, Google Sheets integration.
- API: higher limits, additional endpoints, priority support.
- Enterprise: custom data, raw DB access, hourly data, non-public breakdowns.

## Notes for Chatbot Behavior

- If asked “how often does data update,” answer hourly, and clarify that some fees/volume endpoints are daily at 00:00 UTC.
- If asked why API vs site differ, mention caching and up to ~1 hour delay.
- If asked about Pool2 or Staking TVL, use the definitions above.
- If asked about chain staking, explain it’s excluded from chain TVL by default.
- If asked about plan tiers or Sheets integration, reflect the pricing doc categories above.

