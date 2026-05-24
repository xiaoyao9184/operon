# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Validation

## [1.0.4] - 2026-05-24

### New
- Added optional icons to pipeline statuses, so each workflow state can be prepared with its own visual marker in the pipeline settings.
- Added a fallback icon source setting for task state icons, allowing tasks without a taskIcon to use pipeline status icons before falling back to Open, Finished, or Cancelled icons.
- Added optional icons to priorities and a Priority icons fallback source, so tasks without a taskIcon can use priority-specific visuals before falling back to state icons.
- Added a File Task Migration tool, so existing notes can be converted into Operon file tasks by folder, tag, or property match with a review preview, live conversion progress, stale-scan protection, and a confirmation step.

### Improved
- Improved File Task settings organization by separating Daily notes from Excluded folders, making the daily-note task toggle read as its own section.

### Fixed
- Fixed Calendar inline task creation requiring the Daily Notes core plugin, so users who save inline tasks to a Specific File can create calendar tasks even when Daily Notes is disabled.
- Fixed user-owned `Related` frontmatter being hidden or treated as an Operon key mapping by retiring the unused related task-field mapping.

### Validation
- Local validation passed `npm run check:local`, including strict linting, production build, release guard, and the full Phase 5 regression suite at 619/619 checks.

## [1.0.3] - 2026-05-23

### New
- Added a Links task field, picker, and optional chips for storing and reusing multiple external web links on inline and file tasks, supporting raw URLs and named Markdown links.
- Added manual Kanban ordering per preset, so cards can keep a drag-defined order inside each board cell while new cards append naturally and duplicated presets preserve their saved order.
- Added Daily ToDo and Last Seven Days Open as default saved filters for new Operon setups, giving first-time users useful task views immediately.
- Added an Operon demo workspace for new users, with a first-run prompt and Settings button that create the Basics project with benefit notes on each task, a command reference note, a realistic setup project, reusable filters, and initialized parent totals without overwriting user edits.

### Improved
- Improved Tasks emoji line conversion so priority emojis now map into the user's ordered Operon priorities instead of being preserved only as leftover notes.
- Improved Calendar time grid scale settings with smaller 0.25x and 0.50x options for denser timed planning views.
- Improved Date Picker and DateTime Picker suggestions with compact aligned rows, making quick dates easier to scan without clipped bottom entries.
- Improved task chip customization with optional start and end time chips that show only the clock icon and time.
- Improved Kanban boards with No swimlane selected by hiding the unused swimlane column, giving status columns more room.
- Improved Kanban preset sorting controls with clearer spacing before the appearance settings, making the preset editor easier to scan.

### Changed
- Daily Notes targets now follow the date format configured in Obsidian's Daily Notes core plugin, including custom Moment-style formats such as dotted dates, nested year/month folders, and weekday names.
- Task Editor date fields now use canonical date labels and compact time-only datetime labels while keeping field icons visible after selection.

### Fixed
- Fixed Calendar navigation date buttons showing today's date while another date is focused, so they now display the focused date while still jumping back to today when clicked.
- Fixed Task Chips settings jumping back to the top after toggling chip visibility or display controls.
- Fixed No swimlane Kanban boards hiding cards when an old hidden swimlane collapse state was still saved.
- Fixed Kanban inline task creation ignoring the configured inline task save location, so Kanban-created inline tasks now respect Specific File and Daily Notes modes.
- Fixed numeric settings inputs snapping back while editing, so values such as Kanban expanded column width can be deleted and retyped normally before saving.

### Validation
- Local maintainer validation passed `npm run check:local`, including strict linting, production build, release guard, and the full Phase 5 regression suite at 595/595 checks.

## [1.0.2] - 2026-05-20

### Fixed
- Restored compact inline chip sizing after the Obsidian CSS lint-safe reset changes and added release guard coverage for the lint-sensitive CSS patterns that caused the regression.

## [1.0.1] - 2026-05-20

### Fixed
- Cleaned Obsidian CSS lint warnings by replacing broad resets, text-decoration subproperties, multicolumn-triggering gap declarations, `display: contents`, duplicate declarations, and duplicate selectors with release-safe CSS.
- Normalized the `LICENSE` file to the standard GPLv3 text so GitHub can recognize the repository license while keeping project metadata on `GPL-3.0-or-later`.

## [1.0.0] - 2026-05-20

### Added
- Initial public release of Operon, a task management system for humans and agents in Obsidian.
- Added inline task and file task workflows with configurable fields, priorities, pipelines, filters, and task creation defaults.
- Added Task Creator and Task Editor flows for creating, editing, scheduling, linking, and organizing tasks.
- Added Calendar and Kanban views for planning tasks across time-based and workflow-based surfaces.
- Added pinned tasks, contextual task actions, Live Preview controls, Reading View controls, and compact task metadata displays.
- Added recurrence support for materialized recurring tasks, repeat-series state, and recurring file-task behavior.
- Added time tracking, FlowTime, status bar controls, and session history.
- Added optional external calendar source support with cached calendar rendering.

### Reliability
- Strengthened task write safety around dependency updates, parent-child task links, YAML/file-task preservation, indentation-preserving inline writes, and duplicate `operonId` conflicts.
- Improved `.operon` persistence durability with malformed store recovery, safer queued writes, unload flushing, repeat-series serialization, and external calendar cache guards.
- Hardened Calendar, Kanban, Live Preview, and Reading View surfaces against stale callbacks, orphan floating panels, preview cleanup leaks, empty preset recovery, and compact layout clipping.
- Reworked settings organization into a primary tab and subtab structure with Obsidian-native controls, accessible card shells, and release-ready settings navigation.
- Added a final settings accessibility cleanup for tab keyboard semantics, Workflow editor control names, and Kanban sort-rule controls.
- Expanded i18n and release hygiene checks for command labels, Kanban labels, time history labels, locale parity, package metadata, release assets, and acceptance docs.

### Compatibility and optional integrations
- Requires Obsidian 1.7.2 or newer.
- Uses Obsidian Daily Notes configuration for Calendar inline task insertion and Daily Note parent workflows when enabled.
- Uses Obsidian's hover-link/Page Preview event flow for modifier-hover task and chip previews.
- Optionally integrates with Templater when file task or Daily Notes templates contain Templater syntax.
- Optionally uses Natural Language Dates (`nldates-obsidian`) for date picker parsing, with built-in fallback parsing when unavailable.
- Supports external calendar sources through ICS parsing via `ical.js`.

### Release validation
- Public validation passes with ESLint at 0 warnings and 0 errors.
- `npm run check:local` passes locally, including strict linting, production build, release guard, and Phase 5 regression validation.
- Local maintainer regression validation passes Phase 5 at 567/567.
- Release guard validates package, manifest, lockfile, release assets, acceptance docs, and audited raw-string surfaces.
- `npm audit` reports 0 vulnerabilities.
- `node --check main.js` passes for the generated runtime.
- Added `versions.json`, CI, CodeQL, and semver-tag release automation for community plugin submission.

### Notes
- This is Operon's first public release history entry.
- Earlier internal development history is intentionally not included in the public changelog.
- Community plugin release assets are limited to `main.js`, `manifest.json`, and `styles.css`.
