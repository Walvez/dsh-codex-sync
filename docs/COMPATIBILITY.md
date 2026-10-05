# Verified DSH runtime compatibility

The PR #3 local follow-up was tested with the official npm/CLI
`@deepseek-ai/dsh@0.2.0-rc.2`, its `@deepseek-ai/dsh-session@0.2.0-rc.2`
and session-format catalog v4. Desktop version numbers are independent and
are not substitutes for npm package versions.

The optional MCP client peer admits `0.2.0-rc.2` explicitly, alongside the
existing `^0.0.1-rc.1` range. This does not claim compatibility with every
future 0.2 release or prove full MCP mirroring acceptance. Session import
requires the host's production migration/catalog packages; development-only
migration packages must not be installed into a production profile as a fix.

Use a profile dependency plus the bundle patch insert, as in
`examples/web-profile.cordis.patch.yml`. Do not also add the same bundle to
`dsh.profile.bundles`. Verify installation and actual activation without
`plugin allow-version`; a composed configuration alone is insufficient.
