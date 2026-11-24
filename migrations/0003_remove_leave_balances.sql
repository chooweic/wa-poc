-- Leave balances do not belong in this app: they are kept by the HR system,
-- which is out of scope. The mock target app now only knows who its users
-- are (by phone number) and records transactions. Where a transaction would
-- change a leave quota, it logs a SIMULATED call to the HR system instead.
ALTER TABLE mock_users DROP COLUMN sick_leave_balance;
ALTER TABLE mock_users DROP COLUMN off_day_balance;
ALTER TABLE mock_users DROP COLUMN unpaid_days_taken;
