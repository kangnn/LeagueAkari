# Hextech integration

Design approved by the user on 2026-11-15. Design reference: LeagueAkari-海克斯集成设计.md in the task outputs.

1. Create the `hextech-integration` branch and install the locked upstream dependencies. Run the baseline checks before attributing failures to the integration.
2. Migrate the verified room-search policy and serialized search controller to TypeScript. Adapt authenticated LCU requests and existing events, preserving cancellation, population cooldown and invitation-limit behavior.
3. Register main/renderer shards, persistent settings, an independent sidebar route and a Naive UI page with localized controls and state/log reporting.
4. Implement local three-card recognition, champion-specific ratings via the champion-data service, and a transparent mouse-through window owned by WindowManager. Invalidate rerolls, late results and wrong-champion data.
5. Isolate the custom application identity/data/update channel. Verify tests, types, build, packaged launch and real recognition/overlay behavior. Record any missing real-game evidence explicitly.
6. Format touched files and retain reviewable commits on the feature branch. Do not change master or submit anything upstream without user authorization.
