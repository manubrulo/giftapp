# Changelog

Notable changes to GiftApp are recorded here for each release.

## 0.3.1 (Unreleased)

### Added

- Wishes can have multiple labels. Existing labels are suggested as you type, new labels can be created inline, and each label has a consistent color.
- Profile avatars now offer 16 emoji choices.
- SQLite schema revisions and ordered startup migrations. Existing databases are adopted and upgraded automatically before the server accepts requests.
- Human-readable, single-line logs by default, with `LOG_FORMAT=json` available for machine-readable output.

### Changed

- Labels are stored in lowercase, and existing categories are migrated into labels.
- Manual price entry defaults to euros and no longer requires a currency field. Currency detected from product links is preserved.
- Log verbosity is configurable with `LOG_LEVEL`; credentials and request query strings are omitted from request logs.
