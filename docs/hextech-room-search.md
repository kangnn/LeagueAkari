# Custom-room search

This branch adds a dedicated room-search sidebar page. The people-search icon is distinct from the ongoing-game icon. The page uses the existing client connection and does not duplicate its connection controls or include augment-rating settings.

The main shard reuses the authenticated LeagueClientMain HTTP instance and event subscriptions. It creates no new client connection, WebSocket or credential discovery. Search supports population/invitation cooldowns, event-triggered refresh, cancellation and preserving manually joined rooms. User-facing controls and logs use the existing locale resources.

This branch is independent of augment ratings and preserves upstream branding, profile paths and update behavior. It is kept separate for personal use. No upstream pull request is opened for it.

Behavioral search tests, type checks and a production build validate the port. The combined distribution also passed the original 29 performance scenarios through an adapter, recorded separately from the committed Vitest suite.

Standalone verification: production build passed. The complete suite passed 103 files / 606 tests with two workers. No updater or unrelated timing tests were changed.
