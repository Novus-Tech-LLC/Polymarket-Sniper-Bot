# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **CLOB Authentication**: Downgraded `@polymarket/clob-client` from `^5.2.1` to `4.22.8` to resolve 401 Unauthorized/Invalid API key errors
  - **Issue**: Recent v5.x versions have known authentication and packaging issues
  - **Solution**: v4.22.8 is the stable, recommended version that resolves auth failures
  - **References**:
    - [GitHub Issue #175](https://github.com/Polymarket/py-clob-client/issues/175) - Invalid API key errors in v5.x
    - [GitHub Issue #248](https://github.com/Polymarket/clob-client/issues/248) - POLY_ADDRESS header bug in v5.x
    - [Stack Overflow Discussion](https://stackoverflow.com/questions/79845282/typescript-says-module-not-found-for-polymarket-clob-client-even-though-it-is-i) - v5.x packaging issues
  - Removed obsolete patch file `patches/@polymarket+clob-client+5.2.1.patch` (no longer needed with v4.22.8)

### Changed

- Pinned `@polymarket/clob-client` to exact version `4.22.8` (removed caret `^` to prevent auto-upgrade to problematic v5.x versions)
