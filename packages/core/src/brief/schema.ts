/** The `briefs` table of eido-data.db (#53): one stored brief per local date. */
export const BRIEF_SCHEMA_SQL = `
CREATE TABLE briefs (
  id TEXT PRIMARY KEY,
  for_date TEXT NOT NULL UNIQUE CHECK (for_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  generated_at TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  lines_json TEXT NOT NULL CHECK (json_valid(lines_json) AND json_type(lines_json) = 'array'),
  coverage_json TEXT NOT NULL CHECK (json_valid(coverage_json) AND json_type(coverage_json) = 'object')
);
`
