# Seal group tracking

SEALv uses **tracked groups** as the operational term. A route is an inferred
link between anonymous group observations, not proof that the same individual
animals were present and not evidence of a genetically separate population.

## Source-informed defaults

- Automatic matching gate: **60 km/day**. Satellite telemetry of 75 Caspian
  seals reported individual mean daily movements from 7 to 58 km/day (overall
  mean 32.6 km/day), so 60 is the rounded top of the observed range.
- Maximum automatic gap: **14 days**. Documented autumn movements of roughly
  300–500 km commonly occurred over about two weeks; longer gaps should be
  reviewed rather than silently joined.
- Prediction: **7 days**, using observations from at most the latest **90
  days**. The current implementation is a deterministic recent-velocity
  baseline. It does not yet include ice, bathymetry or a fitted behavioural
  state-space model, so the map renders it as a dashed forecast.
- Hard route/geolocation deviation: **173 km/day**, corresponding to the
  telemetry study's 2 m/s location-filter threshold.
- Regional avoidance signal: modified z-score **≤ -3.5**, repeated on **two
  consecutive surveys**, compared with the same seasonal window (±30 days) in
  at least **five earlier years**. Density is effort-normalised; a sortie with
  no measured area is excluded rather than treated as zero use.

Primary sources:

- Dmitrieva et al. (2016), satellite telemetry and seasonal migration:
  <https://eprints.whiterose.ac.uk/id/eprint/101251/8/m554p241.pdf>
- NCOC/KAPE (2023), Caspian seal monitoring and multi-year survey design:
  <https://www.ncoc.kz/download/public/publications/ncoc/2023%20Survey%20of%20the%20Caspian%20Seal%20population%20as%20an%20endemic%20of%20the%20Caspian%20Sea%20fauna%20and%20indicator%20of%20the%20Caspian%20Sea%20ecosystem.pdf>
- NIST, modified z-score threshold for potential outliers:
  <https://itl.nist.gov/div898/handbook/eda/section3/eda35h.htm>

## Durable review

Computed snapshots are synced to `population` and `population_observation`.
Names therefore survive a recalculation even if the temporary algorithm track
number changes. `population_link_review` stores confirmed/rejected links.
Rejecting a link cuts the route at the later observation; confirming it pins
both observations to the same durable group. Split/merge events remain
explicit events rather than silently pretending one-to-one continuity.

An avoidance alert is only a prompt to inspect the region. Before attributing
it to disturbance, an analyst must check survey coverage, sea ice, weather,
neighbouring-region use and relevant human-activity layers.
