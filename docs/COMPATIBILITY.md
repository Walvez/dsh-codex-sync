# Verified DSH runtime compatibility

The PR #3 local follow-up was tested with the official npm/CLI
`@deepseek-ai/dsh@0.2.0-rc.2`, its `@deepseek-ai/dsh-session@0.2.0-rc.2`
and session-format catalog v4. Desktop version numbers are independent and
are not substitutes for npm package versions.

Host admission now uses `engines.dsh: ^0.0.1-rc.1 || >=0.2.0-rc.2 <0.3.0-0`,
retaining the legacy declaration while admitting later 0.2 patch and prerelease
versions, including `0.2.1-rc.3`. DSH matches this range with
`includePrerelease: true`; the `-0` upper bound also excludes **0.3 prereleases**.
This is a bounded candidate family, not certification of every future release.
No version exemption or exact RC comparison is used at runtime.

The optional native MCP peer likewise uses bounded ranges; a 0.2.1 lower tuple
is retained because npm's own peer matcher does not enable `includePrerelease`.
Host admission is explicitly separate from that npm peer hint: DSH gives
`engines.dsh` precedence rather than treating every SDK peer as a core-version
pin. A new patch-level SDK prerelease may still need a peer-hint update for
standalone npm installations, but cannot by itself block Host Loader admission.

Isolated real SkillRegistry fixtures cover `0.2.1-rc.2` and `0.2.1-rc.3`.
Native MCP protocol/lifecycle fixtures cover `0.2.0-rc.2`, `0.2.1-rc.2` and
`0.2.1-rc.3`. Native config-field checks and independently owned Skills
registration provide a fail-closed boundary when an admitted runtime changes
an interface. See [LIVE-SYNC.md](LIVE-SYNC.md) for exact scope and reproducible
commands. These checks do not prove full Desktop GUI acceptance or every
historical/future implementation's semantics.

Session import requires the host's production migration/catalog packages;
development-only migration packages must not be installed into a production
profile as a fix.

Use a profile dependency plus the bundle patch insert, as in
`examples/web-profile.cordis.patch.yml`. Do not also add the same bundle to
`dsh.profile.bundles`. Verify installation and actual activation without
`plugin allow-version`; a composed configuration alone is insufficient.

Node 20 requires the `zstd` executable for checksummed compression; newer Node runtimes with native Zstandard use the native API. The repair CLI already requires `zstd` for decompression. CI checks both compression paths.
