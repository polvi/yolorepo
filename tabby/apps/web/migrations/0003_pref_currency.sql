-- Per-user conversion display preference: the single currency shown next to
-- XMR amounts. TAB (whole-number display) is the neutral default.
ALTER TABLE users ADD COLUMN pref_currency TEXT NOT NULL DEFAULT 'TAB';
