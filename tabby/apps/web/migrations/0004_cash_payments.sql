-- Cash settlements: a payment is either an XMR transfer or cash handed over
-- in person ("they gave me $300"). Cash rows keep the NOT NULL XMR columns at
-- 0 and record the original fiat amount verbatim (currency + amount_minor,
-- converted to µTAB server-side at record time, like expenses). The ledger
-- only ever reads amount_tab_micro, so both methods settle identically.
ALTER TABLE payments ADD COLUMN method TEXT NOT NULL DEFAULT 'xmr'
  CHECK (method IN ('xmr', 'cash'));
ALTER TABLE payments ADD COLUMN currency TEXT
  CHECK (currency IN ('USD', 'CAD', 'TAB'));
ALTER TABLE payments ADD COLUMN amount_minor INTEGER
  CHECK (amount_minor > 0);
